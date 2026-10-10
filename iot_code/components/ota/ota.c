/**
 * @file ota.c
 *
 * @brief HTTPS OTA firmware update.
 *
 * Architecture:
 *   - ota_task_start() creates a queue (depth=1) and spawns ota_task_fn.
 *   - ota_trigger() validates the URL and sends {url, sha256} to the queue.
 *   - ota_task_fn blocks on the queue, downloads the firmware via esp_https_ota,
 *     publishes progress every 10% to device/{id}/ota/progress, then reboots.
 *   - ota_validate_and_commit() marks the new firmware valid after the system
 *     proves it works and satisfies SEC-03 rollback.
 *
 * Copyright (C) 2026 MinhNhat & BaoViet
 */

#include "ota.h"

#include "config.h"
#include "display_service.h"
#include "esp_crt_bundle.h"
#include "esp_https_ota.h"
#include "esp_log.h"
#include "esp_ota_ops.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"

#include <stdbool.h>
#include <string.h>
#include <strings.h>

/* Forward declaration resolved at link time from sa_mqtt (no CMake dependency). */
extern int mqtt_publish(const char *topic, const char *payload, int qos, bool retain);

static const char *TAG = "ota";

/* Driver state */

typedef struct {
    char url[256];
    char sha256[65];
} ota_msg_t;

static QueueHandle_t s_ota_queue = NULL;
static char s_progress_topic[96]; /* device/{id}/ota/progress */
static bool s_ota_started = false;

/* Internal helpers */

static void report_ota_state(uint8_t percent, display_ota_stage_t stage, display_ota_error_t error)
{
    display_ota_state_t state = {
        .active = true,
        .percent = percent,
        .stage = stage,
        .error = error,
    };
    display_service_set_ota_state(&state);
}

static void publish_progress(int pct, const char *status)
{
    char msg[80];
    if (status != NULL) {
        snprintf(msg, sizeof(msg), "{\"progress\":%d,\"status\":\"%s\"}", pct, status);
    } else {
        snprintf(msg, sizeof(msg), "{\"progress\":%d}", pct);
    }
    int msg_id = mqtt_publish(s_progress_topic, msg, 1, false);
    if (msg_id < 0) {
        ESP_LOGW(TAG,
                 "OTA progress publish failed (progress=%d status=%s)",
                 pct,
                 status != NULL ? status : "none");
    }
}

static esp_err_t format_hex_string(const uint8_t *bytes, size_t byte_count, char *out, size_t out_size)
{
    if (bytes == NULL || out == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    if (out_size < (byte_count * 2U) + 1U) {
        return ESP_ERR_INVALID_SIZE;
    }

    for (size_t i = 0; i < byte_count; i++) {
        int written = snprintf(&out[i * 2U], out_size - (i * 2U), "%02x", bytes[i]);
        if (written != 2) {
            return ESP_FAIL;
        }
    }

    return ESP_OK;
}

/* FreeRTOS task */

static void ota_task_fn(void *arg)
{
    ota_msg_t msg;

    while (1) {
        /* Block until a trigger arrives */
        xQueueReceive(s_ota_queue, &msg, portMAX_DELAY);

        ESP_LOGI(TAG, "OTA triggered: %s", msg.url);
        report_ota_state(0, DISPLAY_OTA_STAGE_STARTING, DISPLAY_OTA_ERROR_NONE);
        publish_progress(0, "starting");

        /* Configure HTTPS OTA */
        esp_http_client_config_t http_cfg = {
            .url = msg.url,
            .crt_bundle_attach = esp_crt_bundle_attach,
            .keep_alive_enable = true,
        };
        esp_https_ota_config_t ota_cfg = {
            .http_config = &http_cfg,
        };

        esp_https_ota_handle_t ota_handle = NULL;
        esp_err_t err = esp_https_ota_begin(&ota_cfg, &ota_handle);
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "esp_https_ota_begin failed (%s)", esp_err_to_name(err));
            report_ota_state(0, DISPLAY_OTA_STAGE_FAILED, DISPLAY_OTA_ERROR_GENERIC);
            publish_progress(0, "failed");
            continue;
        }

        /* Download loop; publish progress every 10%. */
        int last_bucket = -1;
        while (1) {
            err = esp_https_ota_perform(ota_handle);
            if (err != ESP_ERR_HTTPS_OTA_IN_PROGRESS) {
                break;
            }

            int read = esp_https_ota_get_image_len_read(ota_handle);
            int total = esp_https_ota_get_image_size(ota_handle);
            if (total > 0) {
                int pct = (read * 100) / total;
                int bucket = (pct / 10) * 10;
                if (bucket != last_bucket) {
                    report_ota_state((uint8_t)bucket, DISPLAY_OTA_STAGE_DOWNLOADING, DISPLAY_OTA_ERROR_NONE);
                    publish_progress(bucket, NULL);
                    last_bucket = bucket;
                }
            }
        }

        if (err != ESP_OK) {
            ESP_LOGE(TAG, "esp_https_ota_perform failed (%s)", esp_err_to_name(err));
            esp_https_ota_abort(ota_handle);
            report_ota_state(0, DISPLAY_OTA_STAGE_FAILED, DISPLAY_OTA_ERROR_GENERIC);
            publish_progress(0, "failed");
            continue;
        }

        report_ota_state(100, DISPLAY_OTA_STAGE_VERIFYING, DISPLAY_OTA_ERROR_NONE);

        /* Validate SHA256 before finish(); finish() changes the boot pointer,
         * so a mismatch detected after finish() would leave boot targeting a bad image.
         * Verify against the next-update partition (where OTA wrote data). */
        if (msg.sha256[0] != '\0') {
            const esp_partition_t *target = esp_ota_get_next_update_partition(NULL);
            uint8_t digest[32];
            if (target == NULL || esp_partition_get_sha256(target, digest) != ESP_OK) {
                ESP_LOGE(TAG, "SHA256 read failed; rejecting OTA image");
                esp_https_ota_abort(ota_handle);
                report_ota_state(100, DISPLAY_OTA_STAGE_FAILED, DISPLAY_OTA_ERROR_GENERIC);
                publish_progress(0, "failed");
                continue;
            }
            char actual_hex[65];
            err = format_hex_string(digest, sizeof(digest), actual_hex, sizeof(actual_hex));
            if (err != ESP_OK) {
                ESP_LOGE(TAG, "SHA256 hex formatting failed (%s)", esp_err_to_name(err));
                esp_https_ota_abort(ota_handle);
                report_ota_state(100, DISPLAY_OTA_STAGE_FAILED, DISPLAY_OTA_ERROR_GENERIC);
                publish_progress(0, "failed");
                continue;
            }
            if (strcasecmp(actual_hex, msg.sha256) != 0) {
                ESP_LOGE(TAG, "SHA256 mismatch; expected %s, got %s", msg.sha256, actual_hex);
                esp_https_ota_abort(ota_handle);
                report_ota_state(100, DISPLAY_OTA_STAGE_FAILED, DISPLAY_OTA_ERROR_SHA256_MISMATCH);
                publish_progress(0, "sha256_mismatch");
                continue;
            }
            ESP_LOGI(TAG, "SHA256 verified: %s", actual_hex);
        }

        err = esp_https_ota_finish(ota_handle);
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "esp_https_ota_finish failed (%s)", esp_err_to_name(err));
            report_ota_state(100, DISPLAY_OTA_STAGE_FAILED, DISPLAY_OTA_ERROR_GENERIC);
            publish_progress(0, "failed");
            continue;
        }

        ESP_LOGI(TAG, "OTA download complete; rebooting");
        report_ota_state(100, DISPLAY_OTA_STAGE_REBOOTING, DISPLAY_OTA_ERROR_NONE);
        publish_progress(100, "rebooting");

        /* Small delay to let the MQTT message flush */
        vTaskDelay(pdMS_TO_TICKS(500));
        esp_restart();
    }
}

/* Public API */

esp_err_t ota_task_start(const char *device_id)
{
    if (s_ota_started) {
        ESP_LOGW(TAG, "ota_task already started");
        return ESP_ERR_INVALID_STATE;
    }

    snprintf(s_progress_topic, sizeof(s_progress_topic), "device/%s/ota/progress", device_id != NULL ? device_id : "");

    s_ota_queue = xQueueCreate(1, sizeof(ota_msg_t));
    if (s_ota_queue == NULL) {
        ESP_LOGE(TAG, "xQueueCreate failed");
        return ESP_FAIL;
    }

    /* Per firmware task map: Core 1, Priority 3, 8192 B */
    BaseType_t rc = xTaskCreatePinnedToCore(ota_task_fn, "ota_task", 8192, NULL, 3, NULL, APP_CPU_NUM);
    if (rc != pdPASS) {
        ESP_LOGE(TAG, "xTaskCreatePinnedToCore failed");
        vQueueDelete(s_ota_queue);
        s_ota_queue = NULL;
        return ESP_FAIL;
    }

    s_ota_started = true;
    ESP_LOGI(TAG, "ota_task started (topic: %s)", s_progress_topic);
    return ESP_OK;
}

esp_err_t ota_trigger(const char *url, const char *sha256)
{
    ota_msg_t msg = {0};

    /* SEC-02: HTTPS only */
    if (url == NULL || strncmp(url, "https://", 8) != 0) {
        ESP_LOGW(TAG, "OTA trigger rejected; URL must start with https://");
        return ESP_ERR_INVALID_ARG;
    }

    if (strnlen(url, sizeof(msg.url)) >= sizeof(msg.url)) {
        ESP_LOGW(TAG, "OTA trigger rejected; URL exceeds %u bytes", (unsigned)(sizeof(msg.url) - 1U));
        return ESP_ERR_INVALID_SIZE;
    }

    if (s_ota_queue == NULL) {
        ESP_LOGW(TAG, "OTA trigger ignored; queue not initialised");
        return ESP_FAIL;
    }

    strlcpy(msg.url, url, sizeof(msg.url));
    if (sha256 != NULL) {
        strlcpy(msg.sha256, sha256, sizeof(msg.sha256));
    }

    /* Non-blocking: drop trigger if a download is already queued */
    if (xQueueSend(s_ota_queue, &msg, 0) != pdTRUE) {
        ESP_LOGW(TAG, "OTA trigger dropped; queue full (download already pending)");
        report_ota_state(0, DISPLAY_OTA_STAGE_STARTING, DISPLAY_OTA_ERROR_BUSY);
        publish_progress(0, "busy");
        return ESP_FAIL;
    }

    ESP_LOGI(TAG, "OTA queued: %s", url);
    return ESP_OK;
}

void ota_validate_and_commit(void)
{
    const esp_partition_t *running = esp_ota_get_running_partition();
    esp_ota_img_states_t state;

    if (esp_ota_get_state_partition(running, &state) == ESP_OK && state == ESP_OTA_IMG_PENDING_VERIFY) {
        esp_err_t err = esp_ota_mark_app_valid_cancel_rollback();
        if (err == ESP_OK) {
            ESP_LOGI(TAG, "OTA validated; new firmware committed");
        } else {
            ESP_LOGE(TAG, "esp_ota_mark_app_valid_cancel_rollback failed (%s)", esp_err_to_name(err));
        }
    }
}

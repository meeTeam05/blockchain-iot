/**
 * @file device_mode.c
 * 
 * @brief Device mode management implementation for the ESP32-based smart plug.
 * 
 * Copyright (C) 2026 MinhNhat & BaoViet
 */

#include "device_mode.h"

#include "buzzer.h"
#include "config.h"
#include "display_service.h"
#include "esp_log.h"
#include "nvs.h"

#include "mqtt.h"

#include "cJSON.h"

#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <time.h>

#if SA_ENABLE_RELAYS
#include "relay.h"
#endif

#if SA_ENABLE_AI
#include "ai.h"
#endif

#define DEVICE_MODE_NVS_NAMESPACE "device"
#define DEVICE_MODE_NVS_KEY       "mode"
#define DEVICE_MODE_BEEP_MS       50
#define DEVICE_MODE_BEEP_GAP_MS   80

static const char *TAG = "device_mode";

static volatile bool s_mode_on = true;
static char s_tel_topic[96] = {0};
static char s_shadow_topic[96] = {0};
static char s_device_id[64] = {0};

static void device_mode_beep_toggle_pattern(void)
{
    static const buzzer_pattern_step_t pattern[] = {
        {.enabled = true, .duration_ms = DEVICE_MODE_BEEP_MS},
        {.enabled = false, .duration_ms = DEVICE_MODE_BEEP_GAP_MS},
        {.enabled = true, .duration_ms = DEVICE_MODE_BEEP_MS},
        {.enabled = false, .duration_ms = DEVICE_MODE_BEEP_GAP_MS},
        {.enabled = true, .duration_ms = DEVICE_MODE_BEEP_MS},
    };

    buzzer_beep_pattern(pattern, sizeof(pattern) / sizeof(pattern[0]));
}

static esp_err_t publish_json_topic(const char *topic, cJSON *root)
{
    if (topic == NULL || root == NULL) {
        return ESP_ERR_INVALID_ARG;
    }

    char *payload = cJSON_PrintUnformatted(root);
    if (payload == NULL) {
        ESP_LOGE(TAG, "cJSON_PrintUnformatted failed");
        return ESP_ERR_NO_MEM;
    }

    int msg_id = mqtt_publish(topic, payload, 1, false);
    cJSON_free(payload);

    if (msg_id < 0) {
        ESP_LOGW(TAG, "mqtt_publish failed for topic=%s", topic);
        return ESP_FAIL;
    }

    return ESP_OK;
}

static esp_err_t publish_final_null_telemetry(void)
{
    cJSON *root = cJSON_CreateObject();
    if (root == NULL) {
        return ESP_ERR_NO_MEM;
    }

    cJSON_AddStringToObject(root, "device_id", s_device_id);
    cJSON_AddNumberToObject(root, "ts", (double)time(NULL));
    cJSON_AddStringToObject(root, "mode", "off");
    cJSON_AddNullToObject(root, "temperature");
    cJSON_AddNullToObject(root, "humidity");
    cJSON_AddNullToObject(root, "co_ppm");
    cJSON_AddNullToObject(root, "no2_ppm");

    esp_err_t err = publish_json_topic(s_tel_topic, root);
    cJSON_Delete(root);
    return err;
}

static esp_err_t publish_mode_off_shadow(void)
{
    cJSON *root = cJSON_CreateObject();
    if (root == NULL) {
        return ESP_ERR_NO_MEM;
    }

    cJSON_AddStringToObject(root, "mode", "off");
#if SA_ENABLE_RELAYS
    cJSON_AddBoolToObject(root, "relay_1", false);
    cJSON_AddBoolToObject(root, "relay_2", false);
    cJSON_AddBoolToObject(root, "relay_3", false);
#endif
#if SA_ENABLE_AI
    cJSON_AddBoolToObject(root, "ai_enabled", ai_get_enabled());
#else
    /* Clears a stale ai_enabled left in the merged server shadow by an earlier AI build. */
    cJSON_AddNullToObject(root, "ai_enabled");
#endif
    cJSON_AddNullToObject(root, "temperature");
    cJSON_AddNullToObject(root, "humidity");
    cJSON_AddNullToObject(root, "co_ppm");
    cJSON_AddNullToObject(root, "no2_ppm");
    cJSON_AddNumberToObject(root, "ts", (double)time(NULL));

    esp_err_t err = publish_json_topic(s_shadow_topic, root);
    cJSON_Delete(root);
    return err;
}

static esp_err_t publish_mode_on_shadow(void)
{
#if SA_ENABLE_RELAYS
    bool relay_states[RELAY_CHANNEL_COUNT] = {false, false, false};
    esp_err_t relay_err = relay_get_all(relay_states);
    if (relay_err != ESP_OK) {
        ESP_LOGE(TAG, "relay_get_all failed: %s", esp_err_to_name(relay_err));
        return relay_err;
    }
#endif

    cJSON *root = cJSON_CreateObject();
    if (root == NULL) {
        return ESP_ERR_NO_MEM;
    }

    cJSON_AddStringToObject(root, "mode", "on");
#if SA_ENABLE_RELAYS
    cJSON_AddBoolToObject(root, "relay_1", relay_states[0]);
    cJSON_AddBoolToObject(root, "relay_2", relay_states[1]);
    cJSON_AddBoolToObject(root, "relay_3", relay_states[2]);
#endif
#if SA_ENABLE_AI
    cJSON_AddBoolToObject(root, "ai_enabled", ai_get_enabled());
#else
    /* Clears a stale ai_enabled left in the merged server shadow by an earlier AI build. */
    cJSON_AddNullToObject(root, "ai_enabled");
#endif
    cJSON_AddNumberToObject(root, "ts", (double)time(NULL));

    esp_err_t err = publish_json_topic(s_shadow_topic, root);
    cJSON_Delete(root);
    return err;
}

static esp_err_t persist_mode(bool on)
{
    esp_err_t guard_err = config_nvs_write_begin();
    if (guard_err != ESP_OK) {
        return guard_err;
    }

    nvs_handle_t h;
    esp_err_t err = nvs_open(DEVICE_MODE_NVS_NAMESPACE, NVS_READWRITE, &h);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "nvs_open(%s) failed: %s", DEVICE_MODE_NVS_NAMESPACE, esp_err_to_name(err));
        config_nvs_write_end();
        return err;
    }

    err = nvs_set_u8(h, DEVICE_MODE_NVS_KEY, on ? 1 : 0);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "nvs_set_u8(%s) failed: %s", DEVICE_MODE_NVS_KEY, esp_err_to_name(err));
        nvs_close(h);
        config_nvs_write_end();
        return err;
    }

    err = nvs_commit(h);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "nvs_commit failed: %s", esp_err_to_name(err));
    }

    nvs_close(h);
    config_nvs_write_end();
    return err;
}

static esp_err_t load_mode(bool *mode_on)
{
    if (mode_on == NULL) {
        return ESP_ERR_INVALID_ARG;
    }

    nvs_handle_t h;
    esp_err_t err = nvs_open(DEVICE_MODE_NVS_NAMESPACE, NVS_READONLY, &h);
    if (err == ESP_ERR_NVS_NOT_FOUND) {
        *mode_on = true;
        return ESP_OK;
    }

    if (err != ESP_OK) {
        ESP_LOGE(TAG, "nvs_open(%s) failed: %s", DEVICE_MODE_NVS_NAMESPACE, esp_err_to_name(err));
        return err;
    }

    uint8_t mode_u8 = 1;
    err = nvs_get_u8(h, DEVICE_MODE_NVS_KEY, &mode_u8);
    if (err == ESP_ERR_NVS_NOT_FOUND) {
        mode_u8 = 1;
        err = ESP_OK;
    } else if (err != ESP_OK) {
        ESP_LOGE(TAG, "nvs_get_u8(%s) failed: %s", DEVICE_MODE_NVS_KEY, esp_err_to_name(err));
    }

    nvs_close(h);

    if (err == ESP_OK) {
        *mode_on = (mode_u8 != 0);
    }

    return err;
}

esp_err_t device_mode_init(const char *device_id)
{
    if (device_id == NULL || device_id[0] == '\0') {
        return ESP_ERR_INVALID_ARG;
    }

    strlcpy(s_device_id, device_id, sizeof(s_device_id));
    snprintf(s_tel_topic, sizeof(s_tel_topic), "device/%s/telemetry", s_device_id);
    snprintf(s_shadow_topic, sizeof(s_shadow_topic), "device/%s/shadow/report", s_device_id);

    bool persisted_mode_on = true;
    esp_err_t err = load_mode(&persisted_mode_on);
    if (err != ESP_OK) {
        return err;
    }

    s_mode_on = persisted_mode_on;
    sensor_task_set_enabled(s_mode_on);
    display_service_set_mode(s_mode_on);

#if SA_ENABLE_RELAYS
    if (!persisted_mode_on) {
        err = relay_force_all_off_silent();
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "relay_force_all_off_silent failed during OFF-mode init: %s", esp_err_to_name(err));
            return err;
        }
    }
#endif

    ESP_LOGI(TAG, "init OK (mode=%s)", s_mode_on ? "on" : "off");
    return ESP_OK;
}

esp_err_t device_mode_set(bool on)
{
    if (on == s_mode_on) {
        return ESP_OK;
    }

    esp_err_t first_err = ESP_OK;
    esp_err_t err;

    if (!on) {
        err = publish_final_null_telemetry();
        if (err != ESP_OK && first_err == ESP_OK) {
            first_err = err;
        }

#if SA_ENABLE_RELAYS
        err = relay_force_all_off_silent();
        if (err != ESP_OK) {
            return err;
        }
#endif

        s_mode_on = false;
        sensor_task_set_enabled(false);
        display_service_set_mode(false);
        device_mode_beep_toggle_pattern();

        err = publish_mode_off_shadow();
        if (err != ESP_OK && first_err == ESP_OK) {
            first_err = err;
        }

        err = persist_mode(false);
        if (err != ESP_OK && first_err == ESP_OK) {
            first_err = err;
        }

        return first_err;
    }

    s_mode_on = true;
    sensor_task_set_enabled(true);
    display_service_set_mode(true);
    device_mode_beep_toggle_pattern();

    err = persist_mode(true);
    if (err != ESP_OK && first_err == ESP_OK) {
        first_err = err;
    }

    err = publish_mode_on_shadow();
    if (err != ESP_OK && first_err == ESP_OK) {
        first_err = err;
    }

    return first_err;
}

esp_err_t device_mode_publish_current_shadow(void)
{
    if (s_shadow_topic[0] == '\0') {
        return ESP_ERR_INVALID_STATE;
    }

    return s_mode_on ? publish_mode_on_shadow() : publish_mode_off_shadow();
}

bool device_mode_get(void)
{
    return s_mode_on;
}

/**
 * @file sysload.c
 *
 * @brief System initialisation and boot orchestration.
 *
 * Copyright (C) 2026 MinhNhat & BaoViet
 */

#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "nvs_flash.h"
#include "esp_attr.h"
#include "esp_netif.h"
#include "esp_netif_sntp.h"
#include "esp_event.h"
#include "esp_log.h"

#include "ble_prov.h"
#include "wifi.h"
#include "mqtt.h"
#include "i2cdev.h"
#include "sht3x.h"
#include "ds3231.h"
#include "adc_bus.h"
#include "gm702b.h"
#include "gm102b.h"
#include "led.h"
#include "factory_reset.h"
#include "sensor_task.h"
#include "ai.h"
#include "httpd.h"
#include "ota.h"
#include "buzzer.h"
#include "relay.h"
#include "device_mode.h"
#include "display_service.h"
#include "incident.h"
#if CONFIG_SA_INCIDENT_SIGNER_PROVISION_BENCH
#include "incident_signer_provision_bench.h"
#endif

#include "cJSON.h"

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/time.h>
#include <time.h>

#include "sysload.h"

static const char *TAG = "sysload";
#if SA_INCIDENT_OFFLINE_BENCH
static const char *INC_BENCH_TAG = "INC_BENCH";
#endif
static const uint32_t MIN_VALID_UNIX_TS = 946684800UL;
static const char *const SHADOW_SYNC_RELAY_KEYS[] = {"relay_1", "relay_2", "relay_3"};

#define SYSLOAD_BOOT_RESTART_DELAY_MS      2000
#define SYSLOAD_PROVISION_RESTART_DELAY_MS 5000
#define SYSLOAD_BOOT_FAILURE_RETRY_LIMIT   3
#define CALIBRATION_TASK_QUEUE_LEN         2
#define CALIBRATION_TASK_STACK_SIZE        4096
#define CALIBRATION_TASK_PRIORITY          3
#define CALIBRATION_TASK_NAME              "calibration_task"

#if SA_INCIDENT_OFFLINE_BENCH
#define NETWORK_ONLY_UNUSED __attribute__((unused))
#else
#define NETWORK_ONLY_UNUSED
#endif

RTC_DATA_ATTR static uint32_t s_boot_failure_count = 0;

/* File-scope sensor handles kept alive after sysload_init exits. */
#if SA_ENABLE_SHT3X
static sht3x_t s_sht3x_dev;
#endif
#if SA_ENABLE_DS3231
static ds3231_t s_ds3231_dev;
#endif
#if SA_ENABLE_CO_SENSOR
static gm702b_t s_co_dev;
#endif
#if SA_ENABLE_NO2_SENSOR
static gm102b_t s_no2_dev;
#endif

static int build_month_index(const char *month)
{
    static const char *months[] = {
        "Jan",
        "Feb",
        "Mar",
        "Apr",
        "May",
        "Jun",
        "Jul",
        "Aug",
        "Sep",
        "Oct",
        "Nov",
        "Dec",
    };

    for (int i = 0; i < 12; i++) {
        if (strncmp(month, months[i], 3) == 0) {
            return i;
        }
    }

    return -1;
}

static uint32_t build_time_fallback_ts(void)
{
    char month[4] = {0};
    int day = 0;
    int year = 0;
    int hour = 0;
    int minute = 0;
    int second = 0;

    if (sscanf(__DATE__, "%3s %d %d", month, &day, &year) != 3) {
        return MIN_VALID_UNIX_TS;
    }
    if (sscanf(__TIME__, "%d:%d:%d", &hour, &minute, &second) != 3) {
        return MIN_VALID_UNIX_TS;
    }

    int month_index = build_month_index(month);
    if (month_index < 0) {
        return MIN_VALID_UNIX_TS;
    }

    struct tm build_tm = {
        .tm_sec = second,
        .tm_min = minute,
        .tm_hour = hour,
        .tm_mday = day,
        .tm_mon = month_index,
        .tm_year = year - 1900,
        .tm_isdst = -1,
    };

    time_t build_time = mktime(&build_tm);
    if (build_time <= 0) {
        return MIN_VALID_UNIX_TS;
    }

    return (uint32_t)build_time;
}

static void sync_system_clock(uint32_t ts, const char *reason)
{
    struct timeval tv = {
        .tv_sec = (time_t)ts,
        .tv_usec = 0,
    };

    if (settimeofday(&tv, NULL) == 0) {
        ESP_LOGI(TAG, "System clock updated from %s: %lu", reason, (unsigned long)ts);
    } else {
        ESP_LOGW(TAG, "settimeofday failed for %s (errno=%d)", reason, errno);
    }
}

static void configure_local_timezone(void)
{
    if (setenv("TZ", SA_TIMEZONE, 1) != 0) {
        ESP_LOGW(TAG, "setenv(TZ) failed (errno=%d)", errno);
        return;
    }

    tzset();
    ESP_LOGI(TAG, "Local timezone configured: %s", SA_TIMEZONE);
}

static void ensure_system_clock_seeded(bool rtc_ready)
{
    time_t now = time(NULL);
    if (now >= (time_t)MIN_VALID_UNIX_TS) {
        return;
    }

#if SA_ENABLE_DS3231
    if (rtc_ready) {
        uint32_t rtc_ts = 0;
        esp_err_t err = ds3231_get_timestamp(&s_ds3231_dev, &rtc_ts);
        if (err == ESP_OK && rtc_ts >= MIN_VALID_UNIX_TS) {
            sync_system_clock(rtc_ts, "rtc");
            return;
        }
        if (err != ESP_OK) {
            ESP_LOGW(TAG, "RTC seed failed (%s) - falling back to build time", ds3231_err_to_name(err));
        } else {
            ESP_LOGW(TAG, "RTC seed ignored invalid timestamp %lu - falling back to build time", (unsigned long)rtc_ts);
        }
    }
#else
    (void)rtc_ready;
#endif

    sync_system_clock(build_time_fallback_ts(), "build time");
}

static bool establish_rtc_incident_time_source(bool rtc_ready)
{
#if SA_ENABLE_DS3231
    if (rtc_ready) {
        uint32_t rtc_ts = 0;
        if (ds3231_get_timestamp(&s_ds3231_dev, &rtc_ts) == ESP_OK && rtc_ts >= MIN_VALID_UNIX_TS) {
            incident_set_time_source(INCIDENT_TIME_DS3231);
            return true;
        }
    }
#else
    (void)rtc_ready;
#endif
    return false;
}

static void NETWORK_ONLY_UNUSED sync_time_from_sntp_stage(bool rtc_ready)
{
    esp_sntp_config_t config = ESP_NETIF_SNTP_DEFAULT_CONFIG(CONFIG_SA_SNTP_SERVER);
    config.start = false;
    config.wait_for_sync = true;
    config.server_from_dhcp = false;

    ESP_LOGI(TAG,
             "Starting best-effort SNTP sync: server=%s timeout=%dms",
             CONFIG_SA_SNTP_SERVER,
             CONFIG_SA_SNTP_SYNC_TIMEOUT_MS);

    esp_err_t err = esp_netif_sntp_init(&config);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "SNTP init failed (%s) - continuing with existing fallback", esp_err_to_name(err));
        return;
    }

    err = esp_netif_sntp_start();
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "SNTP start failed (%s) - continuing with existing fallback", esp_err_to_name(err));
        esp_netif_sntp_deinit();
        return;
    }

    err = esp_netif_sntp_sync_wait(pdMS_TO_TICKS(CONFIG_SA_SNTP_SYNC_TIMEOUT_MS));
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "SNTP sync wait failed (%s) - continuing with existing fallback", esp_err_to_name(err));
        esp_netif_sntp_deinit();
        return;
    }

    time_t now = time(NULL);
    if (now < (time_t)MIN_VALID_UNIX_TS) {
        ESP_LOGW(TAG, "SNTP reported success but system time is still invalid - continuing with existing fallback");
        esp_netif_sntp_deinit();
        return;
    }

    uint32_t ts = (uint32_t)now;
    sync_system_clock(ts, "sntp");
    incident_set_time_source(INCIDENT_TIME_SNTP);

#if SA_ENABLE_DS3231
    if (rtc_ready) {
        err = ds3231_set_timestamp(&s_ds3231_dev, ts);
        if (err == ESP_OK) {
            ESP_LOGI(TAG, "DS3231 time updated from SNTP: %lu", (unsigned long)ts);
        } else {
            ESP_LOGW(TAG, "DS3231 set_timestamp failed after SNTP sync: %s", ds3231_err_to_name(err));
        }
    }
#else
    (void)rtc_ready;
#endif

    esp_netif_sntp_deinit();
}

#if SA_ENABLE_CO_SENSOR || SA_ENABLE_NO2_SENSOR
typedef enum {
    CALIBRATION_KIND_CO = 0,
    CALIBRATION_KIND_NO2,
} calibration_kind_t;

typedef struct {
    calibration_kind_t kind;
    char command_id[40];
} calibration_request_t;

static QueueHandle_t s_calibration_queue = NULL;

static esp_err_t run_calibration_request(const calibration_request_t *req)
{
    switch (req->kind) {
#if SA_ENABLE_CO_SENSOR
    case CALIBRATION_KIND_CO: {
        esp_err_t err = gm702b_calibrate(&s_co_dev);
        if (err == ESP_OK) {
            return config_save_gas_r0("co", s_co_dev.r0);
        }
        ESP_LOGE(TAG, "CO calibration failed: %s", esp_err_to_name(err));
        return err;
    }
#endif
#if SA_ENABLE_NO2_SENSOR
    case CALIBRATION_KIND_NO2: {
        esp_err_t err = gm102b_calibrate(&s_no2_dev);
        if (err == ESP_OK) {
            return config_save_gas_r0("no2", s_no2_dev.r0);
        }
        ESP_LOGE(TAG, "NO2 calibration failed: %s", esp_err_to_name(err));
        return err;
    }
#endif
    default:
        return ESP_ERR_NOT_SUPPORTED;
    }
}

static void calibration_task_fn(void *arg)
{
    (void)arg;

    calibration_request_t req;
    while (1) {
        xQueueReceive(s_calibration_queue, &req, portMAX_DELAY);

        esp_err_t err = run_calibration_request(&req);
        if (config_factory_reset_in_progress()) {
            ESP_LOGW(TAG, "Skipping calibration ack for '%s' during factory reset", req.command_id);
            continue;
        }
        esp_err_t ack_err = mqtt_publish_command_ack(req.command_id, err == ESP_OK);
        if (ack_err != ESP_OK) {
            ESP_LOGW(TAG, "Calibration ack publish failed for '%s': %s", req.command_id, esp_err_to_name(ack_err));
        }
    }
}

static esp_err_t calibration_task_start(void)
{
    if (s_calibration_queue != NULL) {
        return ESP_OK;
    }

    s_calibration_queue = xQueueCreate(CALIBRATION_TASK_QUEUE_LEN, sizeof(calibration_request_t));
    if (s_calibration_queue == NULL) {
        ESP_LOGE(TAG, "xQueueCreate failed for calibration task");
        return ESP_FAIL;
    }

    BaseType_t rc = xTaskCreatePinnedToCore(calibration_task_fn,
                                            CALIBRATION_TASK_NAME,
                                            CALIBRATION_TASK_STACK_SIZE,
                                            NULL,
                                            CALIBRATION_TASK_PRIORITY,
                                            NULL,
                                            APP_CPU_NUM);
    if (rc != pdPASS) {
        ESP_LOGE(TAG, "xTaskCreatePinnedToCore failed for calibration task");
        vQueueDelete(s_calibration_queue);
        s_calibration_queue = NULL;
        return ESP_FAIL;
    }

    ESP_LOGI(TAG, "calibration_task started");
    return ESP_OK;
}

static esp_err_t queue_calibration_request(calibration_kind_t kind, const char *json_payload)
{
    if (s_calibration_queue == NULL) {
        ESP_LOGW(TAG, "Calibration queue not initialised");
        return ESP_ERR_INVALID_STATE;
    }
    if (json_payload == NULL) {
        ESP_LOGW(TAG, "Calibration command: missing payload");
        return ESP_ERR_INVALID_ARG;
    }

    cJSON *root = cJSON_ParseWithLength(json_payload, strlen(json_payload));
    if (root == NULL) {
        ESP_LOGW(TAG, "Calibration command: invalid JSON payload");
        return ESP_ERR_INVALID_ARG;
    }

    cJSON *j_cmd_id = cJSON_GetObjectItemCaseSensitive(root, "command_id");
    if (!cJSON_IsString(j_cmd_id) || j_cmd_id->valuestring[0] == '\0') {
        cJSON_Delete(root);
        ESP_LOGW(TAG, "Calibration command: missing command_id");
        return ESP_ERR_INVALID_ARG;
    }

    calibration_request_t req = {
        .kind = kind,
    };
    size_t copied = strlcpy(req.command_id, j_cmd_id->valuestring, sizeof(req.command_id));
    cJSON_Delete(root);
    if (copied >= sizeof(req.command_id)) {
        ESP_LOGW(TAG, "Calibration command_id too long");
        return ESP_ERR_INVALID_SIZE;
    }

    if (xQueueSend(s_calibration_queue, &req, 0) != pdTRUE) {
        ESP_LOGW(TAG, "Calibration request dropped; queue full");
        return ESP_FAIL;
    }

    ESP_LOGI(TAG, "Calibration queued: type=%d command_id=%s", (int)req.kind, req.command_id);
    return ESP_ERR_NOT_FINISHED;
}
#endif

static cJSON *shadow_sync_select_patch(cJSON *root, const char **source_name)
{
    cJSON *delta = cJSON_GetObjectItemCaseSensitive(root, "delta");
    if (cJSON_IsObject(delta)) {
        if (source_name != NULL) {
            *source_name = "delta";
        }
        return delta;
    }

    cJSON *desired = cJSON_GetObjectItemCaseSensitive(root, "desired");
    if (cJSON_IsObject(desired)) {
        if (source_name != NULL) {
            *source_name = "desired";
        }
        return desired;
    }

    return NULL;
}

static bool shadow_sync_has_supported_key(cJSON *patch)
{
    if (patch == NULL) {
        return false;
    }

    if (cJSON_GetObjectItemCaseSensitive(patch, "mode") != NULL) {
        return true;
    }

    for (size_t i = 0; i < RELAY_CHANNEL_COUNT; i++) {
        if (cJSON_GetObjectItemCaseSensitive(patch, SHADOW_SYNC_RELAY_KEYS[i]) != NULL) {
            return true;
        }
    }

    return false;
}

static void shadow_sync_log_unknown_keys(cJSON *patch)
{
    for (cJSON *item = patch != NULL ? patch->child : NULL; item != NULL; item = item->next) {
        if (item->string == NULL) {
            continue;
        }

        if (strcmp(item->string, "mode") == 0) {
            continue;
        }

        bool is_relay_key = false;
        for (size_t i = 0; i < RELAY_CHANNEL_COUNT; i++) {
            if (strcmp(item->string, SHADOW_SYNC_RELAY_KEYS[i]) == 0) {
                is_relay_key = true;
                break;
            }
        }
        if (is_relay_key) {
            continue;
        }

        ESP_LOGI(TAG, "shadow sync ignored unsupported key: %s", item->string);
    }
}

static esp_err_t NETWORK_ONLY_UNUSED handle_shadow_get_response(const char *json_payload)
{
    if (json_payload == NULL) {
        ESP_LOGW(TAG, "shadow/get_response: missing payload");
        return ESP_ERR_INVALID_ARG;
    }

    cJSON *root = cJSON_ParseWithLength(json_payload, strlen(json_payload));
    if (root == NULL) {
        ESP_LOGW(TAG, "shadow/get_response: invalid JSON payload");
        return ESP_ERR_INVALID_ARG;
    }

    const char *patch_source = NULL;
    cJSON *patch = shadow_sync_select_patch(root, &patch_source);
    if (patch == NULL) {
        ESP_LOGW(TAG, "shadow/get_response: missing object delta/desired");
        cJSON_Delete(root);
        return ESP_ERR_INVALID_ARG;
    }

    shadow_sync_log_unknown_keys(patch);
    if (!shadow_sync_has_supported_key(patch)) {
        ESP_LOGI(TAG, "shadow/get_response: %s has no mode/relay changes to apply", patch_source);
        cJSON_Delete(root);
        return ESP_OK;
    }

    bool turned_off = false;
    cJSON *j_mode = cJSON_GetObjectItemCaseSensitive(patch, "mode");
    if (j_mode != NULL) {
        if (!cJSON_IsString(j_mode)) {
            ESP_LOGW(TAG, "shadow/get_response: mode must be string");
            cJSON_Delete(root);
            return ESP_ERR_INVALID_ARG;
        }

        bool mode_on = false;
        if (strcmp(j_mode->valuestring, "on") == 0) {
            mode_on = true;
        } else if (strcmp(j_mode->valuestring, "off") == 0) {
            mode_on = false;
        } else {
            ESP_LOGW(TAG, "shadow/get_response: unsupported mode value '%s'", j_mode->valuestring);
            cJSON_Delete(root);
            return ESP_ERR_INVALID_ARG;
        }

        esp_err_t mode_err = device_mode_set(mode_on);
        if (mode_err != ESP_OK) {
            ESP_LOGW(TAG, "shadow/get_response: device_mode_set failed: %s", esp_err_to_name(mode_err));
            cJSON_Delete(root);
            return mode_err;
        }

        turned_off = !mode_on;
    }

    if (turned_off) {
        for (size_t i = 0; i < RELAY_CHANNEL_COUNT; i++) {
            if (cJSON_GetObjectItemCaseSensitive(patch, SHADOW_SYNC_RELAY_KEYS[i]) != NULL) {
                ESP_LOGI(TAG, "shadow/get_response: skipped relay keys because mode=off was applied");
                break;
            }
        }
        cJSON_Delete(root);
        return ESP_OK;
    }

    bool mode_on_now = device_mode_get();
    for (size_t i = 0; i < RELAY_CHANNEL_COUNT; i++) {
        cJSON *j_relay = cJSON_GetObjectItemCaseSensitive(patch, SHADOW_SYNC_RELAY_KEYS[i]);
        if (j_relay == NULL) {
            continue;
        }
        if (!cJSON_IsBool(j_relay)) {
            ESP_LOGW(TAG, "shadow/get_response: %s must be boolean", SHADOW_SYNC_RELAY_KEYS[i]);
            cJSON_Delete(root);
            return ESP_ERR_INVALID_ARG;
        }
        if (!mode_on_now) {
            ESP_LOGI(TAG, "shadow/get_response: ignored %s because device mode is off", SHADOW_SYNC_RELAY_KEYS[i]);
            continue;
        }

        esp_err_t relay_err = relay_set((int)i + 1, cJSON_IsTrue(j_relay));
        if (relay_err != ESP_OK) {
            ESP_LOGW(TAG, "shadow/get_response: relay_set(%d) failed: %s", (int)i + 1, esp_err_to_name(relay_err));
            cJSON_Delete(root);
            return relay_err;
        }
    }

    ESP_LOGI(TAG, "shadow/get_response applied from %s", patch_source);
    cJSON_Delete(root);
    return ESP_OK;
}

/* Gas sensor calibration MQTT command callbacks */

#if SA_ENABLE_CO_SENSOR
static esp_err_t handle_calibrate_co(const char *type, const char *json_payload)
{
    (void)type;
    return queue_calibration_request(CALIBRATION_KIND_CO, json_payload);
}
#endif

#if SA_ENABLE_NO2_SENSOR
static esp_err_t handle_calibrate_no2(const char *type, const char *json_payload)
{
    (void)type;
    return queue_calibration_request(CALIBRATION_KIND_NO2, json_payload);
}
#endif

#if SA_ENABLE_RELAYS
static esp_err_t handle_relay_set(const char *type, const char *json_payload)
{
    (void)type;

    if (json_payload == NULL) {
        ESP_LOGW(TAG, "relay_set command: missing payload");
        return ESP_ERR_INVALID_ARG;
    }

    cJSON *root = cJSON_ParseWithLength(json_payload, strlen(json_payload));
    if (root == NULL) {
        ESP_LOGW(TAG, "relay_set command: invalid JSON payload");
        return ESP_ERR_INVALID_ARG;
    }

    cJSON *j_relay = cJSON_GetObjectItemCaseSensitive(root, "relay");
    cJSON *j_state = cJSON_GetObjectItemCaseSensitive(root, "state");

    if (!cJSON_IsNumber(j_relay) || !cJSON_IsBool(j_state)) {
        ESP_LOGW(TAG, "relay_set command: invalid relay/state fields");
        cJSON_Delete(root);
        return ESP_ERR_INVALID_ARG;
    }

    int channel = (int)j_relay->valuedouble;
    if ((double)channel != j_relay->valuedouble) {
        ESP_LOGW(TAG, "relay_set command: relay must be integer");
        cJSON_Delete(root);
        return ESP_ERR_INVALID_ARG;
    }

    bool on = cJSON_IsTrue(j_state);
    cJSON_Delete(root);

    esp_err_t err = relay_set(channel, on);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "relay_set command failed: %s", esp_err_to_name(err));
    }

    return err;
}
#endif

#if SA_ENABLE_AI
static esp_err_t NETWORK_ONLY_UNUSED handle_ai_set(const char *type, const char *json_payload)
{
    (void)type;

    if (json_payload == NULL) {
        ESP_LOGW(TAG, "ai_set command: missing payload");
        return ESP_ERR_INVALID_ARG;
    }

    cJSON *root = cJSON_ParseWithLength(json_payload, strlen(json_payload));
    if (root == NULL) {
        ESP_LOGW(TAG, "ai_set command: invalid JSON payload");
        return ESP_ERR_INVALID_ARG;
    }

    cJSON *j_state = cJSON_GetObjectItemCaseSensitive(root, "state");
    if (!cJSON_IsBool(j_state)) {
        ESP_LOGW(TAG, "ai_set command: state must be boolean");
        cJSON_Delete(root);
        return ESP_ERR_INVALID_ARG;
    }

    bool enabled = cJSON_IsTrue(j_state);
    cJSON_Delete(root);

    if (!device_mode_get()) {
        ESP_LOGW(TAG, "ai_set command rejected: device mode is off");
        return ESP_ERR_INVALID_STATE;
    }

    esp_err_t err = ai_set_enabled(enabled);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "ai_set command failed: %s", esp_err_to_name(err));
    }

    return err;
}
#endif

static esp_err_t handle_device_mode(const char *type, const char *json_payload)
{
    (void)type;

    if (json_payload == NULL) {
        ESP_LOGW(TAG, "device_mode command: missing payload");
        return ESP_ERR_INVALID_ARG;
    }

    cJSON *root = cJSON_ParseWithLength(json_payload, strlen(json_payload));
    if (root == NULL) {
        ESP_LOGW(TAG, "device_mode command: invalid JSON payload");
        return ESP_ERR_INVALID_ARG;
    }

    cJSON *j_mode = cJSON_GetObjectItemCaseSensitive(root, "mode");
    if (!cJSON_IsString(j_mode)) {
        ESP_LOGW(TAG, "device_mode command: mode must be string");
        cJSON_Delete(root);
        return ESP_ERR_INVALID_ARG;
    }

    bool mode_on = false;
    if (strcmp(j_mode->valuestring, "on") == 0) {
        mode_on = true;
    } else if (strcmp(j_mode->valuestring, "off") == 0) {
        mode_on = false;
    } else {
        ESP_LOGW(TAG, "device_mode command: unsupported mode value");
        cJSON_Delete(root);
        return ESP_ERR_INVALID_ARG;
    }

    cJSON_Delete(root);

    esp_err_t err = device_mode_set(mode_on);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "device_mode command failed: %s", esp_err_to_name(err));
    }

    return err;
}

static void reboot_after_boot_error(const char *step, esp_err_t err)
{
    led_set_state(LED_STATE_ERROR);
    s_boot_failure_count++;

    if (s_boot_failure_count >= SYSLOAD_BOOT_FAILURE_RETRY_LIMIT) {
        ESP_LOGE(TAG,
                 "%s failed (%s); boot retry limit reached (%lu), entering safe mode",
                 step,
                 esp_err_to_name(err),
                 (unsigned long)s_boot_failure_count);
        vTaskDelete(NULL);
    }

    ESP_LOGE(TAG,
             "%s failed (%s); rebooting (%lu/%d)",
             step,
             esp_err_to_name(err),
             (unsigned long)s_boot_failure_count,
             SYSLOAD_BOOT_FAILURE_RETRY_LIMIT);
    vTaskDelay(pdMS_TO_TICKS(SYSLOAD_BOOT_RESTART_DELAY_MS));
    esp_restart();
}

static void register_command_handler_or_reboot(const char *type, mqtt_command_cb_t cb)
{
    esp_err_t err = mqtt_register_command_handler(type, cb);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "mqtt_register_command_handler(%s) failed (%s)", type, esp_err_to_name(err));
        reboot_after_boot_error("mqtt_register_command_handler", err);
    }
}

static void reboot_after_provision_failure(void)
{
    led_set_state(LED_STATE_ERROR);
    ESP_LOGE(TAG, "Provisioning failed; rebooting in 5 s");
    vTaskDelay(pdMS_TO_TICKS(SYSLOAD_PROVISION_RESTART_DELAY_MS));
    esp_restart();
}

static void init_factory_reset_stage(void)
{
#if SA_ENABLE_FACTORY_RESET
    esp_err_t err = factory_reset_init((gpio_num_t)CONFIG_SA_FACTORY_RESET_PIN);
    if (err != ESP_OK) {
        reboot_after_boot_error("factory_reset_init", err);
    }
#endif
}

static void init_nvs_stage(void)
{
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
#if SA_ENABLE_BLOCKCHAIN_INCIDENT
        ESP_LOGE(TAG,
                 "encrypted default NVS requires destructive recovery (%s); refusing automatic erase to preserve signer and incidents",
                 esp_err_to_name(err));
#else
        ESP_ERROR_CHECK(nvs_flash_erase());
        err = nvs_flash_init();
#endif
    }
    if (err != ESP_OK) {
        reboot_after_boot_error("nvs_flash_init", err);
    }

    err = nvs_flash_init_partition(SA_NVS_CALIB_PARTITION);
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
#if SA_INCIDENT_OFFLINE_BENCH
        ESP_LOGE(INC_BENCH_TAG, "calibration NVS init requires erase; refusing automatic erase");
#else
        ESP_ERROR_CHECK(nvs_flash_erase_partition(SA_NVS_CALIB_PARTITION));
        err = nvs_flash_init_partition(SA_NVS_CALIB_PARTITION);
#endif
    }
    if (err != ESP_OK) {
        reboot_after_boot_error("nvs_flash_init_partition(calib)", err);
    }
}

static void NETWORK_ONLY_UNUSED init_network_stack_stage(void)
{
    esp_err_t err = esp_netif_init();
    if (err != ESP_OK) {
        reboot_after_boot_error("esp_netif_init", err);
    }

    err = esp_event_loop_create_default();
    if (err != ESP_OK) {
        reboot_after_boot_error("esp_event_loop_create_default", err);
    }
}

static void start_display_stage(void)
{
    esp_err_t err = display_service_init();
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "display_service_init failed (%s) - continuing headless", esp_err_to_name(err));
        return;
    }

    display_service_set_boot_phase(DISPLAY_BOOT_PHASE_BOOT);
}

static void init_i2c_bus_stage(void)
{
#if SA_ENABLE_SHT3X || SA_ENABLE_DS3231
    esp_err_t err = i2c_bus_init(I2C_NUM_0, (gpio_num_t)SA_I2C_SDA_PIN, (gpio_num_t)SA_I2C_SCL_PIN, SA_I2C_FREQ_HZ);
    if (err != ESP_OK) {
        reboot_after_boot_error("i2c_bus_init", err);
    }
#endif
}

static void NETWORK_ONLY_UNUSED init_wifi_stage(void)
{
    esp_err_t err = wifi_sta_init();
    if (err != ESP_OK) {
        reboot_after_boot_error("wifi_sta_init", err);
    }
}

static void NETWORK_ONLY_UNUSED run_ble_provisioning_stage(void)
{
    if (ble_prov_is_provisioned()) {
        return;
    }

    display_service_set_boot_phase(DISPLAY_BOOT_PHASE_BLE);
    ESP_LOGI(TAG, "Not provisioned; starting BLE provisioning");
    led_set_state(LED_STATE_BLE);

    esp_err_t err = ble_prov_start();
    ble_prov_stop();
    if (err != ESP_OK) {
        reboot_after_provision_failure();
    }
}

static void NETWORK_ONLY_UNUSED load_wifi_credentials_stage(char *ssid, size_t ssid_len, char *password, size_t password_len)
{
    esp_err_t err = ble_prov_load_credentials(ssid, ssid_len, password, password_len);
    if (err != ESP_OK) {
        reboot_after_boot_error("ble_prov_load_credentials", err);
    }
}

static void NETWORK_ONLY_UNUSED connect_wifi_stage(const char *ssid, const char *password)
{
    display_service_set_boot_phase(DISPLAY_BOOT_PHASE_WIFI);

    if (wifi_sta_is_connected()) {
        led_set_state(LED_STATE_WIFI);
        return;
    }

    led_set_state(LED_STATE_WIFI);
    ESP_LOGI(TAG, "Connecting to Wi-Fi SSID: %s", ssid);

    esp_err_t err = wifi_sta_connect(ssid, password, CONFIG_SA_WIFI_CONNECT_TIMEOUT_MS);
    if (err != ESP_OK) {
        led_set_state(LED_STATE_ERROR);
        ESP_LOGE(
            TAG, "Wi-Fi connect failed (%s); preserving provisioned credentials and rebooting", esp_err_to_name(err));
        vTaskDelay(pdMS_TO_TICKS(SYSLOAD_BOOT_RESTART_DELAY_MS));
        esp_restart();
    }

    led_set_state(LED_STATE_WIFI);
}

static void NETWORK_ONLY_UNUSED load_runtime_config_stage(char *broker_uri,
                                      size_t broker_uri_len,
                                      char *resolved_id,
                                      size_t resolved_id_len,
                                      char *secret_key,
                                      size_t secret_key_len)
{
    esp_err_t err = config_get_device_id(resolved_id, resolved_id_len);
    if (err != ESP_OK) {
        reboot_after_boot_error("config_get_device_id", err);
    }

    err = config_get_mqtt_creds(broker_uri, broker_uri_len, secret_key, secret_key_len);
    if (err != ESP_OK) {
        reboot_after_boot_error("config_get_mqtt_creds", err);
    }
}

static void NETWORK_ONLY_UNUSED start_http_server_stage(const char *resolved_id)
{
    char ip_str[16] = {0};
    wifi_sta_get_ip(ip_str, sizeof(ip_str));

    esp_err_t err = httpd_server_start(resolved_id, ip_str);
    if (err != ESP_OK) {
        reboot_after_boot_error("httpd_server_start", err);
    }
}

static void init_runtime_control_stage(const char *resolved_id)
{
    esp_err_t err = buzzer_init();
    if (err != ESP_OK) {
        reboot_after_boot_error("buzzer_init", err);
    }

#if SA_ENABLE_RELAYS
    err = relay_init(resolved_id);
    if (err != ESP_OK) {
        reboot_after_boot_error("relay_init", err);
    }
#endif

    err = device_mode_init(resolved_id);
    if (err != ESP_OK) {
        reboot_after_boot_error("device_mode_init", err);
    }

    err = incident_init(resolved_id);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "incident_init failed: %s; continuing without incidents", esp_err_to_name(err));
    }

#if CONFIG_SA_INCIDENT_SIGNER_PROVISION_BENCH
    err = incident_signer_provision_bench_start();
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "signer provisioning bench start failed: %s", esp_err_to_name(err));
    }
#endif

#if SA_ENABLE_RELAYS
    register_command_handler_or_reboot("relay_set", handle_relay_set);
#endif
    register_command_handler_or_reboot("device_mode", handle_device_mode);
#if SA_ENABLE_BLOCKCHAIN_INCIDENT
    /* Backend signer lifecycle sends the sequence floor after on-chain registration. */
    register_command_handler_or_reboot("signer_activate", incident_handle_signer_activate);
#endif
}

static void NETWORK_ONLY_UNUSED start_mqtt_stage(const char *broker_uri, const char *resolved_id, const char *secret_key)
{
    display_service_set_boot_phase(DISPLAY_BOOT_PHASE_MQTT);

    esp_err_t err = mqtt_start(broker_uri, resolved_id, secret_key);
    if (err != ESP_OK) {
        reboot_after_boot_error("mqtt_start", err);
    }
}

static void NETWORK_ONLY_UNUSED start_ota_stage(const char *resolved_id)
{
    esp_err_t err = ota_task_start(resolved_id);
    if (err != ESP_OK) {
        reboot_after_boot_error("ota_task_start", err);
    }
}

/* Time sync callback (app -> MQTT -> DS3231) */

#if SA_ENABLE_DS3231
static void NETWORK_ONLY_UNUSED on_time_sync(uint32_t ts)
{
    sync_system_clock(ts, "set_time");

    esp_err_t err = ds3231_set_timestamp(&s_ds3231_dev, ts);
    if (err == ESP_OK) {
        ESP_LOGI(TAG, "DS3231 time updated: %lu", (unsigned long)ts);
        incident_set_time_source(INCIDENT_TIME_DS3231);
    } else {
        ESP_LOGW(TAG, "DS3231 set_timestamp failed: %s", ds3231_err_to_name(err));
    }
}
#else
static void NETWORK_ONLY_UNUSED on_time_sync(uint32_t ts)
{
    sync_system_clock(ts, "set_time");
    ESP_LOGI(TAG, "DS3231 disabled; set_time(%lu) acknowledged, system clock updated", (unsigned long)ts);
}
#endif

void sysload_init(void)
{
    /* 0 - LED (init first so status is visible immediately) */
    ESP_ERROR_CHECK(led_init());
    led_set_state(LED_STATE_BOOT);

    /* 0.5 - Factory reset button (early so it works in every boot phase) */
    init_factory_reset_stage();

    /* 0.75 - Optional display bring-up (non-fatal, for boot/provisioning visibility) */
    start_display_stage();

    /* 1 - NVS init (required by Wi-Fi and BLE provisioning) */
    init_nvs_stage();
#if SA_INCIDENT_OFFLINE_BENCH
    ESP_LOGW(INC_BENCH_TAG, "mode enabled");
    ESP_LOGI(INC_BENCH_TAG, "network provisioning bypassed");
    ESP_LOGI(INC_BENCH_TAG,
             "replay scenario=%d speed=%dx",
             CONFIG_SA_AI_REPLAY_SCENARIO,
             CONFIG_SA_AI_REPLAY_SPEED);
    ESP_LOGI(INC_BENCH_TAG, "encrypted NVS ready");
#endif

    /* 2 - Network stack (must precede wifi_sta_init) */
#if !SA_INCIDENT_OFFLINE_BENCH
    init_network_stack_stage();
#endif

    /* 3 - I2C bus (shared by SHT3x and DS3231, HW-01: 400 kHz) */
    /* Only init bus if at least one I2C device is enabled. Add to this guard
     * when new I2C devices are added. */
    init_i2c_bus_stage();

    /* 4 - SHT3x temperature/humidity sensor (addr 0x44, ADDR pin low - HW-04) */
#if SA_ENABLE_SHT3X
    esp_err_t sht_err = sht3x_init_desc(
        &s_sht3x_dev, SHT3X_I2C_ADDR_GND, I2C_NUM_0, (gpio_num_t)SA_I2C_SDA_PIN, (gpio_num_t)SA_I2C_SCL_PIN);
    if (sht_err == ESP_OK)
        sht_err = i2c_dev_init(&s_sht3x_dev.i2c_dev);
    if (sht_err == ESP_OK)
        sht_err = sht3x_init(&s_sht3x_dev);
    if (sht_err != ESP_OK) {
        ESP_LOGW(TAG, "SHT3x init failed (%s); sensor unavailable", esp_err_to_name(sht_err));
    }
#endif

    /* 5 - DS3231 RTC (addr 0x68 - HW-04) */
#if SA_ENABLE_DS3231
    esp_err_t rtc_err =
        ds3231_init_desc(&s_ds3231_dev, I2C_NUM_0, (gpio_num_t)SA_I2C_SDA_PIN, (gpio_num_t)SA_I2C_SCL_PIN);
    if (rtc_err == ESP_OK)
        rtc_err = i2c_dev_init(&s_ds3231_dev.i2c_dev);
    if (rtc_err != ESP_OK) {
        ESP_LOGW(TAG, "DS3231 init failed (%s); RTC unavailable", esp_err_to_name(rtc_err));
    }
#endif

    /* 5.5 - ADC bus + gas sensors (analog, WiFi-safe ADC1 only) */
#if SA_ENABLE_CO_SENSOR || SA_ENABLE_NO2_SENSOR
    {
        esp_err_t err = adc_bus_init();
        if (err != ESP_OK) {
            ESP_LOGW(TAG, "adc_bus_init failed (%s); gas sensors unavailable", esp_err_to_name(err));
        }
    }

    bool calibration_worker_needed = false;
#endif

#if SA_ENABLE_CO_SENSOR
    esp_err_t co_err =
        gm702b_init(&s_co_dev, (adc_channel_t)SA_CO_ADC_CHANNEL, SA_GAS_SENSOR_RL_OHM, SA_GAS_SENSOR_VC_V);
    if (co_err == ESP_OK) {
        calibration_worker_needed = true;
        config_load_gas_r0("co", &s_co_dev.r0, &s_co_dev.calibrated);
        if (!s_co_dev.calibrated) {
            ESP_LOGW(TAG, "CO sensor not calibrated; send type:calibrate_co to calibrate");
        }
        register_command_handler_or_reboot("calibrate_co", handle_calibrate_co);
    } else {
        ESP_LOGW(TAG, "GM702B CO init failed (%s); CO unavailable", esp_err_to_name(co_err));
    }
#endif

#if SA_ENABLE_NO2_SENSOR
    esp_err_t no2_err =
        gm102b_init(&s_no2_dev, (adc_channel_t)SA_NO2_ADC_CHANNEL, SA_GAS_SENSOR_RL_OHM, SA_GAS_SENSOR_VC_V);
    if (no2_err == ESP_OK) {
        calibration_worker_needed = true;
        config_load_gas_r0("no2", &s_no2_dev.r0, &s_no2_dev.calibrated);
        if (!s_no2_dev.calibrated) {
            ESP_LOGW(TAG, "NO2 sensor not calibrated; send type:calibrate_no2 to calibrate");
        }
        register_command_handler_or_reboot("calibrate_no2", handle_calibrate_no2);
    } else {
        ESP_LOGW(TAG, "GM102B NO2 init failed (%s); NO2 unavailable", esp_err_to_name(no2_err));
    }
#endif

#if SA_ENABLE_CO_SENSOR || SA_ENABLE_NO2_SENSOR
    if (calibration_worker_needed) {
        esp_err_t err = calibration_task_start();
        if (err != ESP_OK) {
            reboot_after_boot_error("calibration_task_start", err);
        }
    }
#endif

    char resolved_id[18] = {0};

#if SA_INCIDENT_OFFLINE_BENCH
    /* Test-only local path: device identity still comes from the immutable
     * STA MAC, but no credential, BLE, Wi-Fi, HTTP, MQTT, or OTA dependency
     * is introduced before the production incident and replay tasks start. */
    esp_err_t device_id_err = config_get_device_id(resolved_id, sizeof(resolved_id));
    if (device_id_err != ESP_OK) {
        reboot_after_boot_error("config_get_device_id", device_id_err);
    }
#else
    /* 6 - Wi-Fi station (no connect yet) */
    init_wifi_stage();

    /* 7 - BLE provisioning on first boot */
    run_ble_provisioning_stage();

    /* 8 - Load stored credentials and connect Wi-Fi (skip if already connected via ble_prov) */
    char ssid[64] = {0};
    char password[64] = {0};
    load_wifi_credentials_stage(ssid, sizeof(ssid), password, sizeof(password));
    connect_wifi_stage(ssid, password);

    /* 9 - Resolve immutable device ID and runtime config */
    char broker_uri[128] = {0};
    char secret_key[64] = {0};
    load_runtime_config_stage(
        broker_uri, sizeof(broker_uri), resolved_id, sizeof(resolved_id), secret_key, sizeof(secret_key));

    /* 9.1 - Local provisioning HTTP API (must exist before first MQTT login) */
    start_http_server_stage(resolved_id);
#endif

#if SA_ENABLE_DS3231
    ensure_system_clock_seeded(rtc_err == ESP_OK);
#if SA_INCIDENT_OFFLINE_BENCH
    bool rtc_incident_time_valid = establish_rtc_incident_time_source(rtc_err == ESP_OK);
#else
    (void)establish_rtc_incident_time_source(rtc_err == ESP_OK);
    sync_time_from_sntp_stage(rtc_err == ESP_OK);
#endif
#else
    ensure_system_clock_seeded(false);
#if !SA_INCIDENT_OFFLINE_BENCH
    sync_time_from_sntp_stage(false);
#endif
#if SA_INCIDENT_OFFLINE_BENCH
    bool rtc_incident_time_valid = false;
#endif
#endif
    configure_local_timezone();

#if SA_INCIDENT_OFFLINE_BENCH
    if (rtc_incident_time_valid) {
        ESP_LOGI(INC_BENCH_TAG, "time source=DS3231");
    } else {
        ESP_LOGW(INC_BENCH_TAG, "no valid incident time source; signing cannot proceed");
    }
#else
    if (secret_key[0] == '\0') {
        display_service_set_boot_phase(DISPLAY_BOOT_PHASE_WAITING_CONFIG);
        ESP_LOGW(TAG, "MQTT secret_key not provisioned yet; waiting for local POST /api/config");
        s_boot_failure_count = 0;
        vTaskDelete(NULL);
    }
#endif

    /* 9.2 - Runtime control bootstrap (buzzer -> relay -> mode -> MQTT handlers) */
    init_runtime_control_stage(resolved_id);

#if SA_INCIDENT_OFFLINE_BENCH
    char signer_address[43] = {0};
    esp_err_t signer_err = incident_get_signer_address(signer_address);
    ESP_LOGI(INC_BENCH_TAG, "signer available=%s", signer_err == ESP_OK ? "yes" : "no");
    if (signer_err == ESP_OK) {
        ESP_LOGI(INC_BENCH_TAG, "signer address=%s", signer_address);
    } else {
        ESP_LOGW(INC_BENCH_TAG, "production signer unavailable; replay and local alarm will continue");
    }
    ESP_LOGW(INC_BENCH_TAG, "MQTT unavailable/offline; queued records retained");
#else
    /* 9.3 - Register time sync callback before mqtt_start to avoid race:
     *        broker may deliver a queued set_time command immediately on connect */
    mqtt_register_time_sync_cb(on_time_sync);
    mqtt_register_shadow_sync_cb(handle_shadow_get_response);
    mqtt_register_incident_ack_cb(incident_handle_ack);

    /* 9.4 - Start MQTT */
    start_mqtt_stage(broker_uri, resolved_id, secret_key);

    /* 9.5 - OTA task */
    start_ota_stage(resolved_id);
#endif

    /* 10 - Sensor polling task (publishes telemetry every SA_SENSOR_POLLING_INTERVAL ms) */
#if SA_DEMO_NO_PERIPHERALS
    ESP_ERROR_CHECK(sensor_task_start(NULL, NULL, NULL, NULL, resolved_id));
#elif SA_ENABLE_SHT3X || SA_ENABLE_DS3231 || SA_ENABLE_CO_SENSOR || SA_ENABLE_NO2_SENSOR
    {
        bool any_ok = false;
        sht3x_t *sht_ptr = NULL;
        ds3231_t *rtc_ptr = NULL;
        gm702b_t *co_ptr = NULL;
        gm102b_t *no2_ptr = NULL;
#if SA_ENABLE_SHT3X
        if (sht_err == ESP_OK) {
            any_ok = true;
            sht_ptr = &s_sht3x_dev;
        }
#endif
#if SA_ENABLE_DS3231
        if (rtc_err == ESP_OK) {
            any_ok = true;
            rtc_ptr = &s_ds3231_dev;
        }
#endif
#if SA_ENABLE_CO_SENSOR
        if (co_err == ESP_OK) {
            any_ok = true;
            co_ptr = &s_co_dev;
        }
#endif
#if SA_ENABLE_NO2_SENSOR
        if (no2_err == ESP_OK) {
            any_ok = true;
            no2_ptr = &s_no2_dev;
        }
#endif
        if (any_ok) {
            ESP_ERROR_CHECK(sensor_task_start(sht_ptr, rtc_ptr, co_ptr, no2_ptr, resolved_id));
        } else {
            ESP_LOGW(TAG, "All enabled sensors failed init; sensor_task not started");
        }
    }
#else
    ESP_LOGI(TAG, "No sensors enabled; sensor_task not started");
#endif

    /* 10b - On-device CO/NO2 early warning; a model/PSRAM failure only disables
     * the model this boot (the QCVN rule keeps running). */
    esp_err_t ai_err = ai_start(resolved_id);
    if (ai_err != ESP_OK) {
        ESP_LOGW(TAG, "ai_start failed: %s; continuing without on-device AI", esp_err_to_name(ai_err));
    }
#if SA_ENABLE_AI
#if !SA_INCIDENT_OFFLINE_BENCH
    register_command_handler_or_reboot("ai_set", handle_ai_set);
#endif
#endif

    /* 11 - Validate OTA firmware after all subsystems are running (SEC-03) */
    ota_validate_and_commit();

    display_service_set_boot_phase(DISPLAY_BOOT_PHASE_READY);
    s_boot_failure_count = 0;
    vTaskDelete(NULL);
}

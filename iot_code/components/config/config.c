/**
 * @file config.c
 *
 * @brief NVS credential read/write API for Wi-Fi and MQTT configuration.
 *
 * Copyright (C) 2026 MinhNhat & BaoViet
 */

#include "config.h"

#include "nvs.h"
#include "nvs_flash.h"
#include "esp_log.h"
#include "esp_mac.h"

#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

#include <ctype.h>
#include <math.h>
#include <string.h>

static const char *TAG = "config";

static StaticSemaphore_t s_nvs_write_lock_buf;
static SemaphoreHandle_t s_nvs_write_lock;
static portMUX_TYPE s_guard_mux = portMUX_INITIALIZER_UNLOCKED;
static volatile bool s_factory_reset_in_progress = false;

/* Private namespace / key constants */

/* Device / MQTT namespace */
#define NS_DEVICE      SA_NVS_DEVICE_NAMESPACE
#define KEY_DEVICE_ID  "device_id"  /* 9 chars */
#define KEY_SECRET_KEY "secret_key" /* 10 chars */
#define KEY_BROKER_URI "broker_uri" /* 10 chars */

/* Gas sensor R0 NVS keys (partition SA_NVS_CALIB_PARTITION, namespace NS_GAS_CALIB) */
#define NS_GAS_CALIB "gas_calib"
#define KEY_R0_CO    "r0_co"
#define KEY_R0_NO2   "r0_no2"
#define KEY_CALIB_REV "revision"

static bool is_mac_format(const char *input);
static bool copy_lowercase_mac(const char *input, char *out, size_t out_len);
static esp_err_t copy_device_mac(char *out, size_t out_len);
static bool is_supported_broker_uri(const char *broker_uri);
static SemaphoreHandle_t ensure_nvs_write_lock(void);
static esp_err_t config_nvs_read_begin(void);
static void config_nvs_read_end(void);

/* MQTT / device credential API */

static SemaphoreHandle_t ensure_nvs_write_lock(void)
{
    if (s_nvs_write_lock != NULL) {
        return s_nvs_write_lock;
    }

    portENTER_CRITICAL(&s_guard_mux);
    if (s_nvs_write_lock == NULL) {
        s_nvs_write_lock = xSemaphoreCreateMutexStatic(&s_nvs_write_lock_buf);
    }
    portEXIT_CRITICAL(&s_guard_mux);
    return s_nvs_write_lock;
}

static esp_err_t config_nvs_read_begin(void)
{
    SemaphoreHandle_t lock = ensure_nvs_write_lock();
    if (lock == NULL) {
        return ESP_ERR_NO_MEM;
    }

    if (s_factory_reset_in_progress) {
        return ESP_ERR_INVALID_STATE;
    }

    if (xSemaphoreTake(lock, portMAX_DELAY) != pdTRUE) {
        return ESP_FAIL;
    }

    if (s_factory_reset_in_progress) {
        xSemaphoreGive(lock);
        return ESP_ERR_INVALID_STATE;
    }

    return ESP_OK;
}

static void config_nvs_read_end(void)
{
    if (s_nvs_write_lock != NULL) {
        xSemaphoreGive(s_nvs_write_lock);
    }
}

esp_err_t config_nvs_write_begin(void)
{
    SemaphoreHandle_t lock = ensure_nvs_write_lock();
    if (lock == NULL) {
        return ESP_ERR_NO_MEM;
    }

    if (s_factory_reset_in_progress) {
        return ESP_ERR_INVALID_STATE;
    }

    if (xSemaphoreTake(lock, portMAX_DELAY) != pdTRUE) {
        portENTER_CRITICAL(&s_guard_mux);
        s_factory_reset_in_progress = false;
        portEXIT_CRITICAL(&s_guard_mux);
        return ESP_FAIL;
    }

    if (s_factory_reset_in_progress) {
        xSemaphoreGive(lock);
        return ESP_ERR_INVALID_STATE;
    }

    return ESP_OK;
}

void config_nvs_write_end(void)
{
    if (s_nvs_write_lock != NULL) {
        xSemaphoreGive(s_nvs_write_lock);
    }
}

bool config_factory_reset_in_progress(void)
{
    return s_factory_reset_in_progress;
}

esp_err_t config_factory_reset_begin(void)
{
    SemaphoreHandle_t lock = ensure_nvs_write_lock();
    if (lock == NULL) {
        return ESP_ERR_NO_MEM;
    }

    portENTER_CRITICAL(&s_guard_mux);
    s_factory_reset_in_progress = true;
    portEXIT_CRITICAL(&s_guard_mux);

    if (xSemaphoreTake(lock, portMAX_DELAY) != pdTRUE) {
        return ESP_FAIL;
    }

    return ESP_OK;
}

void config_factory_reset_end(void)
{
    portENTER_CRITICAL(&s_guard_mux);
    s_factory_reset_in_progress = false;
    portEXIT_CRITICAL(&s_guard_mux);

    if (s_nvs_write_lock != NULL) {
        xSemaphoreGive(s_nvs_write_lock);
    }
}

static esp_err_t erase_namespace(const char *namespace_name)
{
    nvs_handle_t h;
    esp_err_t err = nvs_open(namespace_name, NVS_READWRITE, &h);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "factory reset open(%s) failed: %s", namespace_name, esp_err_to_name(err));
        return err;
    }

    err = nvs_erase_all(h);
    if (err == ESP_OK) {
        err = nvs_commit(h);
    }
    nvs_close(h);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "factory reset erase(%s) failed: %s", namespace_name, esp_err_to_name(err));
    }
    return err;
}

esp_err_t config_factory_reset_erase_provisioning(void)
{
    if (!s_factory_reset_in_progress) {
        return ESP_ERR_INVALID_STATE;
    }

    esp_err_t err = erase_namespace(SA_NVS_WIFI_NAMESPACE);
    if (err != ESP_OK) {
        return err;
    }
    return erase_namespace(SA_NVS_DEVICE_NAMESPACE);
}

esp_err_t config_get_mqtt_creds(char *broker_uri_buf, size_t broker_uri_len, char *secret_key_buf, size_t secret_key_len)
{
    esp_err_t guard_err = config_nvs_read_begin();
    if (guard_err != ESP_OK) {
        return guard_err;
    }

    nvs_handle_t h;
    esp_err_t err = nvs_open(NS_DEVICE, NVS_READONLY, &h);
    if (err != ESP_OK && err != ESP_ERR_NVS_NOT_FOUND) {
        ESP_LOGE(TAG, "nvs_open(%s) failed: %s", NS_DEVICE, esp_err_to_name(err));
        config_nvs_read_end();
        return err;
    }

    /* broker_uri: prefer NVS, then fall back to Kconfig. */
    if (err == ESP_OK) {
        esp_err_t r = nvs_get_str(h, KEY_BROKER_URI, broker_uri_buf, &broker_uri_len);
        if (r == ESP_ERR_NVS_NOT_FOUND) {
            strlcpy(broker_uri_buf, SA_MQTT_BROKER_URI, broker_uri_len);
            ESP_LOGI(TAG, "broker_uri using Kconfig default: %s", broker_uri_buf);
        } else if (r != ESP_OK) {
            ESP_LOGE(TAG, "read broker_uri failed: %s", esp_err_to_name(r));
            nvs_close(h);
            config_nvs_read_end();
            return r;
        } else {
            ESP_LOGI(TAG, "broker_uri loaded from NVS: %s", broker_uri_buf);
        }
    } else {
        strlcpy(broker_uri_buf, SA_MQTT_BROKER_URI, broker_uri_len);
        ESP_LOGI(TAG, "broker_uri using Kconfig default: %s", broker_uri_buf);
    }

    /* secret_key: prefer NVS, then fall back to Kconfig. */
    if (err == ESP_OK) {
        esp_err_t r = nvs_get_str(h, KEY_SECRET_KEY, secret_key_buf, &secret_key_len);
        if (r == ESP_ERR_NVS_NOT_FOUND) {
            strlcpy(secret_key_buf, SA_MQTT_SECRET_KEY, secret_key_len);
        } else if (r != ESP_OK) {
            ESP_LOGE(TAG, "read secret_key failed: %s", esp_err_to_name(r));
            nvs_close(h);
            config_nvs_read_end();
            return r;
        }
    } else {
        strlcpy(secret_key_buf, SA_MQTT_SECRET_KEY, secret_key_len);
    }

    if (err == ESP_OK) {
        nvs_close(h);
    }
    config_nvs_read_end();
    return ESP_OK;
}

esp_err_t config_get_device_id(char *out, size_t out_len)
{
    return copy_device_mac(out, out_len);
}

esp_err_t config_set_mqtt_config(const char *broker_uri, const char *device_id, const char *secret_key)
{
    char actual_device_id[18] = {0};
    char normalized_device_id[18] = {0};
    if (!is_mac_format(device_id) ||
        !copy_lowercase_mac(device_id, normalized_device_id, sizeof(normalized_device_id)) ||
        copy_device_mac(actual_device_id, sizeof(actual_device_id)) != ESP_OK ||
        strcmp(normalized_device_id, actual_device_id) != 0 || secret_key == NULL || secret_key[0] == '\0') {
        return ESP_ERR_INVALID_ARG;
    }
    if (!is_supported_broker_uri(broker_uri)) {
        return ESP_ERR_INVALID_ARG;
    }

    esp_err_t guard_err = config_nvs_write_begin();
    if (guard_err != ESP_OK) {
        return guard_err;
    }

    nvs_handle_t h;
    esp_err_t err = nvs_open(NS_DEVICE, NVS_READWRITE, &h);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "nvs_open(%s) failed: %s", NS_DEVICE, esp_err_to_name(err));
        config_nvs_write_end();
        return err;
    }

    if (broker_uri != NULL && broker_uri[0] != '\0') {
        err = nvs_set_str(h, KEY_BROKER_URI, broker_uri);
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "set broker_uri failed: %s", esp_err_to_name(err));
            nvs_close(h);
            config_nvs_write_end();
            return err;
        }
    } else {
        err = nvs_erase_key(h, KEY_BROKER_URI);
        if (err != ESP_OK && err != ESP_ERR_NVS_NOT_FOUND) {
            ESP_LOGE(TAG, "clear broker_uri failed: %s", esp_err_to_name(err));
            nvs_close(h);
            config_nvs_write_end();
            return err;
        }
    }

    err = nvs_erase_key(h, KEY_DEVICE_ID);
    if (err != ESP_OK && err != ESP_ERR_NVS_NOT_FOUND) {
        ESP_LOGE(TAG, "erase legacy device_id failed: %s", esp_err_to_name(err));
        nvs_close(h);
        config_nvs_write_end();
        return err;
    }

    err = nvs_set_str(h, KEY_SECRET_KEY, secret_key);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "set secret_key failed: %s", esp_err_to_name(err));
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

/* Device ID resolution */

static bool is_hex_nibble(char c)
{
    return isxdigit((unsigned char)c) != 0;
}

static bool is_mac_format(const char *input)
{
    if (input == NULL || strlen(input) != 17) {
        return false;
    }

    for (size_t i = 0; i < 17; i++) {
        if (i == 2 || i == 5 || i == 8 || i == 11 || i == 14) {
            if (input[i] != ':') {
                return false;
            }
            continue;
        }

        if (!is_hex_nibble(input[i])) {
            return false;
        }
    }

    return true;
}

static bool copy_lowercase_mac(const char *input, char *out, size_t out_len)
{
    if (input == NULL || out == NULL || out_len < 18 || strlen(input) != 17) {
        return false;
    }

    for (size_t i = 0; i < 17; i++) {
        out[i] = (char)tolower((unsigned char)input[i]);
    }
    out[17] = '\0';
    return true;
}

static esp_err_t copy_device_mac(char *out, size_t out_len)
{
    if (out == NULL || out_len < 18) {
        return ESP_ERR_INVALID_ARG;
    }

    uint8_t mac[6] = {0};
    esp_read_mac(mac, ESP_MAC_WIFI_STA);
    snprintf(out, out_len, "%02x:%02x:%02x:%02x:%02x:%02x", mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
    return ESP_OK;
}

static bool is_supported_broker_uri(const char *broker_uri)
{
    if (broker_uri == NULL || broker_uri[0] == '\0') {
        return true;
    }

    return strncmp(broker_uri, "mqtts://", 8) == 0 || strncmp(broker_uri, "wss://", 6) == 0;
}

/* Gas sensor R0 persistence */

esp_err_t config_load_gas_r0(const char *sensor_name, float *r0, bool *calibrated)
{
    *r0 = 0.0f;
    *calibrated = false;

    const char *key = (sensor_name[0] == 'c') ? KEY_R0_CO : KEY_R0_NO2;

    esp_err_t guard_err = config_nvs_read_begin();
    if (guard_err != ESP_OK) {
        return guard_err;
    }

    nvs_handle_t h;
    esp_err_t err = nvs_open_from_partition(SA_NVS_CALIB_PARTITION, NS_GAS_CALIB, NVS_READONLY, &h);
    if (err == ESP_ERR_NVS_NOT_FOUND) {
        config_nvs_read_end();
        return ESP_OK; /* namespace not yet created; not calibrated */
    }
    if (err != ESP_OK) {
        ESP_LOGE(TAG,
                 "load_gas_r0(%s): nvs_open_from_partition(%s) failed: %s",
                 sensor_name,
                 SA_NVS_CALIB_PARTITION,
                 esp_err_to_name(err));
        config_nvs_read_end();
        return err;
    }

    size_t len = sizeof(float);
    err = nvs_get_blob(h, key, r0, &len);
    nvs_close(h);
    config_nvs_read_end();

    if (err == ESP_OK && len == sizeof(float) && *r0 > 0.0f) {
        *calibrated = true;
        ESP_LOGI(TAG, "load_gas_r0(%s): R0 = %.0f ohm", sensor_name, *r0);
    } else if (err == ESP_ERR_NVS_NOT_FOUND) {
        return ESP_OK; /* not calibrated yet; not an error */
    } else if (err != ESP_OK) {
        ESP_LOGE(TAG, "load_gas_r0(%s): nvs_get_blob failed: %s", sensor_name, esp_err_to_name(err));
        return err;
    }

    return ESP_OK;
}

esp_err_t config_save_gas_r0(const char *sensor_name, float r0)
{
    const char *key = (sensor_name[0] == 'c') ? KEY_R0_CO : KEY_R0_NO2;

    esp_err_t guard_err = config_nvs_write_begin();
    if (guard_err != ESP_OK) {
        return guard_err;
    }

    nvs_handle_t h;
    esp_err_t err = nvs_open_from_partition(SA_NVS_CALIB_PARTITION, NS_GAS_CALIB, NVS_READWRITE, &h);
    if (err != ESP_OK) {
        ESP_LOGE(TAG,
                 "save_gas_r0(%s): nvs_open_from_partition(%s) failed: %s",
                 sensor_name,
                 SA_NVS_CALIB_PARTITION,
                 esp_err_to_name(err));
        config_nvs_write_end();
        return err;
    }

    uint32_t revision = 0;
    if (nvs_get_u32(h, KEY_CALIB_REV, &revision) == ESP_ERR_NVS_NOT_FOUND) {
        revision = 0; /* migration: existing R0-only records remain revision 0 until next save */
    }
    if (revision == UINT32_MAX) {
        nvs_close(h);
        config_nvs_write_end();
        return ESP_ERR_INVALID_STATE;
    }

    err = nvs_set_blob(h, key, &r0, sizeof(float));
    if (err == ESP_OK) {
        err = nvs_set_u32(h, KEY_CALIB_REV, revision + 1);
    }
    if (err == ESP_OK) {
        err = nvs_commit(h);
    }
    nvs_close(h);
    config_nvs_write_end();

    if (err == ESP_OK) {
        ESP_LOGI(TAG, "save_gas_r0(%s): R0 = %.0f ohm saved", sensor_name, r0);
    } else {
        ESP_LOGE(TAG, "save_gas_r0(%s): write failed: %s", sensor_name, esp_err_to_name(err));
    }
    return err;
}

esp_err_t config_get_gas_calibration_snapshot(int64_t *co_r0_q10000,
                                              int64_t *no2_r0_q10000,
                                              uint32_t *revision)
{
    if (co_r0_q10000 == NULL || no2_r0_q10000 == NULL || revision == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    *co_r0_q10000 = 0;
    *no2_r0_q10000 = 0;
    *revision = 0;

    esp_err_t guard_err = config_nvs_read_begin();
    if (guard_err != ESP_OK) {
        return guard_err;
    }
    nvs_handle_t h;
    esp_err_t err = nvs_open_from_partition(SA_NVS_CALIB_PARTITION, NS_GAS_CALIB, NVS_READONLY, &h);
    if (err == ESP_ERR_NVS_NOT_FOUND) {
        config_nvs_read_end();
        return ESP_OK;
    }
    if (err != ESP_OK) {
        config_nvs_read_end();
        return err;
    }

    float co = 0.0f, no2 = 0.0f;
    size_t co_len = sizeof(co), no2_len = sizeof(no2);
    esp_err_t co_err = nvs_get_blob(h, KEY_R0_CO, &co, &co_len);
    esp_err_t no2_err = nvs_get_blob(h, KEY_R0_NO2, &no2, &no2_len);
    esp_err_t rev_err = nvs_get_u32(h, KEY_CALIB_REV, revision);
    if (rev_err == ESP_ERR_NVS_NOT_FOUND) {
        *revision = 0;
    } else if (rev_err != ESP_OK) {
        nvs_close(h);
        config_nvs_read_end();
        return rev_err;
    }
    nvs_close(h);
    config_nvs_read_end();

    if (co_err != ESP_OK && co_err != ESP_ERR_NVS_NOT_FOUND) return co_err;
    if (no2_err != ESP_OK && no2_err != ESP_ERR_NVS_NOT_FOUND) return no2_err;
    if (co_err == ESP_OK && co_len == sizeof(co) && isfinite(co) && co > 0.0f) {
        *co_r0_q10000 = (int64_t)llround((double)co * 10000.0);
    }
    if (no2_err == ESP_OK && no2_len == sizeof(no2) && isfinite(no2) && no2 > 0.0f) {
        *no2_r0_q10000 = (int64_t)llround((double)no2 * 10000.0);
    }
    return ESP_OK;
}

/* Self-test (enabled only when SA_CONFIG_SELF_TEST=y) */

#ifdef CONFIG_SA_CONFIG_SELF_TEST
void config_self_test(void)
{
    ESP_LOGI(TAG, "Self-test: start");

    /* Use a dedicated test namespace to avoid polluting production data */
    const char *NS_TEST = "config_test";
    const char *TEST_BROKER = "wss://minhnhat05.xyz/mqtt";
    const char *TEST_SECRET = "test-secret-99";

    /* --- Write --- */
    esp_err_t guard_err = config_nvs_write_begin();
    if (guard_err != ESP_OK) {
        ESP_LOGE(TAG, "Self-test FAIL: nvs write lock: %s", esp_err_to_name(guard_err));
        return;
    }
    nvs_handle_t h;
    esp_err_t err = nvs_open(NS_TEST, NVS_READWRITE, &h);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Self-test FAIL: nvs_open: %s", esp_err_to_name(err));
        config_nvs_write_end();
        return;
    }
    nvs_set_str(h, KEY_BROKER_URI, TEST_BROKER);
    nvs_set_str(h, KEY_SECRET_KEY, TEST_SECRET);
    nvs_commit(h);
    nvs_close(h);
    config_nvs_write_end();

    /* --- Read back --- */
    char broker_buf[128] = {0};
    char secret_buf[64] = {0};
    size_t broker_len = sizeof(broker_buf);
    size_t secret_len = sizeof(secret_buf);

    err = nvs_open(NS_TEST, NVS_READONLY, &h);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Self-test FAIL: nvs_open for read: %s", esp_err_to_name(err));
        return;
    }
    nvs_get_str(h, KEY_BROKER_URI, broker_buf, &broker_len);
    nvs_get_str(h, KEY_SECRET_KEY, secret_buf, &secret_len);
    nvs_close(h);

    /* --- Verify --- */
    bool pass = (strcmp(broker_buf, TEST_BROKER) == 0) && (strcmp(secret_buf, TEST_SECRET) == 0);
    if (pass) {
        ESP_LOGI(TAG, "Self-test PASS");
    } else {
        ESP_LOGE(TAG, "Self-test FAIL: got broker='%s' secret='%s'", broker_buf, secret_buf);
    }

    /* --- Erase test namespace --- */
    guard_err = config_nvs_write_begin();
    if (guard_err != ESP_OK) {
        ESP_LOGE(TAG, "Self-test FAIL: nvs erase lock: %s", esp_err_to_name(guard_err));
        return;
    }
    err = nvs_open(NS_TEST, NVS_READWRITE, &h);
    if (err == ESP_OK) {
        nvs_erase_all(h);
        nvs_commit(h);
        nvs_close(h);
    }
    config_nvs_write_end();
}
#endif /* CONFIG_SA_CONFIG_SELF_TEST */

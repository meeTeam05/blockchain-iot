/**
 * @file adc_bus.c
 * 
 * @brief Shared ADC1 oneshot bus implementation.
 * 
 * Copyright (C) 2026 MinhNhat & BaoViet
 */

#include "adc_bus.h"

#include <string.h>
#include <esp_log.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>

static const char *TAG = "adc_bus";

static adc_oneshot_unit_handle_t s_adc_handle = NULL;
static adc_cali_handle_t s_cali_handle = NULL;
static SemaphoreHandle_t s_mutex = NULL;

static void adc_bus_cleanup_init_failure(void)
{
    if (s_adc_handle) {
        adc_oneshot_del_unit(s_adc_handle);
        s_adc_handle = NULL;
    }
    if (s_mutex) {
        vSemaphoreDelete(s_mutex);
        s_mutex = NULL;
    }
}

/* Error-handling macros (same pattern as i2c_bus) */

#define CHECK(x)                                                                     \
    do {                                                                             \
        esp_err_t __err = (x);                                                       \
        if (__err != ESP_OK) {                                                       \
            ESP_LOGE(TAG, "%s:%d (%s)", __FILE__, __LINE__, esp_err_to_name(__err)); \
            return __err;                                                            \
        }                                                                            \
    } while (0)

#define CHECK_ARG(VAL)                                                   \
    do {                                                                 \
        if (!(VAL)) {                                                    \
            ESP_LOGE(TAG, "%s:%d invalid argument", __FILE__, __LINE__); \
            return ESP_ERR_INVALID_ARG;                                  \
        }                                                                \
    } while (0)

/* Public API */

esp_err_t adc_bus_init(void)
{
    if (s_adc_handle) {
        ESP_LOGW(TAG, "ADC1 already initialized");
        return ESP_OK;
    }

    /* Create mutex for thread-safe reads */
    s_mutex = xSemaphoreCreateMutex();
    if (!s_mutex) {
        ESP_LOGE(TAG, "Failed to create mutex");
        return ESP_ERR_NO_MEM;
    }

    /* Initialize ADC1 oneshot unit */
    adc_oneshot_unit_init_cfg_t unit_cfg = {
        .unit_id = ADC_UNIT_1,
        .ulp_mode = ADC_ULP_MODE_DISABLE,
    };
    esp_err_t err = adc_oneshot_new_unit(&unit_cfg, &s_adc_handle);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "%s:%d (%s)", __FILE__, __LINE__, esp_err_to_name(err));
        adc_bus_cleanup_init_failure();
        return err;
    }

    /* Initialize calibration (curve fitting for ESP32-S3) */
    adc_cali_curve_fitting_config_t cali_cfg = {
        .unit_id = ADC_UNIT_1,
        .atten = ADC_ATTEN_DB_12,
        .bitwidth = ADC_BITWIDTH_12,
    };
    esp_err_t cali_err = adc_cali_create_scheme_curve_fitting(&cali_cfg, &s_cali_handle);
    if (cali_err != ESP_OK) {
        ESP_LOGW(TAG, "ADC calibration not available (%s); raw values only", esp_err_to_name(cali_err));
        s_cali_handle = NULL;
    }

    ESP_LOGI(TAG, "ADC1 initialized (12-bit, curve-fitting calibration %s)", s_cali_handle ? "enabled" : "disabled");
    return ESP_OK;
}

esp_err_t adc_bus_config_channel(adc_channel_t channel, adc_atten_t atten)
{
    CHECK_ARG(s_adc_handle);

    adc_oneshot_chan_cfg_t chan_cfg = {
        .atten = atten,
        .bitwidth = ADC_BITWIDTH_12,
    };
    CHECK(adc_oneshot_config_channel(s_adc_handle, channel, &chan_cfg));

    ESP_LOGI(TAG, "ADC1 channel %d configured (atten=%d)", (int)channel, (int)atten);
    return ESP_OK;
}

esp_err_t adc_bus_read_raw(adc_channel_t channel, int *raw)
{
    CHECK_ARG(s_adc_handle && raw);

    if (xSemaphoreTake(s_mutex, pdMS_TO_TICKS(100)) != pdTRUE) {
        ESP_LOGW(TAG, "ADC mutex timeout");
        return ESP_ERR_TIMEOUT;
    }

    esp_err_t err = adc_oneshot_read(s_adc_handle, channel, raw);

    xSemaphoreGive(s_mutex);
    return err;
}

esp_err_t adc_bus_read_voltage(adc_channel_t channel, int *voltage_mv)
{
    CHECK_ARG(voltage_mv);

    int raw;
    CHECK(adc_bus_read_raw(channel, &raw));

    if (s_cali_handle) {
        return adc_cali_raw_to_voltage(s_cali_handle, raw, voltage_mv);
    }

    /* Fallback: approximate mV from raw (12-bit, 3.3V ref) */
    *voltage_mv = (int)((float)raw / 4095.0f * 3300.0f);
    return ESP_OK;
}

esp_err_t adc_bus_deinit(void)
{
    if (s_cali_handle) {
        adc_cali_delete_scheme_curve_fitting(s_cali_handle);
        s_cali_handle = NULL;
    }
    if (s_adc_handle) {
        adc_oneshot_del_unit(s_adc_handle);
        s_adc_handle = NULL;
    }
    if (s_mutex) {
        vSemaphoreDelete(s_mutex);
        s_mutex = NULL;
    }

    ESP_LOGI(TAG, "ADC1 deinitialized");
    return ESP_OK;
}

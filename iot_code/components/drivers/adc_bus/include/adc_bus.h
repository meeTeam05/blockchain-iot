/**
 * @file adc_bus.h
 * 
 * @brief Shared ADC1 oneshot bus, similar to i2c_bus for I2C devices.
 *
 * Copyright (C) 2026 MinhNhat & BaoViet
 * 
 * Manages a single ADC1 unit handle shared by all analog sensor drivers.
 * Thread-safe: multiple tasks can read different channels concurrently.
 *
 * ADC1 only. ADC2 is unavailable when WiFi is active on ESP32-S3.
 * 
 */
#pragma once

#include <esp_err.h>
#include <esp_adc/adc_oneshot.h>
#include <esp_adc/adc_cali.h>

/**
 * @brief Initialize ADC1 unit. Call once at boot before any sensor init.
 * 
 * @return ESP_OK on success, or an error code on failure.
 */
esp_err_t adc_bus_init(void);

/**
 * @brief Configure a channel on the shared ADC1 unit.
 *
 * @param channel ADC1 channel (ADC_CHANNEL_0 .. ADC_CHANNEL_9)
 * @param atten   Attenuation (ADC_ATTEN_DB_12 for 0-3.3V range)
 * 
 * @return ESP_OK on success, or an error code on failure.
 */
esp_err_t adc_bus_config_channel(adc_channel_t channel, adc_atten_t atten);

/**
 * @brief Read raw ADC value (0-4095 at 12-bit).
 */
esp_err_t adc_bus_read_raw(adc_channel_t channel, int *raw);

/**
 * @brief Read calibrated voltage in millivolts.
 * 
 * @return ESP_OK on success, or an error code on failure.
 */
esp_err_t adc_bus_read_voltage(adc_channel_t channel, int *voltage_mv);

/**
 * @brief Deinitialize ADC1 unit.
 * 
 * @return ESP_OK on success, or an error code on failure.
 */
esp_err_t adc_bus_deinit(void);

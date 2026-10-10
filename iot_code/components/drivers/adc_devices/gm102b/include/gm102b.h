/**
 * @file gm102b.h
 * 
 * @brief Winsen GM-102B MEMS NO2 Gas Sensor driver (analog ADC).
 * 
 * Copyright (C) 2026 MinhNhat & BaoViet
 *
 * DFRobot SEN0574 breakout board. Heater circuit managed by board.
 * ESP32 reads analog output via ADC1 -> converts voltage to NO2 ppm.
 *
 * Detection range: 0.1-10 ppm NO2.
 * Preheat required: ≥24h first use.
 */
#pragma once

#include <stdbool.h>
#include <esp_err.h>
#include <esp_adc/adc_oneshot.h>

#define GM102B_NO2_PPM_MIN 0.1f
#define GM102B_NO2_PPM_MAX 10.0f

typedef struct {
    adc_channel_t channel; /**< ADC1 channel */
    float r0;              /**< Baseline resistance in clean air (ohm) */
    float rl;              /**< Load resistor on breakout board (ohm) */
    float vc;              /**< Circuit voltage (V) */
    bool calibrated;       /**< true after successful calibration */
} gm102b_t;

/**
 * @brief Initialize NO2 sensor on a given ADC1 channel.
 *
 * @param dev     Device descriptor (caller-allocated)
 * @param channel ADC1 channel (e.g. ADC_CHANNEL_1 for GPIO 2)
 * @param rl      Load resistor value in ohm (typically 10000)
 * @param vc      Circuit voltage in V (typically 3.3)
 * 
 * @return ESP_OK on success, or an error code on failure.
 */
esp_err_t gm102b_init(gm102b_t *dev, adc_channel_t channel, float rl, float vc);

/**
 * @brief Calibrate R0 baseline in clean air.
 * 
 * @param dev Device descriptor (must be initialized)
 * 
 * @return ESP_OK on success, or an error code on failure.
 *
 * @note Call after preheat (≥24h). Takes multiple samples and averages.
 *       Must be called in clean air environment.
 */
esp_err_t gm102b_calibrate(gm102b_t *dev);

/**
 * @brief Read NO2 concentration in ppm.
 *
 * @param dev     Device descriptor (must be calibrated)
 * @param no2_ppm Output: NO2 concentration in ppm
 * 
 * @return ESP_OK on success, or ESP_ERR_INVALID_STATE when the sensor is not calibrated.
 */
esp_err_t gm102b_read(gm102b_t *dev, float *no2_ppm);

/**
 * @brief Read raw Rs/R0 ratio (for debugging).
 * 
 * @param dev   Device descriptor (must be calibrated)
 * @param ratio Output: Rs/R0 ratio (unitless)
 * 
 * @return ESP_OK on success, or an error code on failure.
 */
esp_err_t gm102b_read_ratio(gm102b_t *dev, float *ratio);

/**
 * @brief Read raw ADC voltage in millivolts.
 * 
 * @param dev         Device descriptor (must be initialized)
 * @param voltage_mv  Output: measured voltage in millivolts
 * 
 * @return ESP_OK on success, or an error code on failure.
 */
esp_err_t gm102b_read_voltage(gm102b_t *dev, int *voltage_mv);

/**
 * @file gm702b.h
 * 
 * @brief Winsen GM-702B MEMS CO Gas Sensor driver (analog ADC).
 * 
 * Copyright (C) 2026 MinhNhat & BaoViet
 *
 * DFRobot SEN0564 breakout board. Heater circuit managed by board.
 * ESP32 reads analog output via ADC1 and converts voltage to CO ppm.
 *
 * Detection range: 5-5000 ppm CO.
 * Preheat required: ≥24h first use.
 */
#pragma once

#include <stdbool.h>
#include <esp_err.h>
#include <esp_adc/adc_oneshot.h>

#define GM702B_CO_PPM_MIN 5.0f
#define GM702B_CO_PPM_MAX 5000.0f

typedef struct {
    adc_channel_t channel; /**< ADC1 channel */
    float r0;              /**< Baseline resistance in clean air (ohm) */
    float rl;              /**< Load resistor on breakout board (ohm) */
    float vc;              /**< Circuit voltage (V) */
    bool calibrated;       /**< true after successful calibration */
} gm702b_t;

/**
 * @brief Initialize CO sensor on a given ADC1 channel.
 *
 * @param dev     Device descriptor (caller-allocated)
 * @param channel ADC1 channel (e.g. ADC_CHANNEL_0 for GPIO 1)
 * @param rl      Load resistor value in ohm (typically 10000)
 * @param vc      Circuit voltage in V (typically 3.3)
 */
esp_err_t gm702b_init(gm702b_t *dev, adc_channel_t channel, float rl, float vc);

/**
 * @brief Calibrate R0 baseline in clean air.
 *
 * Call after preheat (≥24h). Takes multiple samples and averages.
 * Must be called in clean air environment.
 *
 * @param dev Device descriptor
 */
esp_err_t gm702b_calibrate(gm702b_t *dev);

/**
 * @brief Read CO concentration in ppm.
 *
 * @param dev    Device descriptor (must be calibrated)
 * @param co_ppm Output: CO concentration in ppm
 *
 * @return ESP_OK on success, or ESP_ERR_INVALID_STATE when the sensor is not calibrated.
 */
esp_err_t gm702b_read(gm702b_t *dev, float *co_ppm);

/**
 * @brief Read raw Rs/R0 ratio (for debugging).
 */
esp_err_t gm702b_read_ratio(gm702b_t *dev, float *ratio);

/**
 * @brief Read raw ADC voltage in millivolts.
 */
esp_err_t gm702b_read_voltage(gm702b_t *dev, int *voltage_mv);

/**
 * @file device_mode.h
 * 
 * @brief Device mode management for the smart-air firmware runtime.
 * 
 * Copyright (C) 2026 MinhNhat & BaoViet
 */

#pragma once

#include "esp_err.h"

#include <stdbool.h>

/**
 * @brief Initialize device mode management with the given device ID.
 *
 * @param[in] device_id Lowercase device identifier used for telemetry/shadow topics.
 * 
 * @return ESP_OK on success, or an error code on failure.
 * 
 * @note This function must be called before any other device_mode API. 
 *       It loads the persisted mode state from NVS, updates the sensor task
 *       gate, and prepares MQTT topic strings for later mode/shadow publishes.
 */
esp_err_t device_mode_init(const char *device_id);

/**
 * @brief Set the device mode (on/off).
 *
 * @param[in] on True to enable normal runtime operation, false to stop it.
 * 
 * @return ESP_OK on success, or an error code on failure.
 * 
 * @note When turning off, this function performs the following steps:
 *       1. Disables the sensor task to stop telemetry updates.
 *       2. Publishes a final telemetry message with null values to indicate shutdown.
 *       3. Persists the new mode state to NVS for restoration on next boot.
 */
esp_err_t device_mode_set(bool on);

/**
 * @brief Publish the current full shadow snapshot for the active mode.
 *
 * @return ESP_OK on success, or an error code if shadow publish fails.
 */
esp_err_t device_mode_publish_current_shadow(void);

/** 
 * @brief Get the current device mode (on/off).
 * 
 * @return true if the device is in on mode, false otherwise.
 */
bool device_mode_get(void);

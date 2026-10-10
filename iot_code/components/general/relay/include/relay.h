/**
 * @file relay.h
 * 
 * @brief Relay control functions
 * 
 * Copyright (C) 2026 MinhNhat & BaoViet
 */

#pragma once

#include "esp_err.h"
#include <stdbool.h>

#define RELAY_CHANNEL_COUNT 3

/**
 * @brief Initialize the relay module.
 * 
 * @param device_id  Device identifier used for MQTT topic preparation.
 * 
 * @return ESP_OK on success, or an error code on failure.
 */
esp_err_t relay_init(const char *device_id);

/**
 * @brief Set the state of a relay channel.
 * 
 * @param channel  Relay channel number (1-based).
 * @param on       True to turn on, false to turn off.
 * 
 * @return ESP_OK on success, or an error code on failure.
 */
esp_err_t relay_set(int channel, bool on);

/**
 * @brief Get the state of a relay channel.
 * 
 * @param channel  Relay channel number (1-based).
 * @param on       Output parameter to receive the state (true for on, false for off
 * 
 * @return ESP_OK on success, or an error code on failure.
 */
esp_err_t relay_get(int channel, bool *on);

/** 
 * @brief Get the states of all relay channels.
 * 
 * @param states    Output array of size RELAY_CHANNEL_COUNT to receive the states.
 * 
 * @return ESP_OK on success, or an error code on failure.
 */
esp_err_t relay_get_all(bool states[RELAY_CHANNEL_COUNT]);

/**
 * @brief Force all relay channels to turn off.
 * 
 * @return ESP_OK if all channels were successfully turned off, 
 *         or the first error code encountered.
 */
esp_err_t relay_force_all_off(void);

/**
 * @brief Force all relay channels to turn off without buzzer feedback.
 *
 * @return ESP_OK if all channels were successfully turned off,
 *         or the first error code encountered.
 */
esp_err_t relay_force_all_off_silent(void);

/**
 * @file display_service.h
 *
 * @brief LVGL host for the optional ILI9225 display.
 *
 * Copyright (C) 2026 MinhNhat & BaoViet
 */

#pragma once

#include "esp_err.h"

#include <stdbool.h>
#include <stdint.h>

typedef enum {
    DISPLAY_BOOT_PHASE_BOOT = 0,
    DISPLAY_BOOT_PHASE_BLE,
    DISPLAY_BOOT_PHASE_WIFI,
    DISPLAY_BOOT_PHASE_WAITING_CONFIG,
    DISPLAY_BOOT_PHASE_MQTT,
    DISPLAY_BOOT_PHASE_READY,
} display_boot_phase_t;

typedef enum {
    DISPLAY_OTA_STAGE_IDLE = 0,
    DISPLAY_OTA_STAGE_STARTING,
    DISPLAY_OTA_STAGE_DOWNLOADING,
    DISPLAY_OTA_STAGE_VERIFYING,
    DISPLAY_OTA_STAGE_REBOOTING,
    DISPLAY_OTA_STAGE_FAILED,
} display_ota_stage_t;

typedef enum {
    DISPLAY_OTA_ERROR_NONE = 0,
    DISPLAY_OTA_ERROR_GENERIC,
    DISPLAY_OTA_ERROR_SHA256_MISMATCH,
    DISPLAY_OTA_ERROR_BUSY,
} display_ota_error_t;

typedef struct {
    bool active;
    uint8_t percent;
    display_ota_stage_t stage;
    display_ota_error_t error;
} display_ota_state_t;

typedef struct {
    bool have_temperature_humidity;
    float temperature_c;
    float humidity_pct;
    bool have_co;
    float co_ppm;
    bool have_no2;
    float no2_ppm;
    uint32_t timestamp;
} display_sensor_snapshot_t;

/**
 * @brief Initialize the display subsystem.
 *
 * Non-fatal by design: callers may continue booting headless if this returns an error.
 */
esp_err_t display_service_init(void);

/**
 * @brief Returns true when the display service finished initialization.
 */
bool display_service_is_ready(void);

/**
 * @brief Update the user-visible boot/runtime phase.
 *
 * Safe to call even when the display is disabled or not ready yet; such calls become no-ops.
 */
void display_service_set_boot_phase(display_boot_phase_t phase);

/**
 * @brief Update the user-visible device mode.
 */
void display_service_set_mode(bool on);

/**
 * @brief Update the user-visible relay state snapshot.
 *
 * @param relay_states Array of 3 relay states (relay_1..relay_3).
 */
void display_service_set_relay_states(const bool relay_states[3]);

/**
 * @brief Update the latest sensor snapshot shown by the runtime UI.
 */
void display_service_set_sensor_snapshot(const display_sensor_snapshot_t *snapshot);

/**
 * @brief Update the OTA display state.
 *
 * Safe to call even when the display is disabled or not ready yet; such calls become no-ops.
 */
void display_service_set_ota_state(const display_ota_state_t *state);

/**
 * @file factory_reset.h
 *
 * @brief Physical factory reset button monitor.
 *
 * Hold the configured GPIO button for SA_FACTORY_RESET_HOLD_MS (default 5 s)
 * to trigger a full factory reset. Releasing before the threshold cancels
 * with no side effects.
 *
 * Reset sequence:
 *   LED -> red static (ERROR)
 *   wifi_sta_deinit()  - clean WiFi shutdown
 *   mqtt_stop()        - destroy MQTT client
 *   erase default NVS partition while preserving calibration NVS partition
 *   esp_restart()
 *
 * After reboot the device enters BLE provisioning mode.
 *
 * Copyright (C) 2026 MinhNhat & BaoViet
 */

#pragma once

#include "driver/gpio.h"
#include "esp_err.h"

/**
 * @brief Run the shared full factory reset sequence.
 *
 * Stops Wi-Fi and MQTT, erases the default NVS partition, preserves
 * sensor-owned gas calibration, and reboots on success. The same routine is
 * used by both the physical reset button and boot-time recovery paths.
 *
 * @return ESP_OK if the reset was initiated successfully, or an ESP error.
 */
esp_err_t factory_reset_run(void);

/**
 * @brief Initialise the factory reset button monitor.
 *
 * Configures the GPIO as active-low input with internal pull-up and spawns
 * a lightweight polling task (50 ms interval, Core 1, Priority 4).
 *
 * Call early in sysload_init(), after led_init(), so the button works
 * during every phase of boot (BLE provisioning, WiFi connect, normal operation).
 *
 * @param gpio  GPIO number wired to the reset button (active-low).
 * @return ESP_OK on success, ESP_FAIL if task creation fails.
 */
esp_err_t factory_reset_init(gpio_num_t gpio);

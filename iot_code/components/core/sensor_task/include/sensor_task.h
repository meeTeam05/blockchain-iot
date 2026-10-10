/**
 * @file sensor_task.h
 *
 * @brief Sensor polling task for SHT3x, DS3231, GM-702B CO, and GM-102B NO2.
 *
 * Copyright (C) 2026 MinhNhat & BaoViet
 *
 * Architecture:
 *   - sensor_task_start() spawns sensor_task_fn (Core 1, Priority 5, 4096 B).
 *   - The device_id is passed in by the caller and used to build MQTT topics.
 *   - Every SA_SENSOR_POLLING_INTERVAL ms: read all sensors -> publish JSON to MQTT.
 *   - Any sensor pointer may be NULL (disabled/failed); that field reports null in JSON.
 */

#pragma once

#include "ds3231.h"
#include "esp_err.h"
#include "gm102b.h"
#include "gm702b.h"
#include "sht3x.h"

#include "config.h"

#include <stdbool.h>

/**
 * @brief Spawn sensor_task (Core 1, Priority 5, 4096 B stack).
 *
 * @param sht3x     Initialised SHT3x descriptor, or NULL.
 * @param ds3231    Initialised DS3231 descriptor, or NULL.
 * @param co        Initialised GM-702B CO descriptor, or NULL.
 * @param no2       Initialised GM-102B NO2 descriptor, or NULL.
 * @param device_id Resolved device identifier (used to build MQTT topics).
 *
 * @return ESP_OK if task created, ESP_ERR_INVALID_ARG when device_id is NULL or
 *         empty, ESP_FAIL otherwise.
 * 
 * @note Polls all passed sensors every SA_SENSOR_POLLING_INTERVAL ms and publishes
 *       telemetry JSON to device/{id}/telemetry via mqtt_publish().
 *       NULL pointers produce JSON null for that field.
 *       Timestamps fall back to time(NULL) when DS3231 is unavailable.
 *       Must be called after mqtt_start() returns.
 */
esp_err_t sensor_task_start(sht3x_t *sht3x, ds3231_t *ds3231, gm702b_t *co, gm102b_t *no2, const char *device_id);

/**
 * @brief Enable/disable sensor polling reads without deleting the task.
 *
 * @param enabled true to poll sensors (mode "on"), false to stop polling (mode "off").
 * 
 * @note This setter is idempotent: setting the current state is a no-op.
 */
void sensor_task_set_enabled(bool enabled);

/**
 * @brief Get current sensor task enabled state.
 *
 * @return true when sensor polling is enabled, false when disabled.
 */
bool sensor_task_get_enabled(void);

/**
 * @file ota.h
 *
 * @brief HTTPS OTA firmware update with MQTT trigger, progress reporting,
 *        local display status, rollback.
 *
 * Copyright (C) 2026 MinhNhat & BaoViet
 */

#pragma once

#include "esp_err.h"

/**
 * @brief Spawn ota_task (Core 1, Priority 3, 8192 B stack).
 *
 * @param device_id  Device identifier used to build the ota/progress topic.
 * 
 * @return ESP_OK on success, ESP_ERR_INVALID_STATE if already started,
 *         ESP_FAIL if queue/task creation fails.
 * 
 * @note The task waits for a trigger from ota_trigger(). Must be called after
 *       mqtt_start() so progress messages can be published.
 */
esp_err_t ota_task_start(const char *device_id);

/**
 * @brief Trigger an OTA download asynchronously.
 *
 * @param url     HTTPS URL to the firmware binary.
 * @param sha256  Expected SHA-256 hex string of the binary.
 * 
 * @return ESP_OK if queued, ESP_ERR_INVALID_ARG if URL is not https://.
 * 
 * @note Validates that url starts with "https://" (SEC-02), then sends {url, sha256}
 *       to the ota_task queue. Non-blocking. If a download is already in progress
 *       the trigger is silently dropped (queue depth = 1).
 */
esp_err_t ota_trigger(const char *url, const char *sha256);

/**
 * @brief Commit the running firmware if it is pending OTA verification.
 *
 * Call this after the system has proven itself functional (WiFi connected,
 * MQTT connected, sensors running). Satisfies SEC-03.
 *
 * If the running partition is not in PENDING_VERIFY state, this is a no-op.
 */
void ota_validate_and_commit(void);

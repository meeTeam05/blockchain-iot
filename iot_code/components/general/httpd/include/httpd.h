/**
 * @file httpd.h
 *
 * @brief HTTP API server for device monitoring.
 *
 * Registers:
 *   - GET /api/info
 *   - POST /api/config
 *
 * Copyright (C) 2026 MinhNhat & BaoViet
 */

#pragma once

#include "esp_err.h"

/**
 * @brief Start the HTTP API server.
 *
 * Must be called after Wi-Fi is connected (IP obtained).
 *
 * Endpoints registered:
 *   GET /api/info -> {"device_id":"...","firmware":"1.0.0","ip":"..."}
 *   POST /api/config -> store first MQTT credentials after validating
 *   device_id matches the real device MAC, then reboot.
 *
 * @param device_id  Device identifier (displayed in responses).
 * @param ip         Current IP address string (for /api/info response).
 * @return ESP_OK on success.
 */
esp_err_t httpd_server_start(const char *device_id, const char *ip);

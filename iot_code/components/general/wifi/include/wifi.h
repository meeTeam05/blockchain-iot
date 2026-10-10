/**
 * @file wifi.h
 * 
 * @brief Wi-Fi station header.
 * 
 * Copyright (C) 2026 MinhNhat & BaoViet
 */

#pragma once

#include "esp_err.h"
#include <stdbool.h>
#include <stddef.h>

/**
 * @brief Wi-Fi in station mode.
 * 
 * @return ESP_OK on success, or an error code.
 * 
 * @note Must be called AFTER esp_netif_init() and esp_event_loop_create_default().
 */
esp_err_t wifi_sta_init(void);

/**
 * @brief Connect to an access point.
 *
 * @param ssid        AP SSID (null-terminated)
 * @param password    AP password (null-terminated, empty string for open AP)
 * @param timeout_ms  Maximum wait in milliseconds
 * 
 * @return ESP_OK if connected successfully, ESP_FAIL if authentication failed, or ESP_ERR_TIMEOUT if timeout elapsed.
 * 
 * @note Blocks until connected (ESP_OK), authentication failed (ESP_FAIL),
 * or timeout elapsed (ESP_ERR_TIMEOUT).
 */
esp_err_t wifi_sta_connect(const char *ssid, const char *password, uint32_t timeout_ms);

/** @brief Returns true if station currently holds a valid IP address. */
bool wifi_sta_is_connected(void);

/**
 * @brief Copy the current connected SSID into buf.
 *
 * @param buf Buffer to store the SSID string.
 * @param len Length of the buffer.
 *
 * @return ESP_OK when connected and SSID is available, or an error code otherwise.
 */
esp_err_t wifi_sta_get_ssid(char *buf, size_t len);

/**
 * @brief Read the current RSSI from the connected access point.
 *
 * @param rssi_dbm Output RSSI in dBm.
 *
 * @return ESP_OK when connected and RSSI is available, or an error code otherwise.
 */
esp_err_t wifi_sta_get_rssi(int *rssi_dbm);

/**
 * @brief Copy the current IP address string into buf.
 * 
 * @param buf Buffer to store the IP address string
 * @param len Length of the buffer (must be at least 16 bytes)
 */
void wifi_sta_get_ip(char *buf, size_t len);

/** @brief Disconnect and release all Wi-Fi resources.
 * 
 * @return ESP_OK on success, or an error code.
 */
esp_err_t wifi_sta_deinit(void);

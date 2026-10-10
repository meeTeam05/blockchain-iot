/**
 * @file ble_prov.h
 * 
 * @brief BLE Wi-Fi provisioning header.
 * 
 * Copyright (C) 2026 MinhNhat & BaoViet
 */

#pragma once

#include "esp_err.h"
#include <stdbool.h>
#include <stddef.h>

/**
 * @brief BLE Wi-Fi provisioning module.
 * 
 * @return true if the device was previously provisioned, false otherwise.
 * 
 * @note Check whether Wi-Fi credentials are stored in NVS.
 */
bool ble_prov_is_provisioned(void);

/**
 * @brief Start BLE provisioning server.
 * 
 * @return ESP_OK if provisioning succeeded, ESP_FAIL if Wi-Fi connect failed.
 * 
 * @note Start BLE GATT provisioning server and block until done.
 *
 * - Advertises as "<SA_PROV_NAME_PREFIX>_<AABBCC>" (last 3 bytes of the Wi-Fi STA MAC)
 * - Waits for client to write SSID + password
 * - Connects to Wi-Fi and notifies the result to the client
 * - On success: saves credentials to NVS namespace "wifi_prov"
 *
 * Call ble_prov_stop() afterwards to free BLE resources.
 */
esp_err_t ble_prov_start(void);

/**
 * @brief Stop BLE provisioning server and release all BLE resources.
 * 
 * @note Safe to call even if ble_prov_start() returned an error.
 */
void ble_prov_stop(void);

/**
 * @brief Load stored Wi-Fi credentials from NVS.
 * 
 * @return ESP_OK if credentials were successfully loaded, or an error code.
 *
 * @note ssid_buf / pass_buf must be at least 64 bytes.
 */
esp_err_t ble_prov_load_credentials(char *ssid_buf, size_t ssid_len, char *pass_buf, size_t pass_len);

/**
 * @brief Clear stored credentials and force BLE re-provisioning on next boot.
 * 
 * @return ESP_OK on success, or an error code.
 */
esp_err_t ble_prov_reset(void);

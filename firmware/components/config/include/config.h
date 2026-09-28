/**
 * @file config.h
 *
 * @brief Project-wide configuration constants and NVS credential management API.
 *
 * Copyright (C) 2026 MinhNhat & BaoViet
 */

#pragma once

#include "esp_err.h"
#include "sdkconfig.h"
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* Compile-time constants */

/** Firmware version string */
#define FIRMWARE_VERSION CONFIG_FIRMWARE_VERSION

/** BLE advertising name prefix (without MAC suffix) */
#define SA_PROV_NAME_PREFIX CONFIG_SA_PROV_NAME_PREFIX

/** MQTT configuration */
#define SA_MQTT_BROKER_URI   CONFIG_SA_MQTT_BROKER_URI
#define SA_MQTT_SECRET_KEY   CONFIG_SA_MQTT_SECRET_KEY
#define SA_CUSTOM_DNS_SERVER CONFIG_SA_CUSTOM_DNS_SERVER
#define SA_HTTPD_PORT        CONFIG_SA_HTTPD_PORT

#define SA_ENABLE_LED           CONFIG_SA_ENABLE_LED
#define SA_ENABLE_FACTORY_RESET CONFIG_SA_ENABLE_FACTORY_RESET
#define SA_ENABLE_RELAYS        CONFIG_SA_ENABLE_RELAYS
#define SA_ENABLE_AI            CONFIG_SA_ENABLE_AI
#define SA_ENABLE_BLOCKCHAIN_INCIDENT CONFIG_SA_ENABLE_BLOCKCHAIN_INCIDENT

#if CONFIG_SA_INCIDENT_OFFLINE_BENCH
#define SA_INCIDENT_OFFLINE_BENCH 1
#else
#define SA_INCIDENT_OFFLINE_BENCH 0
#endif

/** Runtime AI default after boot (0 when SA_ENABLE_AI is off and the symbol is undefined) */
#if CONFIG_SA_AI_ENABLED_AT_BOOT
#define SA_AI_ENABLED_AT_BOOT 1
#else
#define SA_AI_ENABLED_AT_BOOT 0
#endif

#define SA_FACTORY_RESET_PIN     CONFIG_SA_FACTORY_RESET_PIN
#define SA_FACTORY_RESET_HOLD_MS CONFIG_SA_FACTORY_RESET_HOLD_MS

#define SA_DEMO_NO_PERIPHERALS CONFIG_SA_DEMO_NO_PERIPHERALS

#if CONFIG_SA_DEMO_NO_PERIPHERALS
#define SA_ENABLE_SHT3X      0
#define SA_ENABLE_DS3231     0
#define SA_ENABLE_CO_SENSOR  0
#define SA_ENABLE_NO2_SENSOR 0
#define SA_ENABLE_ILI9225    0
#define SA_ENABLE_SD_CARD    0
#define SA_ENABLE_BUZZER     0
#else
#define SA_ENABLE_SHT3X      CONFIG_SA_ENABLE_SHT3X
#define SA_ENABLE_DS3231     CONFIG_SA_ENABLE_DS3231
#define SA_ENABLE_CO_SENSOR  CONFIG_SA_ENABLE_CO_SENSOR
#define SA_ENABLE_NO2_SENSOR CONFIG_SA_ENABLE_NO2_SENSOR
#define SA_ENABLE_ILI9225    CONFIG_SA_ENABLE_ILI9225
#define SA_ENABLE_SD_CARD    CONFIG_SA_ENABLE_SD_CARD
#define SA_ENABLE_BUZZER     CONFIG_SA_ENABLE_BUZZER
#endif

/** Sensor polling interval (in seconds) */
#define SA_SENSOR_POLLING_INTERVAL CONFIG_SA_SENSOR_POLLING_INTERVAL * 1000 /* convert to ms */
#define SA_TIMEZONE                CONFIG_SA_TIMEZONE

/** I2C configuration */
#define SA_I2C_SDA_PIN    CONFIG_SA_I2C_SDA_PIN
#define SA_I2C_SCL_PIN    CONFIG_SA_I2C_SCL_PIN
#define SA_I2C_FREQ_HZ    CONFIG_SA_I2C_FREQ_HZ
#define SA_I2C_TIMEOUT_MS CONFIG_SA_I2C_TIMEOUT_MS

/** Display SPI configuration */
#define SA_DISP_CLK_PIN           CONFIG_SA_DISP_CLK_PIN
#define SA_DISP_SDA_PIN           CONFIG_SA_DISP_SDA_PIN
#define SA_DISP_RS_PIN            CONFIG_SA_DISP_RS_PIN
#define SA_DISP_RST_PIN           CONFIG_SA_DISP_RST_PIN
#define SA_DISP_CS_PIN            CONFIG_SA_DISP_CS_PIN
#define SA_DISP_SPI_HZ            CONFIG_SA_DISP_SPI_HZ
#define SA_DISP_SELF_TEST         CONFIG_SA_DISP_SELF_TEST
#define SA_DISP_SELF_TEST_HOLD_MS CONFIG_SA_DISP_SELF_TEST_HOLD_MS

/** Gas sensor ADC pins + channel mapping (ESP32-S3 ADC1: CH = GPIO - 1) */
#define SA_CO_ANALOG_PIN  CONFIG_SA_CO_ANALOG_PIN
#define SA_NO2_ANALOG_PIN CONFIG_SA_NO2_ANALOG_PIN

/** Gas sensor ADC channels */
#define SA_CO_ADC_CHANNEL    (CONFIG_SA_CO_ANALOG_PIN - 1)
#define SA_NO2_ADC_CHANNEL   (CONFIG_SA_NO2_ANALOG_PIN - 1)
#define SA_GAS_SENSOR_RL_OHM 10000.0f
#define SA_GAS_SENSOR_VC_V   3.3f

/** Onboard RGB LED */
#define SA_LED_PIN CONFIG_SA_LED_PIN

/** NVS namespace + keys for Wi-Fi provisioning (shared with ble_prov.c) */
#define SA_NVS_WIFI_NAMESPACE "wifi_prov"
#define SA_NVS_KEY_SSID       "ssid"
#define SA_NVS_KEY_PASS       "password"
#define SA_NVS_KEY_DONE       "done"

/** Default-NVS namespace containing MQTT credentials, mode, and relay state. */
#define SA_NVS_DEVICE_NAMESPACE "device"

/** NVS partition for sensor-owned calibration data preserved across factory reset. */
#define SA_NVS_CALIB_PARTITION "calib"

/* NVS credential API */

/**
 * @brief Shared guard for NVS writes and factory reset erase coordination.
 *
 * @return ESP_OK if the caller is cleared to proceed with NVS writes, 
 *         or an error if a lock could not be obtained.
 * 
 * @note Writers must call config_nvs_write_end() when finished. Factory 
 *       reset will call config_factory_reset_end() when the erase is 
 *       complete to unblock writers.
 */
esp_err_t config_nvs_write_begin(void);

/**
 * @brief Release the NVS write lock obtained from config_nvs_write_begin().
 */
void config_nvs_write_end(void);

/**
 * @brief Check if a factory reset is currently in progress.
 * 
 * @return true if factory reset is in progress, false otherwise.
 */
bool config_factory_reset_in_progress(void);

/**
 * @brief Begin factory reset by blocking normal default-NVS writers.
 * 
 * @return ESP_OK if factory reset was successfully initiated, or an error if the erase 
 *         could not be started.
 */
esp_err_t config_factory_reset_begin(void);

/**
 * @brief Erase only user provisioning/runtime-control namespaces.
 *
 * Call only while the factory-reset guard is held. This clears Wi-Fi, MQTT,
 * device-mode, and relay state. It deliberately preserves the incidentv2
 * namespace, including its signer, sequence, and durable incident queue.
 */
esp_err_t config_factory_reset_erase_provisioning(void);

/**
 * @brief End factory reset by unblocking writers after targeted erase completes.
 */
void config_factory_reset_end(void);

/**
 * @brief Read MQTT credentials from default NVS namespace "device".
 *
 * @param broker_uri_buf  Output buffer for broker URI, at least 128 bytes.
 * @param broker_uri_len  Size of broker_uri_buf.
 * @param secret_key_buf  Output buffer for secret key, at least 64 bytes.
 * @param secret_key_len  Size of secret_key_buf.
 *
 * @return ESP_OK on success, or an NVS error.
 *
 * @note Falls back to Kconfig defaults (CONFIG_SA_MQTT_BROKER_URI,
 *       CONFIG_SA_MQTT_SECRET_KEY) if a key is not found in NVS.
 */
esp_err_t config_get_mqtt_creds(char *broker_uri_buf,
                                size_t broker_uri_len,
                                char *secret_key_buf,
                                size_t secret_key_len);

/**
 * @brief Resolve the immutable device identifier from the Wi-Fi STA MAC.
 *
 * @param out      Output buffer for device ID.
 * @param out_len  Size of output buffer (at least 18 bytes for MAC format).
 *
 * @return ESP_OK on success, ESP_ERR_INVALID_ARG for invalid output buffer.
 */
esp_err_t config_get_device_id(char *out, size_t out_len);

/**
 * @brief Write MQTT broker override and secret key to NVS and commit.
 *
 * @param broker_uri  Optional broker URI override. Pass NULL or "" to clear any stored override and use Kconfig default.
 * @param device_id   Null-terminated device ID string in MAC format. Must match the device STA MAC.
 * @param secret_key  Null-terminated per-device MQTT secret from the server.
 *
 * @return ESP_OK on success, ESP_ERR_INVALID_ARG on invalid contract fields, or an NVS error.
 */
esp_err_t config_set_mqtt_config(const char *broker_uri, const char *device_id, const char *secret_key);

/**
 * @brief Load persisted gas sensor R0 baseline from the calibration NVS partition.
 *
 * @param sensor_name  "co" or "no2", used as the NVS key suffix.
 * @param r0           Output: R0 value in ohm.
 * @param calibrated   Output: true if a persisted R0 was found.
 *
 * @return ESP_OK on success or key not found (calibrated=false), error otherwise.
 */
esp_err_t config_load_gas_r0(const char *sensor_name, float *r0, bool *calibrated);

/**
 * @brief Persist gas sensor R0 baseline to the calibration NVS partition.
 *
 * @param sensor_name  "co" or "no2".
 * @param r0           R0 value in ohm from sensor calibration.
 *
 * @return ESP_OK on success, NVS error otherwise.
 */
esp_err_t config_save_gas_r0(const char *sensor_name, float r0);

/**
 * @brief Atomically copy calibration identity for a signed incident snapshot.
 *
 * Values are R0 in ohms scaled by 10,000. Missing/legacy values are returned
 * as zero; revision is zero only until the first revision-aware calibration
 * save. This preserves legacy calibrations without inventing a revision.
 */
esp_err_t config_get_gas_calibration_snapshot(int64_t *co_r0_q10000,
                                              int64_t *no2_r0_q10000,
                                              uint32_t *revision);

/**
 * @brief Device mode query shared across components to avoid dependency cycles.
 *
 * @return true when device mode is ON and relay commands are allowed.
 */
bool device_mode_get(void);

/**
 * @brief Sensor task publish gate shared across components to avoid dependency cycles.
 *
 * @return true when sensor task is allowed to publish readings 
 *         (device mode ON and not in factory reset).
 */
bool sensor_task_get_enabled(void);

/**
 * @brief Set sensor task publish enabled/disabled.
 *
 * @param enabled  true to enable publishes, false to disable.
 */
void sensor_task_set_enabled(bool enabled);

#ifdef CONFIG_SA_CONFIG_SELF_TEST

/**
 * @brief Run NVS write/read roundtrip self-test (only when SA_CONFIG_SELF_TEST=y).
 *
 * @note Writes known test values, reads them back, verifies match, then erases them.
 *       Logs PASS or FAIL. Does not affect production namespaces.
 */
void config_self_test(void);

#endif

/**
 * @file mqtt.h
 *
 * @brief MQTT client for EMQX TLS connection, LWT, and pub/sub.
 *
 * Copyright (C) 2026 MinhNhat & BaoViet
 */

#pragma once

#include "esp_err.h"
#include <stdbool.h>
#include <stdint.h>

#define MQTT_MAX_COMMAND_TYPE_LEN 31

/**
 * @brief Callback invoked when a set_time command is received from the app.
 *        The implementation should write the timestamp to the DS3231 RTC.
 *
 * @param ts Unix timestamp in seconds (from phone).
 */
typedef void (*mqtt_time_sync_cb_t)(uint32_t ts);

/**
 * @brief Register a callback to be called when a set_time command arrives.
 *        Call once from sysload_init() after DS3231 is initialised.
 *
 * @param cb Callback function pointer. Pass NULL to deregister.
 */
void mqtt_register_time_sync_cb(mqtt_time_sync_cb_t cb);

/**
 * @brief Callback invoked when a shadow/get_response payload is received.
 *
 * The callback receives the full JSON payload and may apply only the
 * supported delta/desired keys locally.
 *
 * @param json_payload Full shadow/get_response JSON string.
 * @return ESP_OK on success, or an error code if the payload was malformed or
 *         could not be applied safely.
 */
typedef esp_err_t (*mqtt_shadow_sync_cb_t)(const char *json_payload);

/**
 * @brief Register a callback to be called when a shadow/get_response arrives.
 *        Call once from sysload_init() before mqtt_start().
 *
 * @param cb Callback function pointer. Pass NULL to deregister.
 */
void mqtt_register_shadow_sync_cb(mqtt_shadow_sync_cb_t cb);

/** Callback for the dedicated Schema v2 incident ACK topic. */
typedef esp_err_t (*mqtt_incident_ack_cb_t)(const char *json_payload);

/** Dispatch an already-framed incident ACK through the registered callback. */
static inline esp_err_t mqtt_dispatch_incident_ack(mqtt_incident_ack_cb_t cb,
                                                   const char *json_payload)
{
    return (cb && json_payload) ? cb(json_payload) : ESP_ERR_INVALID_ARG;
}

void mqtt_register_incident_ack_cb(mqtt_incident_ack_cb_t cb);

/**
 * @brief Callback invoked when a command of a registered type arrives.
 *
 * @param type         The "type" field value from the command JSON.
 * @param json_payload Full command JSON string (FW-04: already copied, valid for call duration).
 * @return ESP_OK on success; MQTT ack reports "done".
 *         ESP_ERR_NOT_FINISHED if the handler accepted the command and will
 *         publish the final ack asynchronously.
 *         Any other value; MQTT ack reports "error".
 */
typedef esp_err_t (*mqtt_command_cb_t)(const char *type, const char *json_payload);

/**
 * @brief Register a handler for a specific command type.
 *
 * Up to 8 handlers may be registered. Call from sysload_init() before mqtt_start().
 * The handler is invoked synchronously inside the MQTT event callback, so keep it short
 * (write to queue or set a flag; do not block).
 * Command type names must fit within @c MQTT_MAX_COMMAND_TYPE_LEN characters.
 *
 * @param type  Command type string to match against the "type" JSON field.
 * @param cb    Handler function.
 * @return ESP_OK on success, ESP_ERR_INVALID_ARG for NULL/empty input,
 *         ESP_ERR_INVALID_SIZE if @p type is too long, ESP_ERR_NO_MEM if the
 *         fixed registration table is full.
 */
esp_err_t mqtt_register_command_handler(const char *type, mqtt_command_cb_t cb);

/**
 * @brief Publish a command ack to device/{id}/response.
 *
 * Use this when a command is completed asynchronously outside the MQTT event
 * callback.
 *
 * @param command_id Original command_id from device/{id}/command.
 * @param success    true -> "done", false -> "error".
 *
 * @return ESP_OK if publish was queued, error otherwise.
 */
esp_err_t mqtt_publish_command_ack(const char *command_id, bool success);

/**
 * @brief Start the MQTT client and connect to the broker asynchronously.
 *
 * Spawns mqtt_task (Core 1, Priority 6, 6144 B stack).
 * Returns after the task has completed local MQTT client setup
 * (init + event registration + client start). The actual TCP/TLS
 * connection still happens in the background.
 *
 * @param broker_uri  Full broker URI, e.g. "wss://minhnhat05.xyz/mqtt"
 * @param device_id   MQTT client ID / username. Must be the lowercase
 *                    Wi-Fi STA MAC resolved by config_get_device_id().
 * @param secret_key  Per-device MQTT password (stored in NVS / Kconfig).
 *
 * @return ESP_OK if setup succeeded and the client connection loop is running.
 *         An error code if task creation or initial MQTT client setup failed.
 */
esp_err_t mqtt_start(const char *broker_uri,
                     const char *device_id,
                     const char *secret_key);

/**
 * @brief Publish a message to any topic. Thread-safe.
 *
 * Can be called from sensor_task, command handlers, or any other task
 * after mqtt_start() returns.
 *
 * @param topic    Full topic string.
 * @param payload  Null-terminated JSON (or any string) payload.
 * @param qos      MQTT QoS level: 0, 1, or 2.
 * @param retain   true to set the MQTT retain flag.
 *
 * @return Message ID (>= 0) on success, -1 if client not ready.
 */
int mqtt_publish(const char *topic, const char *payload, int qos, bool retain);

/**
 * @brief Stop and destroy the MQTT client.
 *
 * Publishes the offline LWT is handled automatically by the broker on disconnect.
 * Call before factory reset or any clean-shutdown sequence that precedes esp_restart().
 *
 * Safe to call if mqtt_start() was never called (no-op when client is NULL).
 *
 * @return ESP_OK always.
 */
esp_err_t mqtt_stop(void);

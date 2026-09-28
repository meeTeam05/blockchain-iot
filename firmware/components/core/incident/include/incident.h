/**
 * @file incident.h
 * @brief Durable Schema v2 incidents for Gas EWS transitions.
 *
 * This API deliberately accepts an already-copied snapshot.  The caller is
 * responsible for taking it while it owns the Gas EWS transition; this keeps
 * persistence, crypto and MQTT out of the safety-critical alert path.
 */
#pragma once

#include "esp_err.h"
#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define INCIDENT_SCHEMA_VERSION 2
#define INCIDENT_HASH_BYTES 32
#define INCIDENT_SIGNATURE_BYTES 65

typedef enum {
    INCIDENT_TIME_NONE = 0,
    INCIDENT_TIME_SNTP = 1,
    INCIDENT_TIME_DS3231 = 2,
} incident_time_source_t;

typedef struct {
    /* Set by incident_on_gas_ews_transition() at the same point the complete
     * snapshot is copied into its worker queue. */
    uint64_t observed_at;
    incident_time_source_t time_source;
    /* Internal eligibility metadata; it is never encoded into Schema v2. */
    bool warmup;
    uint8_t sensor_valid_mask;
    int32_t temperature_c_x100;
    uint16_t humidity_pct_x100;
    uint32_t co_ppm_x1000;
    uint32_t no2_ppm_x1000;
    uint8_t overall_level;
    uint8_t co_level;
    uint8_t no2_level;
    uint8_t co_alarm_source_mask;
    uint8_t no2_alarm_source_mask;
    uint8_t derived_valid_mask;
    uint32_t co_stel15_ppm_x1000;
    uint32_t no2_stel15_ppm_x1000;
    uint32_t co_twa8h_ppm_x1000;
    uint32_t no2_twa8h_ppm_x1000;
    uint32_t co_proj10_ppm_x1000;
    uint32_t no2_proj10_ppm_x1000;
    uint8_t model_probability_valid_mask;
    uint16_t co_model_probability_bps;
    uint16_t no2_model_probability_bps;
    uint8_t model_sha256[INCIDENT_HASH_BYTES];
    int64_t co_r0_q10000;
    int64_t no2_r0_q10000;
    uint32_t calibration_revision;
} incident_snapshot_t;

/** Start persistent queue/retry support. Safe no-op when feature is disabled. */
esp_err_t incident_init(const char *device_id);

/** Update the only acceptable clock provenance. Never pass a guessed source. */
void incident_set_time_source(incident_time_source_t source);

/**
 * Queue an incident after local alerting has been initiated.  Only the three
 * approved upward transitions and a valid trigger gas may reach persistence.
 * This call only copies the snapshot into a worker queue and never publishes.
 */
void incident_on_gas_ews_transition(uint8_t previous_level, uint8_t new_level, const incident_snapshot_t *snapshot);

/** MQTT invokes this for device/{id}/incident/ack; malformed ACKs are ignored. */
esp_err_t incident_handle_ack(const char *json_payload);

/** Retry records previously committed to NVS, preserving their exact bytes. */
void incident_retry_pending(void);

/** Signer lifecycle. Keys are accepted only with ESP-IDF NVS encryption enabled. */
esp_err_t incident_provision_signer(const uint8_t private_key[32]);
esp_err_t incident_get_signer_address(char out[43]);
esp_err_t incident_rotate_signer(const uint8_t private_key[32]);
esp_err_t incident_revoke_local_signer(void);

#ifdef __cplusplus
}
#endif

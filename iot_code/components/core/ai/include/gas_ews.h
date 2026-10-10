/**
 * @file gas_ews.h
 *
 * @brief CO/NO2 early warning against QCVN 03:2019/BYT -- preprocessing,
 *        QCVN rule and alarm logic (pure C99, host-testable).
 *
 * Feature extraction and decision logic. Every constant comes from gas_ews_contract.h, which
 * is generated from the trained model's contract -- never edit numbers here.
 * `tools/test_gas_ews_host.c` replays golden vectors produced by the
 * Python pipeline and checks this file reproduces them step by step.
 *
 * Data flow (sensor_task calls gas_ews_feed() every poll, ~5s):
 *   5s samples -> skip 10 min MOS preheat after boot / >60s outage
 *   -> 10s steps (mean of 2 slots) -> forward-fill gas <= 60s
 *   -> STEL (15 min mean), TWA (sum(C*t) / 8h), projection (STEL in 10 min
 *      if the level holds) -> 8 model channels, 20 min ring
 *   -> per gas:  EXCEEDED      = STEL >= limit OR TWA >= limit   (QCVN rule)
 *                EARLY_WARNING = EXCEEDED OR projection alarm OR model alarm
 * The model itself runs in ai.c (gas_ews_model.h) on
 * gas_ews_get_window() and reports back via gas_ews_set_model_result(); the
 * QCVN rule never depends on it.
 *
 * Copyright (C) 2026 MinhNhat & BaoViet
 */

#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "gas_ews_contract.h"

#ifdef __cplusplus
extern "C" {
#endif

#define GAS_EWS_CO 0
#define GAS_EWS_NO2 1
#define GAS_EWS_NUM_GASES 2

typedef enum {
    GAS_EWS_SAFE = 0,          /**< an toan */
    GAS_EWS_EARLY_WARNING = 1, /**< canh bao som: STEL expected to exceed within 10 min */
    GAS_EWS_EXCEEDED = 2,      /**< vuot nguong QCVN (STEL or TWA) */
} gas_ews_level_t;

typedef struct {
    int64_t t_ms;     /**< MONOTONIC milliseconds (esp_timer), never wall clock -- SNTP jumps would fake gaps */
    float co_ppm;
    float no2_ppm;
    float temp_c;
    float rh_pct;
    bool co_valid;
    bool no2_valid;
    bool th_valid;    /**< temperature AND humidity (one SHT3x read) */
} gas_ews_sample_t;

typedef struct {
    uint32_t steps;           /**< finalized 10s steps since reset; changes = new data */
    bool warmup;              /**< latest step is inside the preheat window (gas ignored) */
    bool model_ok;            /**< GAS_EWS_WINDOW_STEPS (20 min) of continuous valid gas data -> model may run */
    /** Validity of the raw values that finalized this step: bit 0 T, bit 1 RH,
     * bit 2 CO, bit 3 NO2. Forward-filled values never set these bits. */
    uint8_t sensor_valid_mask;
    float temperature_c;      /**< raw finalized step, NAN when unavailable */
    float humidity_pct;       /**< raw finalized step, NAN when unavailable */
    float ppm[GAS_EWS_NUM_GASES];     /**< latest 10s value after forward-fill, NAN = unknown */
    float stel[GAS_EWS_NUM_GASES];    /**< ppm, NAN = unknown */
    float twa[GAS_EWS_NUM_GASES];     /**< ppm (sum(C*t)/8h, missing time counts as 0) */
    float proj[GAS_EWS_NUM_GASES];    /**< ppm, NAN = unknown */
    float p_model[GAS_EWS_NUM_GASES]; /**< latest model output, NAN if the model did not run */
    bool rule_alarm[GAS_EWS_NUM_GASES];
    bool proj_alarm[GAS_EWS_NUM_GASES];
    bool model_alarm[GAS_EWS_NUM_GASES];
    gas_ews_level_t level[GAS_EWS_NUM_GASES];
} gas_ews_status_t;

/** Per-step values, for the host golden test / diagnostics only. */
typedef struct {
    uint32_t k;               /**< step index since reset (0-based) */
    float ppm[GAS_EWS_NUM_GASES];
    float stel[GAS_EWS_NUM_GASES];
    float twa[GAS_EWS_NUM_GASES];
    float proj[GAS_EWS_NUM_GASES];
    bool model_ok;
    float x[GAS_EWS_NUM_CHANNELS];
    bool rule_alarm[GAS_EWS_NUM_GASES];
    bool proj_alarm[GAS_EWS_NUM_GASES];
} gas_ews_step_debug_t;

/** Back to power-on state (10 min preheat, empty history). */
void gas_ews_reset(void);

/** Feed one sensor poll. Cheap; safe from any task. */
void gas_ews_feed(const gas_ews_sample_t *sample);

void gas_ews_get_status(gas_ews_status_t *out);

/**
 * @brief Copy the model input window (oldest step first).
 * @param steps  receives gas_ews_status_t.steps of this window
 * @return false if !model_ok (window not usable)
 */
bool gas_ews_get_window(uint32_t *steps, float out[GAS_EWS_WINDOW_STEPS][GAS_EWS_NUM_CHANNELS]);

/**
 * @brief Report the model output for the window taken at `steps`
 *        (valid=false when the model did not / could not run). Steps the
 *        caller skipped count as "below threshold".
 */
void gas_ews_set_model_result(uint32_t steps, const float p[GAS_EWS_NUM_GASES], bool valid);

/** Test/diagnostic hook, called for every finalized step (NULL = off). Must not block. */
void gas_ews_set_step_hook(void (*hook)(const gas_ews_step_debug_t *step));

#ifdef __cplusplus
}
#endif

/**
 * @file ai.h
 *
 * @brief Public API of the on-device CO/NO2 early-warning component
 *        (QCVN 03:2019/BYT, see README.md).
 *
 * sensor_task -> ai_feed_sample() -> gas_ews (10s steps, STEL/TWA rule,
 * projection) -> ai task runs the INT8 model on each new step, beeps on a
 * higher level and publishes device/{id}/ai/state. No relay control here.
 * No-op stubs when CONFIG_SA_ENABLE_AI=n.
 *
 * Copyright (C) 2026 MinhNhat & BaoViet
 */

#pragma once

#include "esp_err.h"
#include "gas_ews.h"

#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * @brief Init the model (PSRAM tensor arena + boot self-test) and start the ai task.
 *
 * A model/PSRAM/self-test failure is logged and only disables the model: the
 * QCVN STEL/TWA rule and the projection early warning keep running.
 * @param device_id  Used to build `device/{id}/ai/state` and the shadow topic.
 */
esp_err_t ai_start(const char *device_id);

/**
 * @brief Feed one sensor poll (raw ppm, per-sensor validity, monotonic ms).
 *        Call once per sensor cycle. Non-blocking.
 */
void ai_feed_sample(const gas_ews_sample_t *sample);

/**
 * @brief Runtime on/off switch (not persisted, resets to SA_AI_ENABLED_AT_BOOT
 *        on every boot). Publishes the new state to the shadow (best effort).
 *        While off, the ai task neither runs the model, beeps nor publishes
 *        ai/state; gas_ews keeps its history so switching back on is immediate.
 */
esp_err_t ai_set_enabled(bool enabled);

/** @return Current runtime switch state; false when AI is compiled out. */
bool ai_get_enabled(void);

#ifdef __cplusplus
}
#endif

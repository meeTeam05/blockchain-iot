/**
 * @file gas_ews_model.h
 *
 * @brief TFLite Micro wrapper for the gas_ews INT8 model
 *        (model/gas_ews_int8.tflite, 1D-CNN, 12k params, 21 KB).
 *
 * Input: gas_ews_get_window() output, [GAS_EWS_WINDOW_STEPS = 120 steps = 20 min][8 channels] float.
 * Output: p[CO], p[NO2] = P(STEL exceeds QCVN within 10 min).
 *
 * Copyright (C) 2026 MinhNhat & BaoViet
 */

#pragma once

#include "esp_err.h"
#include "gas_ews.h"

#ifdef __cplusplus
extern "C" {
#endif

/**
 * @brief Map the model, allocate tensors once, and run the built-in self-test
 *        (2 windows whose int8 output was recorded from the reference TFLite
 *        interpreter at export time). Fails -- and the caller must keep the
 *        model disabled -- if the runtime disagrees by more than 1 LSB.
 */
esp_err_t gas_ews_model_init(void);

esp_err_t gas_ews_model_infer(const float window[GAS_EWS_WINDOW_STEPS][GAS_EWS_NUM_CHANNELS],
                              float p_out[GAS_EWS_NUM_GASES]);

/** SHA-256 over exact embedded TFLite flatbuffer bytes. */
esp_err_t gas_ews_model_sha256(uint8_t out[32]);

#ifdef __cplusplus
}
#endif

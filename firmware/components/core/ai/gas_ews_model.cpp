/**
 * @file gas_ews_model.cpp
 *
 * @brief See gas_ews_model.h. One persistent MicroInterpreter; its tensor
 *        arena is allocated once at init (PSRAM, internal RAM fallback).
 *        Quantization params are read from the flatbuffer, never hardcoded.
 *        Inputs are clipped to int8 range exactly like the Python
 *        verification (ungdungdidong/gas_ews/train.py tflite_predictor).
 *
 * The tflite-micro calls are the same ones the previous ai_inference.cpp
 * used on real hardware; check the boot log for "gas_ews model ready" +
 * "self-test OK".
 *
 * Copyright (C) 2026 MinhNhat & BaoViet
 */

#include "gas_ews_model.h"

#include "esp_heap_caps.h"
#include "esp_log.h"
#include "sdkconfig.h"
#include "mbedtls/sha256.h"

#include "tensorflow/lite/micro/micro_interpreter.h"
#include "tensorflow/lite/micro/micro_mutable_op_resolver.h"
#include "tensorflow/lite/schema/schema_generated.h"

#include <cmath>
#include <cstring>
#include <new>

#include "gas_ews_selftest.h"

static const char *TAG = "gas_ews_model";

/* EMBED_FILES "model/gas_ews_int8.tflite" -> symbols from the file BASENAME. */
extern const uint8_t g_gas_ews_model_start[] asm("_binary_gas_ews_int8_tflite_start");
extern const uint8_t g_gas_ews_model_end[] asm("_binary_gas_ews_int8_tflite_end");

extern "C" esp_err_t gas_ews_model_sha256(uint8_t out[32])
{
    const uint8_t *start = g_gas_ews_model_start;
    const uint8_t *end = g_gas_ews_model_end;
    if (out == nullptr || end < start) return ESP_ERR_INVALID_ARG;
    return mbedtls_sha256(start, static_cast<size_t>(end - start), out, 0) == 0
               ? ESP_OK
               : ESP_FAIL;
}

#ifndef CONFIG_SA_AI_TENSOR_ARENA_SIZE
#define CONFIG_SA_AI_TENSOR_ARENA_SIZE (16 * 1024)
#endif
#define ARENA_SIZE ((size_t)CONFIG_SA_AI_TENSOR_ARENA_SIZE)

/* Exactly the ops the exporter found in the flatbuffer (model_contract.json). */
static tflite::MicroMutableOpResolver<4> s_resolver;
static uint8_t *s_arena = nullptr; /* PSRAM first, internal RAM as fallback */
alignas(tflite::MicroInterpreter) static uint8_t s_interp_buf[sizeof(tflite::MicroInterpreter)];
static tflite::MicroInterpreter *s_interp = nullptr;
static TfLiteTensor *s_in = nullptr;
static TfLiteTensor *s_out = nullptr;

static esp_err_t invoke_int8(const int8_t *q_in, int8_t q_out[GAS_EWS_NUM_GASES])
{
    std::memcpy(s_in->data.int8, q_in, GAS_EWS_WINDOW_STEPS * GAS_EWS_NUM_CHANNELS);
    if (s_interp->Invoke() != kTfLiteOk) {
        return ESP_FAIL;
    }
    q_out[0] = s_out->data.int8[0];
    q_out[1] = s_out->data.int8[1];
    return ESP_OK;
}

/* Undo a partial init so the model stays cleanly disabled (the QCVN rule does not need it). */
static void release(void)
{
    if (s_interp != nullptr) {
        s_interp->~MicroInterpreter();
        s_interp = nullptr;
    }
    s_in = nullptr;
    s_out = nullptr;
    heap_caps_free(s_arena);
    s_arena = nullptr;
}

esp_err_t gas_ews_model_init(void)
{
    if (s_interp != nullptr) {
        return ESP_OK;
    }
    const tflite::Model *model = tflite::GetModel(g_gas_ews_model_start);
    if (model->version() != TFLITE_SCHEMA_VERSION) {
        ESP_LOGE(TAG, "schema version mismatch (model=%u, runtime=%u)", (unsigned)model->version(),
                 (unsigned)TFLITE_SCHEMA_VERSION);
        return ESP_FAIL;
    }
    s_resolver.AddConv2D();
    s_resolver.AddFullyConnected();
    s_resolver.AddLogistic();
    s_resolver.AddReshape();

    s_arena = static_cast<uint8_t *>(heap_caps_aligned_alloc(16, ARENA_SIZE, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
    const char *arena_where = "PSRAM";
    if (s_arena == nullptr) {
        /* The arena is small (activations <= 1 KB): internal RAM keeps the model
         * usable on a board without PSRAM. */
        s_arena = static_cast<uint8_t *>(heap_caps_aligned_alloc(16, ARENA_SIZE, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
        arena_where = "internal RAM";
    }
    if (s_arena == nullptr) {
        ESP_LOGE(TAG, "tensor arena alloc failed (%u B, free PSRAM=%u B)", (unsigned)ARENA_SIZE,
                 (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM));
        return ESP_ERR_NO_MEM;
    }

    s_interp = new (s_interp_buf) tflite::MicroInterpreter(model, s_resolver, s_arena, ARENA_SIZE);
    if (s_interp->AllocateTensors() != kTfLiteOk) {
        ESP_LOGE(TAG, "AllocateTensors failed -- raise CONFIG_SA_AI_TENSOR_ARENA_SIZE (%u)", (unsigned)ARENA_SIZE);
        release();
        return ESP_ERR_NO_MEM;
    }
    s_in = s_interp->input(0);
    s_out = s_interp->output(0);
    if (s_in == nullptr || s_out == nullptr || s_in->type != kTfLiteInt8 || s_out->type != kTfLiteInt8 ||
        s_in->bytes != GAS_EWS_WINDOW_STEPS * GAS_EWS_NUM_CHANNELS || s_out->bytes != GAS_EWS_NUM_GASES) {
        ESP_LOGE(TAG, "unexpected tensor layout (in %u B, out %u B)",
                 s_in ? (unsigned)s_in->bytes : 0u, s_out ? (unsigned)s_out->bytes : 0u);
        release();
        return ESP_FAIL;
    }

    for (int i = 0; i < GAS_EWS_SELFTEST_COUNT; i++) {
        int8_t q[GAS_EWS_NUM_GASES];
        if (invoke_int8(kGasEwsSelftestIn[i], q) != ESP_OK) {
            ESP_LOGE(TAG, "self-test %d: Invoke failed", i);
            release();
            return ESP_FAIL;
        }
        for (int g = 0; g < GAS_EWS_NUM_GASES; g++) {
            int diff = std::abs((int)q[g] - (int)kGasEwsSelftestOut[i][g]);
            if (diff > 1) {
                ESP_LOGE(TAG, "self-test %d gas %d: got %d, expected %d -- runtime disagrees with "
                              "the reference interpreter, model disabled", i, g, q[g], kGasEwsSelftestOut[i][g]);
                release();
                return ESP_FAIL;
            }
        }
    }
    ESP_LOGI(TAG, "gas_ews model ready: %u B flatbuffer, arena used %u/%u B in %s, in scale=%.6f zp=%d; self-test OK",
             (unsigned)GAS_EWS_MODEL_BYTES, (unsigned)s_interp->arena_used_bytes(), (unsigned)ARENA_SIZE, arena_where,
             (double)s_in->params.scale, (int)s_in->params.zero_point);
    return ESP_OK;
}

esp_err_t gas_ews_model_infer(const float window[GAS_EWS_WINDOW_STEPS][GAS_EWS_NUM_CHANNELS],
                              float p_out[GAS_EWS_NUM_GASES])
{
    if (s_interp == nullptr || window == nullptr || p_out == nullptr) {
        return ESP_ERR_INVALID_STATE;
    }
    const float scale = s_in->params.scale;
    const int32_t zp = s_in->params.zero_point;
    int8_t *dst = s_in->data.int8;
    for (int t = 0; t < GAS_EWS_WINDOW_STEPS; t++) {
        for (int c = 0; c < GAS_EWS_NUM_CHANNELS; c++) {
            int32_t q = (int32_t)lroundf(window[t][c] / scale) + zp;
            dst[t * GAS_EWS_NUM_CHANNELS + c] = (int8_t)(q < -128 ? -128 : (q > 127 ? 127 : q));
        }
    }
    if (s_interp->Invoke() != kTfLiteOk) {
        return ESP_FAIL;
    }
    for (int g = 0; g < GAS_EWS_NUM_GASES; g++) {
        p_out[g] = ((float)s_out->data.int8[g] - (float)s_out->params.zero_point) * s_out->params.scale;
    }
    return ESP_OK;
}

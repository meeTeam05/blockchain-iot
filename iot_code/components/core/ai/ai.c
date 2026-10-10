/**
 * @file ai.c
 *
 * @brief AI task: on every new gas_ews 10s step, runs the INT8 model on the
 *        20 min window, reports it back to gas_ews (which owns all alarm
 *        logic), beeps when the level rises and publishes
 *        device/{id}/ai/state on a change and every 60s.
 *
 * The QCVN STEL/TWA rule and the projection early warning live in gas_ews and
 * keep working when the model is missing or failed its boot self-test.
 *
 * Copyright (C) 2026 MinhNhat & BaoViet
 */

#include "ai.h"
#include "ai_alarm_dispatch.h"

#include "config.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "ai";

#if SA_ENABLE_AI

#include "cJSON.h"
#include "esp_timer.h"
#include "gas_ews_model.h"
#include "incident.h"
#include "mqtt.h"

#include <math.h>
#include <stdio.h>
#include <string.h>
#include <time.h>

#define AI_TASK_NAME         "ai_task"
#define AI_TASK_STACK_SIZE   8192   /* TFLM Invoke() + cJSON; check the high-water mark log */
#define AI_TASK_PRIORITY     3      /* below sensor_task(5) */
#define AI_STATE_PERIOD_MS   60000  /* ai/state heartbeat (ppm/STEL trend) even without changes */
#define AI_TIMING_REPORT_RUNS 360   /* 360 x 10s steps = log inference timing once per hour */

static portMUX_TYPE s_enabled_lock = portMUX_INITIALIZER_UNLOCKED;
static bool s_enabled = SA_AI_ENABLED_AT_BOOT; /* runtime default at every boot (not persisted) */
static TaskHandle_t s_task = NULL;
static char s_ai_state_topic[96] = {0};
static char s_shadow_topic[96] = {0};

static const char *const kLevelName[] = {"an_toan", "canh_bao_som", "vuot_nguong"};
static const char *const kGasKey[GAS_EWS_NUM_GASES] = {"co", "no2"};

static bool s_model_ready = false;          /* model loaded + self-test passed this boot */
#if !CONFIG_SA_AI_REPLAY
static uint32_t s_fed_steps = 0;            /* last gas_ews step count seen by ai_feed_sample() */
#endif
static uint32_t s_model_steps = 0;          /* last step the model was run for */
static gas_ews_status_t s_status;
static gas_ews_level_t s_level = GAS_EWS_SAFE; /* max over both gases */
static float s_window[GAS_EWS_WINDOW_STEPS][GAS_EWS_NUM_CHANNELS]; /* 3.8 KB, static, not on the task stack */
static int64_t s_last_publish_ms = 0;

#if CONFIG_SA_AI_REPLAY
/* Bench test: ai_replay_task feeds gas_ews from ai_replay_data.h instead of
 * the sensors, on a simulated clock (see Kconfig SA_AI_REPLAY / _SPEED).
 * Decoding must match the encoding described in ai_replay_data.h. */
#include "ai_replay_data.h"
_Static_assert(CONFIG_SA_AI_REPLAY_SCENARIO < AI_REPLAY_SCENARIO_COUNT, "unknown SA_AI_REPLAY_SCENARIO");
static const ai_replay_scenario_t *const s_replay = &k_replay_scenarios[CONFIG_SA_AI_REPLAY_SCENARIO];
static TaskHandle_t s_replay_task = NULL;

#define AI_REPLAY_TASK_NAME       "ai_replay"
#define AI_REPLAY_TASK_STACK_SIZE 4096
#define AI_REPLAY_TASK_PRIORITY   2       /* below ai_task, which finishes each step before the next sample */
#define AI_REPLAY_SAMPLE_MS       5000    /* sample spacing in ai_replay_data.h */
#define AI_REPLAY_START_DELAY_MS  10000   /* let Wi-Fi/MQTT come up so ai/state is not lost */
#define AI_REPLAY_STEP_TIMEOUT_MS 5000

static float replay_decode(uint16_t v, float scale, float offset)
{
    return v == 0xFFFFu ? NAN : (float)v / scale - offset;
}

/** Replay sample `idx` at simulated time idx * 5s; past the end: an all-invalid sample. */
static void replay_sample(uint32_t idx, gas_ews_sample_t *x)
{
    x->t_ms = (int64_t)idx * AI_REPLAY_SAMPLE_MS;
    if (idx >= s_replay->count) {
        x->co_ppm = x->no2_ppm = x->temp_c = x->rh_pct = NAN;
        x->co_valid = x->no2_valid = x->th_valid = false;
        return;
    }
    const uint16_t *v = s_replay->s[idx];
    x->co_ppm = replay_decode(v[0], 10.0f, 0.0f);
    x->no2_ppm = replay_decode(v[1], 1000.0f, 0.0f);
    x->temp_c = replay_decode(v[2], 100.0f, 40.0f);
    x->rh_pct = replay_decode(v[3], 100.0f, 0.0f);
    x->co_valid = !isnan(x->co_ppm);
    x->no2_valid = !isnan(x->no2_ppm);
    x->th_valid = !isnan(x->temp_c) && !isnan(x->rh_pct);
}

/**
 * One "RS," line per 10s step, same columns as replay_<name>_expected.csv:
 * t_s, then per gas ppm/stel15/twa8h/proj10/p_model/level, then warmup.
 * tools/replay/compare_replay_log.py checks a captured log against it.
 */
static void replay_log_step(const gas_ews_status_t *st)
{
    const float *f[] = {st->ppm, st->stel, st->twa, st->proj, st->p_model};
    char line[200];
    int n = snprintf(line, sizeof(line), "RS,%u", (unsigned)(st->steps * 10));
    for (int g = 0; g < GAS_EWS_NUM_GASES; g++) {
        for (size_t i = 0; i < sizeof(f) / sizeof(f[0]); i++) {
            n += snprintf(line + n, sizeof(line) - n, ",%.5g", (double)f[i][g]);
        }
        n += snprintf(line + n, sizeof(line) - n, ",%d", (int)st->level[g]);
    }
    snprintf(line + n, sizeof(line) - n, ",%d", st->warmup ? 1 : 0);
    ESP_LOGI(TAG, "%s", line);
}

static void ai_replay_task(void *arg)
{
    (void)arg;
    vTaskDelay(pdMS_TO_TICKS(AI_REPLAY_START_DELAY_MS));
    ESP_LOGW(TAG, "replay '%s' start: %u samples (%u min simulated) at x%d", s_replay->name,
             (unsigned)s_replay->count, (unsigned)(s_replay->count * 5 / 60), CONFIG_SA_AI_REPLAY_SPEED);

    const int64_t start_us = esp_timer_get_time();
    uint32_t last_steps = 0;
    /* i == count is an extra all-invalid sample that closes the last 10s step. */
    for (uint32_t i = 0; i <= s_replay->count; i++) {
        int64_t due_us = start_us + (int64_t)i * AI_REPLAY_SAMPLE_MS * 1000 / CONFIG_SA_AI_REPLAY_SPEED;
        int64_t wait_ms = (due_us - esp_timer_get_time()) / 1000;
        TickType_t ticks = wait_ms > 0 ? pdMS_TO_TICKS((uint32_t)wait_ms) : 0;
        vTaskDelay(ticks > 0 ? ticks : 1); /* at least one tick so the idle task still runs */

        gas_ews_sample_t x;
        replay_sample(i, &x);
        gas_ews_feed(&x);

        gas_ews_status_t st;
        gas_ews_get_status(&st);
        if (st.steps != last_steps) {
            last_steps = st.steps;
            /* Wait for ai_task so no step is skipped, however fast the replay runs. */
            xTaskNotifyGive(s_task);
            if (ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(AI_REPLAY_STEP_TIMEOUT_MS)) == 0) {
                ESP_LOGW(TAG, "replay: ai_task did not finish step %u in time", (unsigned)st.steps);
            }
        }
        if (i > 0 && i % 60 == 0) {
            ESP_LOGI(TAG, "replay '%s': sample %u/%u (%u min)", s_replay->name, (unsigned)i,
                     (unsigned)s_replay->count, (unsigned)(i * 5 / 60));
        }
    }
    ESP_LOGW(TAG, "replay '%s' finished: %u steps in %lld s -- AI gets no more input; reboot to replay again",
             s_replay->name, (unsigned)last_steps, (long long)((esp_timer_get_time() - start_us) / 1000000));
    /* Not deleted: ai_task may still notify this handle after a step timeout. */
    while (1) {
        ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
    }
}
#endif

static bool s_stack_logged = false;
static uint32_t s_infer_runs = 0;
static int64_t s_infer_sum_us = 0;
static int64_t s_infer_max_us = 0;

static int64_t now_ms(void)
{
    return esp_timer_get_time() / 1000;
}

static void add_num_or_null(cJSON *obj, const char *key, float v)
{
    if (isnan(v)) {
        cJSON_AddNullToObject(obj, key);
    } else {
        cJSON_AddNumberToObject(obj, key, (double)v);
    }
}

static void publish_ai_state(void)
{
    cJSON *root = cJSON_CreateObject();
    if (root == NULL) {
        ESP_LOGE(TAG, "publish_ai_state: cJSON_CreateObject failed");
        return;
    }
    const gas_ews_status_t *st = &s_status;
    cJSON_AddStringToObject(root, "standard", "QCVN 03:2019/BYT");
    cJSON_AddNumberToObject(root, "level", (double)s_level);
    cJSON_AddStringToObject(root, "level_name", kLevelName[s_level]);
    cJSON_AddBoolToObject(root, "warmup", st->warmup);
    cJSON_AddBoolToObject(root, "model_ready", s_model_ready);
    cJSON_AddBoolToObject(root, "model_ok", st->model_ok);
    for (int g = 0; g < GAS_EWS_NUM_GASES; g++) {
        cJSON *o = cJSON_AddObjectToObject(root, kGasKey[g]);
        if (o == NULL) {
            continue;
        }
        add_num_or_null(o, "ppm", st->ppm[g]);
        add_num_or_null(o, "stel15", st->stel[g]);
        add_num_or_null(o, "twa8h", st->twa[g]);
        add_num_or_null(o, "proj10", st->proj[g]);
        add_num_or_null(o, "p_model", st->p_model[g]);
        cJSON_AddNumberToObject(o, "level", (double)st->level[g]);
        cJSON_AddBoolToObject(o, "rule", st->rule_alarm[g]);
        cJSON_AddBoolToObject(o, "proj_alarm", st->proj_alarm[g]);
        cJSON_AddBoolToObject(o, "model_alarm", st->model_alarm[g]);
    }
#if CONFIG_SA_AI_REPLAY
    cJSON_AddStringToObject(root, "replay", s_replay->name); /* not real sensor data */
#endif
    cJSON_AddNumberToObject(root, "ts", (double)time(NULL));

    char *payload = cJSON_PrintUnformatted(root);
    if (payload != NULL) {
        if (mqtt_publish(s_ai_state_topic, payload, 1, false) < 0) {
            ESP_LOGW(TAG, "ai/state publish failed (MQTT not ready?)");
        }
        cJSON_free(payload);
    }
    cJSON_Delete(root);
    s_last_publish_ms = now_ms();
}

/* Convert the single status copy taken after gas_ews_set_model_result().
 * Invalid raw values are zeroed rather than borrowing forward-filled values;
 * derived/model values carry their own validity masks as Schema v2 requires. */
static incident_snapshot_t incident_snapshot_from_status(const gas_ews_status_t *st, gas_ews_level_t overall)
{
    incident_snapshot_t x = {.warmup = st->warmup, .sensor_valid_mask = st->sensor_valid_mask, .overall_level = (uint8_t)overall,
                             .co_level = (uint8_t)st->level[GAS_EWS_CO], .no2_level = (uint8_t)st->level[GAS_EWS_NO2]};
    if ((x.sensor_valid_mask & 1u) != 0 && isfinite(st->temperature_c)) x.temperature_c_x100 = (int32_t)lroundf(st->temperature_c * 100.0f);
    else x.sensor_valid_mask &= (uint8_t)~1u;
    if ((x.sensor_valid_mask & 2u) != 0 && isfinite(st->humidity_pct) && st->humidity_pct >= 0.0f && st->humidity_pct <= 100.0f) x.humidity_pct_x100 = (uint16_t)lroundf(st->humidity_pct * 100.0f);
    else x.sensor_valid_mask &= (uint8_t)~2u;
    if ((x.sensor_valid_mask & 4u) != 0 && isfinite(st->ppm[GAS_EWS_CO])) x.co_ppm_x1000 = (uint32_t)lroundf(st->ppm[GAS_EWS_CO] * 1000.0f);
    else x.sensor_valid_mask &= (uint8_t)~4u;
    if ((x.sensor_valid_mask & 8u) != 0 && isfinite(st->ppm[GAS_EWS_NO2])) x.no2_ppm_x1000 = (uint32_t)lroundf(st->ppm[GAS_EWS_NO2] * 1000.0f);
    else x.sensor_valid_mask &= (uint8_t)~8u;
    const float *d[] = {st->stel, st->stel, st->twa, st->twa, st->proj, st->proj};
    uint32_t *out[] = {&x.co_stel15_ppm_x1000,&x.no2_stel15_ppm_x1000,&x.co_twa8h_ppm_x1000,&x.no2_twa8h_ppm_x1000,&x.co_proj10_ppm_x1000,&x.no2_proj10_ppm_x1000};
    for (int i=0;i<6;i++) { int g=i&1; if (isfinite(d[i][g]) && d[i][g] >= 0.0f) { *out[i]=(uint32_t)lroundf(d[i][g]*1000.0f); x.derived_valid_mask|=(uint8_t)(1u<<i); } }
    for (int g=0;g<GAS_EWS_NUM_GASES;g++) {
        uint8_t sources=(st->rule_alarm[g]?1u:0u)|(st->proj_alarm[g]?2u:0u)|(st->model_alarm[g]?4u:0u);
        if (g==GAS_EWS_CO) x.co_alarm_source_mask=sources; else x.no2_alarm_source_mask=sources;
        if (isfinite(st->p_model[g]) && st->p_model[g] >= 0.0f && st->p_model[g] <= 1.0f) {
            uint16_t p=(uint16_t)lroundf(st->p_model[g]*10000.0f); x.model_probability_valid_mask|=(uint8_t)(1u<<g);
            if(g==GAS_EWS_CO)x.co_model_probability_bps=p;else x.no2_model_probability_bps=p;
        }
    }
    if (gas_ews_model_sha256(x.model_sha256) != ESP_OK) {
        memset(x.model_sha256, 0, sizeof(x.model_sha256));
    }
    if (config_get_gas_calibration_snapshot(&x.co_r0_q10000,
                                            &x.no2_r0_q10000,
                                            &x.calibration_revision) != ESP_OK) {
        x.co_r0_q10000 = 0;
        x.no2_r0_q10000 = 0;
        x.calibration_revision = 0;
    }
    return x;
}

/* Mirrors relay.c's relay_publish_delta(); "mode" is hardcoded since the
 * caller only runs while device mode is on. */
static esp_err_t ai_publish_shadow_delta(bool enabled)
{
    cJSON *root = cJSON_CreateObject();
    if (root == NULL) {
        ESP_LOGE(TAG, "ai_publish_shadow_delta: cJSON_CreateObject failed");
        return ESP_ERR_NO_MEM;
    }

    cJSON_AddStringToObject(root, "mode", "on");
    cJSON_AddBoolToObject(root, "ai_enabled", enabled);
    cJSON_AddNumberToObject(root, "ts", (double)time(NULL));

    char *payload = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);
    if (payload == NULL) {
        ESP_LOGE(TAG, "ai_publish_shadow_delta: cJSON_PrintUnformatted failed");
        return ESP_ERR_NO_MEM;
    }

    int msg_id = mqtt_publish(s_shadow_topic, payload, 1, false);
    cJSON_free(payload);

    if (msg_id < 0) {
        ESP_LOGW(TAG, "mqtt_publish failed; MQTT not ready yet");
        return ESP_FAIL;
    }

    return ESP_OK;
}

static void record_timing(uint32_t steps, int64_t t0_us, int64_t dt_us)
{
    if (!s_stack_logged) {
        ESP_LOGI(TAG, "first inference at %lld s after boot (step %u): %lld us; stack high-water mark: %u bytes free",
                 (long long)(t0_us / 1000000), (unsigned)steps, (long long)dt_us,
                 (unsigned)uxTaskGetStackHighWaterMark(NULL));
        s_stack_logged = true;
    }
    s_infer_runs++;
    s_infer_sum_us += dt_us;
    if (dt_us > s_infer_max_us) {
        s_infer_max_us = dt_us;
    }
    if (s_infer_runs >= AI_TIMING_REPORT_RUNS) {
        ESP_LOGI(TAG, "inference timing: %u runs, avg %lld us, max %lld us", (unsigned)s_infer_runs,
                 (long long)(s_infer_sum_us / s_infer_runs), (long long)s_infer_max_us);
        s_infer_runs = 0;
        s_infer_sum_us = 0;
        s_infer_max_us = 0;
    }
}

/**
 * @brief On a new gas_ews step: run the model on the 20 min window if one is
 * available, otherwise report "no result" so gas_ews clears a stale model
 * alarm instead of trusting an old output.
 */
static void run_model_on_new_step(void)
{
    gas_ews_get_status(&s_status);
    if (s_status.steps == s_model_steps) {
        return;
    }
    s_model_steps = s_status.steps;

    uint32_t steps = s_status.steps;
    if (!s_model_ready || !gas_ews_get_window(&steps, s_window)) {
        gas_ews_set_model_result(steps, NULL, false);
        return;
    }
    float p[GAS_EWS_NUM_GASES];
    int64_t t0 = esp_timer_get_time();
    esp_err_t err = gas_ews_model_infer(s_window, p);
    record_timing(steps, t0, esp_timer_get_time() - t0);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "gas_ews_model_infer failed (%s)", esp_err_to_name(err));
    }
    gas_ews_set_model_result(steps, p, err == ESP_OK);
}

/** Everything the ai task does for one new 10s step while the AI is switched on. */
static void ai_handle_step(bool just_enabled)
{
    static gas_ews_level_t last_gas_level[GAS_EWS_NUM_GASES] = {GAS_EWS_SAFE, GAS_EWS_SAFE};
    static bool last_model_ok = false, last_warmup = true;

    run_model_on_new_step();
    gas_ews_get_status(&s_status);
#if CONFIG_SA_AI_REPLAY
    replay_log_step(&s_status);
#endif

    gas_ews_level_t prev = s_level;
    s_level = s_status.level[GAS_EWS_CO] > s_status.level[GAS_EWS_NO2] ? s_status.level[GAS_EWS_CO]
                                                                       : s_status.level[GAS_EWS_NO2];
    bool changed = just_enabled || s_status.model_ok != last_model_ok || s_status.warmup != last_warmup;
    for (int g = 0; g < GAS_EWS_NUM_GASES; g++) {
        if (s_status.level[g] != last_gas_level[g]) {
            ESP_LOGW(TAG, "%s: %s -> %s (ppm=%.2f STEL=%.2f TWA=%.2f proj=%.2f p=%.2f)", kGasKey[g],
                     kLevelName[last_gas_level[g]], kLevelName[s_status.level[g]], (double)s_status.ppm[g],
                     (double)s_status.stel[g], (double)s_status.twa[g], (double)s_status.proj[g],
                     (double)s_status.p_model[g]);
            last_gas_level[g] = s_status.level[g];
            changed = true;
        }
    }
    last_model_ok = s_status.model_ok;
    last_warmup = s_status.warmup;

    if (s_level > prev) {
        incident_snapshot_t incident_snapshot = incident_snapshot_from_status(&s_status, s_level);
        ai_alarm_dispatch((uint8_t)prev, (uint8_t)s_level, &incident_snapshot);
    }
    if (changed || now_ms() - s_last_publish_ms >= AI_STATE_PERIOD_MS) {
        publish_ai_state();
    }
}

static void ai_task(void *arg)
{
    (void)arg;
    bool was_enabled = false;

    while (1) {
        /* Woken on every new 10s gas_ews step by ai_feed_sample() (or ai_replay_task). */
        ulTaskNotifyTake(pdTRUE, portMAX_DELAY);

        if (ai_get_enabled()) {
            ai_handle_step(!was_enabled);
            was_enabled = true;
        } else {
            was_enabled = false;
        }
#if CONFIG_SA_AI_REPLAY
        if (s_replay_task != NULL) {
            xTaskNotifyGive(s_replay_task); /* step done: the replay may feed the next one */
        }
#endif
    }
}

esp_err_t ai_start(const char *device_id)
{
    if (device_id == NULL || device_id[0] == '\0') {
        ESP_LOGE(TAG, "ai_start requires non-empty device_id");
        return ESP_ERR_INVALID_ARG;
    }

    snprintf(s_ai_state_topic, sizeof(s_ai_state_topic), "device/%s/ai/state", device_id);
    snprintf(s_shadow_topic, sizeof(s_shadow_topic), "device/%s/shadow/report", device_id);

    int64_t init_t0 = esp_timer_get_time();
    s_model_ready = gas_ews_model_init() == ESP_OK;
    ESP_LOGI(TAG, "gas_ews_model_init (AllocateTensors + 2-window self-test): %lld us",
             (long long)(esp_timer_get_time() - init_t0));
    if (!s_model_ready) {
        ESP_LOGE(TAG, "gas_ews model unavailable this boot -- QCVN STEL/TWA rule and "
                      "projection early warning still active");
    }

    TaskHandle_t task = NULL;
    BaseType_t rc =
        xTaskCreatePinnedToCore(ai_task, AI_TASK_NAME, AI_TASK_STACK_SIZE, NULL, AI_TASK_PRIORITY, &task, APP_CPU_NUM);
    if (rc != pdPASS) {
        ESP_LOGE(TAG, "xTaskCreatePinnedToCore failed");
        return ESP_FAIL;
    }
    s_task = task;

#if CONFIG_SA_AI_REPLAY
    ESP_LOGW(TAG, "AI REPLAY MODE: scenario '%s', %u samples (~%u min) at x%d -- the AI ignores the real sensors",
             s_replay->name, (unsigned)s_replay->count, (unsigned)(s_replay->count * 5 / 60),
             CONFIG_SA_AI_REPLAY_SPEED);
    rc = xTaskCreatePinnedToCore(ai_replay_task, AI_REPLAY_TASK_NAME, AI_REPLAY_TASK_STACK_SIZE, NULL,
                                 AI_REPLAY_TASK_PRIORITY, &s_replay_task, APP_CPU_NUM);
    if (rc != pdPASS) {
        ESP_LOGE(TAG, "replay task create failed");
    }
#endif
    ESP_LOGI(TAG, "ai started: QCVN 03:2019/BYT CO STEL/TWA %.1f/%.1f ppm, NO2 %.2f/%.2f ppm; "
                  "model window %d steps x 10s; topic=%s",
             (double)GAS_EWS_STEL_CO_PPM, (double)GAS_EWS_TWA_CO_PPM, (double)GAS_EWS_STEL_NO2_PPM,
             (double)GAS_EWS_TWA_NO2_PPM, GAS_EWS_WINDOW_STEPS, s_ai_state_topic);
    return ESP_OK;
}

void ai_feed_sample(const gas_ews_sample_t *sample)
{
#if CONFIG_SA_AI_REPLAY
    (void)sample; /* ai_replay_task feeds gas_ews instead of the real sensors */
#else
    if (sample == NULL) {
        return;
    }
    /* gas_ews keeps its history even before ai_start()/while AI is switched
     * off, so the 10 min preheat and the model window are not restarted. */
    gas_ews_feed(sample);

    TaskHandle_t task = s_task;
    if (task == NULL) {
        return;
    }
    gas_ews_status_t st;
    gas_ews_get_status(&st);
    if (st.steps != s_fed_steps) {
        s_fed_steps = st.steps;
        xTaskNotifyGive(task);
    }
#endif
}

#else /* !SA_ENABLE_AI */

esp_err_t ai_start(const char *device_id)
{
    (void)device_id;
    return ESP_OK;
}

void ai_feed_sample(const gas_ews_sample_t *sample)
{
    (void)sample;
}

#endif /* SA_ENABLE_AI */

esp_err_t ai_set_enabled(bool enabled)
{
#if SA_ENABLE_AI
    bool changed = false;

    portENTER_CRITICAL(&s_enabled_lock);
    if (s_enabled != enabled) {
        s_enabled = enabled;
        changed = true;
    }
    portEXIT_CRITICAL(&s_enabled_lock);

    if (!changed) {
        return ESP_OK;
    }

    ESP_LOGI(TAG, "AI runtime switch set to %s", enabled ? "on" : "off");

    esp_err_t err = ai_publish_shadow_delta(enabled);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "AI state changed locally but shadow publish failed: %s", esp_err_to_name(err));
    }

    return ESP_OK;
#else
    (void)enabled;
    ESP_LOGW(TAG, "ai_set_enabled ignored: firmware built with SA_ENABLE_AI=n");
    return ESP_OK;
#endif
}

bool ai_get_enabled(void)
{
#if SA_ENABLE_AI
    bool enabled;

    portENTER_CRITICAL(&s_enabled_lock);
    enabled = s_enabled;
    portEXIT_CRITICAL(&s_enabled_lock);

    return enabled;
#else
    return false;
#endif
}

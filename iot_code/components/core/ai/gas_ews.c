/**
 * @file gas_ews.c
 *
 * @brief See gas_ews.h. Mirrors ungdungdidong/gas_ews/features.py line by
 *        line; tools/test_gas_ews_host.c checks it against golden vectors.
 *
 * Copyright (C) 2026 MinhNhat & BaoViet
 */

#include "gas_ews.h"

#include <math.h>
#include <string.h>

/* sensor_task feeds and the ai task reads from different cores. */
#ifdef ESP_PLATFORM
#include "freertos/FreeRTOS.h"
static portMUX_TYPE s_lock = portMUX_INITIALIZER_UNLOCKED;
#define LOCK()   portENTER_CRITICAL(&s_lock)
#define UNLOCK() portEXIT_CRITICAL(&s_lock)
#else
#define LOCK()   ((void)0)
#define UNLOCK() ((void)0)
#endif

#define NG GAS_EWS_NUM_GASES
#define NCH GAS_EWS_NUM_CHANNELS
#define TWA_BUCKETS (GAS_EWS_TWA_STEPS / GAS_EWS_TWA_BUCKET_STEPS)
/* After a gap this long every history ring is fully overwritten anyway. */
#define MAX_EMPTY_STEPS (GAS_EWS_TWA_STEPS + GAS_EWS_WINDOW_STEPS)

static const double kStel[NG] = {GAS_EWS_STEL_CO_PPM, GAS_EWS_STEL_NO2_PPM};
static const double kTwa[NG] = {GAS_EWS_TWA_CO_PPM, GAS_EWS_TWA_NO2_PPM};
static const double kThrProj[NG] = {GAS_EWS_THR_PROJ_CO, GAS_EWS_THR_PROJ_NO2};
static const float kThrModel[NG] = {GAS_EWS_THR_MODEL_CO, GAS_EWS_THR_MODEL_NO2};

typedef struct {
    bool on;
    uint32_t run_on;
    uint32_t run_off;
} debounce_t;

/* Python train.debounce(): raise after K_ON consecutive hits, clear after K_OFF misses. */
static void debounce_update(debounce_t *d, bool hit)
{
    if (hit) {
        d->run_on++;
        d->run_off = 0;
    } else {
        d->run_off++;
        d->run_on = 0;
    }
    if (!d->on && d->run_on >= GAS_EWS_DEBOUNCE_ON) {
        d->on = true;
    } else if (d->on && d->run_off >= GAS_EWS_DEBOUNCE_OFF) {
        d->on = false;
    }
}

/* ---- slot / step bookkeeping ------------------------------------------- */
static bool s_have_t0;
static int64_t s_t0_ms;
static int64_t s_last_online_slot;  /* -1 before the first online sample */
static int64_t s_warm_until_slot;   /* gas ignored while slot < this */
static int64_t s_cur_step;          /* step currently being accumulated */
static float s_slot_val[GAS_EWS_SLOTS_PER_STEP][4]; /* co, no2, temp, rh (NAN = none) */
static bool s_cur_warm;             /* any slot of the current step in preheat */

/* ---- per-step history --------------------------------------------------- */
static uint32_t s_steps;            /* finalized steps */
static float s_ffill_last[NG];
static uint32_t s_ffill_age[NG];
static float s_th_last[2];          /* temp, rh (unlimited ffill) */
static float s_gas_ring[NG][GAS_EWS_STEL_STEPS];   /* forward-filled gas, NAN allowed */
static double s_twa_bucket[NG][TWA_BUCKETS];
static int64_t s_twa_cur_bucket;
static uint8_t s_valid_ring[GAS_EWS_WINDOW_STEPS];
static float s_chan_ring[GAS_EWS_WINDOW_STEPS][NCH];

static debounce_t s_rule_stel[NG], s_rule_twa[NG], s_proj[NG], s_model[NG];
static uint32_t s_model_steps;      /* last step the model debouncer has consumed */
static gas_ews_status_t s_status;
static void (*s_hook)(const gas_ews_step_debug_t *step);
static bool s_inited;   /* zero-initialized statics are NOT a valid state (NANs, -1, preheat) */

static float compress(double x_rel)
{
    return (float)log2(1.0 + (x_rel > 0.0 ? x_rel : 0.0));
}

static void reset_locked(void)
{
    s_inited = true;
    s_have_t0 = false;
    s_t0_ms = 0;
    s_last_online_slot = -1;
    s_warm_until_slot = GAS_EWS_WARMUP_SLOTS;
    s_cur_step = 0;
    for (int i = 0; i < GAS_EWS_SLOTS_PER_STEP; i++) {
        for (int c = 0; c < 4; c++) {
            s_slot_val[i][c] = NAN;
        }
    }
    s_cur_warm = false;
    s_steps = 0;
    for (int g = 0; g < NG; g++) {
        s_ffill_last[g] = NAN;
        s_ffill_age[g] = GAS_EWS_FFILL_STEPS + 1;
        for (int i = 0; i < GAS_EWS_STEL_STEPS; i++) {
            s_gas_ring[g][i] = NAN;
        }
        for (int i = 0; i < TWA_BUCKETS; i++) {
            s_twa_bucket[g][i] = 0.0;
        }
    }
    s_th_last[0] = NAN;
    s_th_last[1] = NAN;
    s_twa_cur_bucket = -1;
    memset(s_valid_ring, 0, sizeof(s_valid_ring));
    memset(s_chan_ring, 0, sizeof(s_chan_ring));
    memset(s_rule_stel, 0, sizeof(s_rule_stel));
    memset(s_rule_twa, 0, sizeof(s_rule_twa));
    memset(s_proj, 0, sizeof(s_proj));
    memset(s_model, 0, sizeof(s_model));
    s_model_steps = 0;
    memset(&s_status, 0, sizeof(s_status));
    s_status.warmup = true;
    for (int g = 0; g < NG; g++) {
        s_status.ppm[g] = s_status.stel[g] = s_status.twa[g] = s_status.proj[g] = s_status.p_model[g] = NAN;
    }
}

void gas_ews_reset(void)
{
    LOCK();
    if (!s_inited) {
        reset_locked();
    }
    reset_locked();
    UNLOCK();
}

void gas_ews_set_step_hook(void (*hook)(const gas_ews_step_debug_t *step))
{
    LOCK();
    if (!s_inited) {
        reset_locked();
    }
    s_hook = hook;
    UNLOCK();
}

static void update_level(int g)
{
    bool exceeded = s_rule_stel[g].on || s_rule_twa[g].on;
    s_status.rule_alarm[g] = exceeded;
    s_status.proj_alarm[g] = s_proj[g].on;
    s_status.model_alarm[g] = s_model[g].on;
    s_status.level[g] = exceeded ? GAS_EWS_EXCEEDED
                                 : ((s_proj[g].on || s_model[g].on) ? GAS_EWS_EARLY_WARNING : GAS_EWS_SAFE);
}

/* One 10s step k (0-based) with its raw means (NAN = no valid sample). */
static void process_step(int64_t k, const float raw_gas[NG], float raw_t, float raw_rh, bool warm)
{
    float gas[NG];
    double stel[NG], proj[NG], twa[NG];

    for (int g = 0; g < NG; g++) {
        /* forward-fill <= FFILL_STEPS (features._ffill) */
        if (!isnan(raw_gas[g])) {
            s_ffill_last[g] = raw_gas[g];
            s_ffill_age[g] = 0;
            gas[g] = raw_gas[g];
        } else {
            if (s_ffill_age[g] <= GAS_EWS_FFILL_STEPS) {
                s_ffill_age[g]++;
            }
            gas[g] = (s_ffill_age[g] <= GAS_EWS_FFILL_STEPS) ? s_ffill_last[g] : NAN;
        }

        s_gas_ring[g][k % GAS_EWS_STEL_STEPS] = gas[g];

        /* STEL: nanmean of the last 90 steps, >= STEL_MIN_VALID valid */
        double sum = 0.0;
        int cnt = 0;
        for (int i = 0; i < GAS_EWS_STEL_STEPS; i++) {
            float v = s_gas_ring[g][i];
            if (!isnan(v)) {
                sum += v;
                cnt++;
            }
        }
        stel[g] = cnt >= GAS_EWS_STEL_MIN_VALID ? sum / cnt : NAN;

        /* projection: (sum of last 30 + 60 * mean of last 6) / 90, all valid */
        double past = 0.0, lvl = 0.0;
        bool ok = k + 1 >= GAS_EWS_PROJ_PAST_STEPS;
        for (int i = 0; ok && i < GAS_EWS_PROJ_PAST_STEPS; i++) {
            float v = s_gas_ring[g][(k - i) % GAS_EWS_STEL_STEPS];
            if (isnan(v)) {
                ok = false;
            } else {
                past += v;
                if (i < GAS_EWS_PROJ_LEVEL_STEPS) {
                    lvl += v;
                }
            }
        }
        proj[g] = ok ? (past + GAS_EWS_HORIZON_STEPS * (lvl / GAS_EWS_PROJ_LEVEL_STEPS)) / GAS_EWS_STEL_STEPS : NAN;

        /* TWA: sum over the last 480 one-minute buckets (incl. current) / 2880 steps */
        int64_t b = k / GAS_EWS_TWA_BUCKET_STEPS;
        if (b != s_twa_cur_bucket) {
            int64_t from = s_twa_cur_bucket + 1;
            if (b - from >= TWA_BUCKETS) {
                from = b - TWA_BUCKETS + 1;
            }
            for (int64_t j = from; j <= b; j++) {
                s_twa_bucket[g][j % TWA_BUCKETS] = 0.0;
            }
        }
        if (!isnan(gas[g])) {
            s_twa_bucket[g][b % TWA_BUCKETS] += gas[g];
        }
        double tsum = 0.0;
        for (int i = 0; i < TWA_BUCKETS; i++) {
            tsum += s_twa_bucket[g][i];
        }
        twa[g] = tsum / GAS_EWS_TWA_STEPS;
    }
    s_twa_cur_bucket = k / GAS_EWS_TWA_BUCKET_STEPS;

    if (!isnan(raw_t)) {
        s_th_last[0] = raw_t;
    }
    if (!isnan(raw_rh)) {
        s_th_last[1] = raw_rh;
    }
    double t = isnan(s_th_last[0]) ? GAS_EWS_T_REF : s_th_last[0];
    double rh = isnan(s_th_last[1]) ? GAS_EWS_RH_REF : s_th_last[1];

    /* model_ok: last GAS_EWS_WINDOW_STEPS steps all valid (both gases) and both STELs known */
    int w = (int)(k % GAS_EWS_WINDOW_STEPS);
    s_valid_ring[w] = (!isnan(gas[0]) && !isnan(gas[1])) ? 1 : 0;
    int vcnt = 0;
    for (int i = 0; i < GAS_EWS_WINDOW_STEPS; i++) {
        vcnt += s_valid_ring[i];
    }
    bool model_ok = (k + 1 >= GAS_EWS_WINDOW_STEPS) && vcnt == GAS_EWS_WINDOW_STEPS && !isnan(stel[0]) && !isnan(stel[1]);

    float *x = s_chan_ring[w];
    for (int g = 0; g < NG; g++) {
        x[g] = compress((isnan(gas[g]) ? 0.0 : gas[g]) / kStel[g]);
        x[2 + g] = compress((isnan(stel[g]) ? 0.0 : stel[g]) / kStel[g]);
        x[4 + g] = compress((isnan(proj[g]) ? 0.0 : proj[g]) / kStel[g]);
    }
    x[6] = (float)((t - GAS_EWS_T_REF) / GAS_EWS_T_SCALE);
    x[7] = (float)((rh - GAS_EWS_RH_REF) / GAS_EWS_RH_SCALE);

    for (int g = 0; g < NG; g++) {
        debounce_update(&s_rule_stel[g], !isnan(stel[g]) && stel[g] / kStel[g] >= 1.0);
        debounce_update(&s_rule_twa[g], twa[g] / kTwa[g] >= 1.0);
        debounce_update(&s_proj[g], !isnan(proj[g]) && proj[g] / kStel[g] >= kThrProj[g]);
    }

    s_steps = (uint32_t)(k + 1);
    s_status.steps = s_steps;
    s_status.warmup = warm;
    s_status.model_ok = model_ok;
    s_status.sensor_valid_mask = (!isnan(raw_t) ? 1u : 0u) | (!isnan(raw_rh) ? 2u : 0u) |
                                 (!isnan(raw_gas[GAS_EWS_CO]) ? 4u : 0u) |
                                 (!isnan(raw_gas[GAS_EWS_NO2]) ? 8u : 0u);
    s_status.temperature_c = raw_t;
    s_status.humidity_pct = raw_rh;
    for (int g = 0; g < NG; g++) {
        s_status.ppm[g] = gas[g];
        s_status.stel[g] = (float)stel[g];
        s_status.twa[g] = (float)twa[g];
        s_status.proj[g] = (float)proj[g];
        update_level(g);
    }

    if (s_hook != NULL) {
        gas_ews_step_debug_t d = {.k = (uint32_t)k, .model_ok = model_ok};
        for (int g = 0; g < NG; g++) {
            d.ppm[g] = gas[g];
            d.stel[g] = (float)stel[g];
            d.twa[g] = (float)twa[g];
            d.proj[g] = (float)proj[g];
            d.rule_alarm[g] = s_status.rule_alarm[g];
            d.proj_alarm[g] = s_proj[g].on;
        }
        memcpy(d.x, x, sizeof(d.x));
        s_hook(&d);
    }
}

static float nanmean2(float a, float b)
{
    if (isnan(a)) {
        return b;
    }
    if (isnan(b)) {
        return a;
    }
    return (float)(((double)a + (double)b) / 2.0);
}

static void finalize_current_step(void)
{
    float g[NG] = {nanmean2(s_slot_val[0][0], s_slot_val[1][0]), nanmean2(s_slot_val[0][1], s_slot_val[1][1])};
    float t = nanmean2(s_slot_val[0][2], s_slot_val[1][2]);
    float rh = nanmean2(s_slot_val[0][3], s_slot_val[1][3]);
    process_step(s_cur_step, g, t, rh, s_cur_warm);
    for (int i = 0; i < GAS_EWS_SLOTS_PER_STEP; i++) {
        for (int c = 0; c < 4; c++) {
            s_slot_val[i][c] = NAN;
        }
    }
    s_cur_warm = false;
}

void gas_ews_feed(const gas_ews_sample_t *sample)
{
    if (sample == NULL) {
        return;
    }
    LOCK();
    if (!s_inited) {
        reset_locked();
    }
    if (!s_have_t0) {
        s_have_t0 = true;
        s_t0_ms = sample->t_ms;
    }
    int64_t dt = sample->t_ms - s_t0_ms;
    if (dt < 0) {
        UNLOCK();     /* monotonic clock never goes back -- ignore */
        return;
    }
    int64_t slot = (dt + GAS_EWS_SLOT_MS / 2) / GAS_EWS_SLOT_MS;
    int64_t step = slot / GAS_EWS_SLOTS_PER_STEP;
    if (step < s_cur_step) {
        UNLOCK();     /* belongs to an already finalized step */
        return;
    }
    if (step > s_cur_step) {
        finalize_current_step();
        int64_t first_empty = s_cur_step + 1;
        if (step - first_empty > MAX_EMPTY_STEPS) {
            first_empty = step - MAX_EMPTY_STEPS;
        }
        static const float kNan[NG] = {NAN, NAN};
        for (int64_t k = first_empty; k < step; k++) {
            process_step(k, kNan, NAN, NAN, k * GAS_EWS_SLOTS_PER_STEP < s_warm_until_slot);
        }
        s_cur_step = step;
    }

    /* Preheat: first 10 min after start, and after > 60s with no online sample
     * (reboot, power loss, device_mode OFF pausing sensor_task). */
    bool online = sample->co_valid || sample->no2_valid || sample->th_valid;
    if (online) {
        if (slot - s_last_online_slot - 1 > GAS_EWS_GAP_SLOTS) {
            s_warm_until_slot = slot + GAS_EWS_WARMUP_SLOTS;
        }
        s_last_online_slot = slot;
    }
    bool warm = slot < s_warm_until_slot;

    float *v = s_slot_val[slot % GAS_EWS_SLOTS_PER_STEP];   /* same slot twice: last one wins */
    v[0] = (sample->co_valid && !warm) ? sample->co_ppm : NAN;
    v[1] = (sample->no2_valid && !warm) ? sample->no2_ppm : NAN;
    v[2] = sample->th_valid ? sample->temp_c : NAN;
    v[3] = sample->th_valid ? sample->rh_pct : NAN;
    s_cur_warm = s_cur_warm || warm;
    UNLOCK();
}

void gas_ews_get_status(gas_ews_status_t *out)
{
    if (out == NULL) {
        return;
    }
    LOCK();
    if (!s_inited) {
        reset_locked();
    }
    *out = s_status;
    UNLOCK();
}

bool gas_ews_get_window(uint32_t *steps, float out[GAS_EWS_WINDOW_STEPS][GAS_EWS_NUM_CHANNELS])
{
    if (out == NULL) {
        return false;
    }
    LOCK();
    if (!s_inited) {
        reset_locked();
    }
    bool ok = s_status.model_ok;
    if (steps != NULL) {
        *steps = s_steps;
    }
    if (ok) {
        /* s_steps % W is the oldest entry once the ring is full */
        for (uint32_t i = 0; i < GAS_EWS_WINDOW_STEPS; i++) {
            memcpy(out[i], s_chan_ring[(s_steps + i) % GAS_EWS_WINDOW_STEPS], sizeof(out[i]));
        }
    }
    UNLOCK();
    return ok;
}

void gas_ews_set_model_result(uint32_t steps, const float p[GAS_EWS_NUM_GASES], bool valid)
{
    LOCK();
    if (!s_inited) {
        reset_locked();
    }
    if (steps > s_model_steps) {
        /* steps the scheduler never evaluated count as misses */
        uint32_t missed = steps - s_model_steps - 1;
        for (int g = 0; g < NG; g++) {
            for (uint32_t i = 0; i < missed && i < GAS_EWS_DEBOUNCE_OFF + 1; i++) {
                debounce_update(&s_model[g], false);
            }
            bool hit = valid && p != NULL && p[g] >= kThrModel[g];
            debounce_update(&s_model[g], hit);
            s_status.p_model[g] = (valid && p != NULL) ? p[g] : NAN;
            update_level(g);
        }
        s_model_steps = steps;
    }
    UNLOCK();
}

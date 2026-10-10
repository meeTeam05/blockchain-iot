/**
 * @file test_gas_ews_host.c
 *
 * @brief Host test for gas_ews: replays golden vectors produced by the
 *        Python reference (ungdungdidong/gas_ews/export_firmware.py) and
 *        checks gas_ews.c reproduces every 10s step -- preprocessing, STEL,
 *        TWA, projection, all 8 model channels, QCVN rule and projection
 *        alarms. Plus unit tests for the model-alarm debounce.
 *
 * Build & run (from iot_code/components/core/ai/tools):
 *     gcc -std=c99 -O2 -Wall -Wextra -I../include test_gas_ews_host.c \
 *         ../gas_ews.c -o test_gas_ews -lm && ./test_gas_ews golden
 *
 * Copyright (C) 2026 MinhNhat & BaoViet
 */

#include "gas_ews.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int g_failures = 0;

#define CHECK(cond, ...) do { \
    if (!(cond)) { printf("[FAIL] "); printf(__VA_ARGS__); printf(" (line %d)\n", __LINE__); g_failures++; } \
    else { printf("[ OK ] "); printf(__VA_ARGS__); printf("\n"); } \
} while (0)

/* ------------------------------------------------------------------ CSV */
#define MAX_COLS 32
typedef struct {
    int ncols;
    char names[MAX_COLS][24];
    int nrows;
    double *v; /* nrows * ncols */
} table_t;

static int load_csv(const char *path, table_t *t)
{
    FILE *f = fopen(path, "r");
    if (f == NULL) {
        return -1;
    }
    char line[4096];
    if (fgets(line, sizeof(line), f) == NULL) {
        fclose(f);
        return -1;
    }
    t->ncols = 0;
    for (char *tok = strtok(line, ",\r\n"); tok && t->ncols < MAX_COLS; tok = strtok(NULL, ",\r\n")) {
        strncpy(t->names[t->ncols], tok, sizeof(t->names[0]) - 1);
        t->names[t->ncols][sizeof(t->names[0]) - 1] = 0;
        t->ncols++;
    }
    int cap = 1024;
    t->v = malloc(sizeof(double) * cap * t->ncols);
    t->nrows = 0;
    while (fgets(line, sizeof(line), f) != NULL) {
        if (t->nrows == cap) {
            cap *= 2;
            t->v = realloc(t->v, sizeof(double) * cap * t->ncols);
        }
        char *p = line;
        for (int c = 0; c < t->ncols; c++) {
            char *end;
            t->v[t->nrows * t->ncols + c] = strtod(p, &end);
            p = (*end == ',') ? end + 1 : end;
        }
        t->nrows++;
    }
    fclose(f);
    return 0;
}

static int col(const table_t *t, const char *name)
{
    for (int c = 0; c < t->ncols; c++) {
        if (strcmp(t->names[c], name) == 0) {
            return c;
        }
    }
    fprintf(stderr, "missing column %s\n", name);
    exit(2);
}

#define CELL(t, r, c) ((t)->v[(r) * (t)->ncols + (c)])

/* ------------------------------------------------------------------ golden replay */
#define MAX_STEPS 8000
static gas_ews_step_debug_t g_steps[MAX_STEPS];
static int g_nsteps;

static void hook(const gas_ews_step_debug_t *d)
{
    if (g_nsteps < MAX_STEPS) {
        g_steps[g_nsteps++] = *d;
    }
}

static bool close_enough(double a, double b)
{
    if (isnan(a) || isnan(b)) {
        return isnan(a) && isnan(b);
    }
    return fabs(a - b) <= 2e-4 + 2e-5 * fabs(b);
}

static void replay(const char *dir, const char *name)
{
    char pin[512], pout[512];
    snprintf(pin, sizeof(pin), "%s/gas_ews_golden_%s_in.csv", dir, name);
    snprintf(pout, sizeof(pout), "%s/gas_ews_golden_%s_out.csv", dir, name);
    table_t in = {0}, ex = {0};
    if (load_csv(pin, &in) != 0 || load_csv(pout, &ex) != 0) {
        CHECK(0, "%s: golden files readable", name);
        return;
    }

    gas_ews_reset();
    g_nsteps = 0;
    gas_ews_set_step_hook(hook);
    int ct = col(&in, "t_ms"), cco = col(&in, "co"), cno2 = col(&in, "no2"), cte = col(&in, "temp"), crh = col(&in, "rh");
    for (int r = 0; r < in.nrows; r++) {
        gas_ews_sample_t s = {
            .t_ms = (int64_t)CELL(&in, r, ct),
            .co_ppm = (float)CELL(&in, r, cco), .no2_ppm = (float)CELL(&in, r, cno2),
            .temp_c = (float)CELL(&in, r, cte), .rh_pct = (float)CELL(&in, r, crh),
        };
        s.co_valid = !isnan(s.co_ppm);
        s.no2_valid = !isnan(s.no2_ppm);
        s.th_valid = !isnan(s.temp_c) && !isnan(s.rh_pct);
        gas_ews_feed(&s);
    }
    gas_ews_set_step_hook(NULL);

    /* the last step is only finalized when the next one starts */
    int n = ex.nrows < g_nsteps ? ex.nrows : g_nsteps;
    CHECK(n >= ex.nrows - 1, "%s: C produced %d steps, Python %d", name, g_nsteps, ex.nrows);

    const char *fnames[] = {"co", "no2", "stel_co", "stel_no2", "twa_co", "twa_no2", "proj_co", "proj_no2"};
    int bad_total = 0;
    for (int f = 0; f < 8 + GAS_EWS_NUM_CHANNELS; f++) {
        char cname[16];
        if (f < 8) {
            snprintf(cname, sizeof(cname), "%s", fnames[f]);
        } else {
            snprintf(cname, sizeof(cname), "x%d", f - 8);
        }
        int c = col(&ex, cname), bad = 0, first = -1;
        for (int k = 0; k < n; k++) {
            const gas_ews_step_debug_t *d = &g_steps[k];
            double got;
            if (f < 8) {
                int g = f % 2;
                const float *arr[] = {d->ppm, d->stel, d->twa, d->proj};
                got = arr[f / 2][g];
            } else {
                got = d->x[f - 8];
            }
            if (!close_enough(got, CELL(&ex, k, c))) {
                if (first < 0) {
                    first = k;
                }
                bad++;
            }
        }
        if (bad) {
            const gas_ews_step_debug_t *d = &g_steps[first];
            printf("       %s: first mismatch step %d (C k=%u) python=%.7g\n", cname, first, d->k, CELL(&ex, first, c));
        }
        bad_total += bad;
        CHECK(bad == 0, "%s: %-8s matches Python on %d steps (%d mismatches)", name, cname, n, bad);
    }

    const char *bnames[] = {"model_ok", "rule_co", "rule_no2", "lp_co", "lp_no2"};
    for (int b = 0; b < 5; b++) {
        int c = col(&ex, bnames[b]), bad = 0, ones = 0;
        for (int k = 0; k < n; k++) {
            const gas_ews_step_debug_t *d = &g_steps[k];
            bool got = b == 0 ? d->model_ok : (b <= 2 ? d->rule_alarm[b - 1] : d->proj_alarm[b - 3]);
            bool want = CELL(&ex, k, c) != 0.0;
            bad += got != want;
            ones += want;
        }
        CHECK(bad == 0, "%s: %-8s matches Python (%d steps true, %d mismatches)", name, bnames[b], ones, bad);
    }
    (void)bad_total;
    free(in.v);
    free(ex.v);
}

/* ------------------------------------------------------------------ unit tests */
static void feed_const(int64_t t0_ms, int n, float co, float no2)
{
    for (int i = 0; i < n; i++) {
        gas_ews_sample_t s = {.t_ms = t0_ms + (int64_t)i * 5000, .co_ppm = co, .no2_ppm = no2,
                              .temp_c = 30, .rh_pct = 70, .co_valid = true, .no2_valid = true, .th_valid = true};
        gas_ews_feed(&s);
    }
}

static void test_warmup_and_gap(void)
{
    gas_ews_status_t st;
    gas_ews_reset();
    feed_const(0, 100, 3.0f, 0.05f);                   /* 500 s: still in 10 min preheat */
    gas_ews_get_status(&st);
    CHECK(isnan(st.ppm[0]) && st.warmup, "preheat: gas ignored for the first 10 min");
    feed_const(100 * 5000, 60, 3.0f, 0.05f);           /* now past 600 s */
    gas_ews_get_status(&st);
    CHECK(!isnan(st.ppm[0]) && fabsf(st.ppm[0] - 3.0f) < 1e-6f, "after preheat: gas used (%.2f ppm)", st.ppm[0]);
    feed_const(160 * 5000 + 120000, 10, 3.0f, 0.05f); /* 2 min silence = reboot/outage */
    gas_ews_get_status(&st);
    CHECK(isnan(st.ppm[0]) && st.warmup, "outage > 60 s restarts the preheat window");
}

static void test_model_debounce(void)
{
    gas_ews_status_t st;
    const float hi[2] = {0.99f, 0.0f}, lo[2] = {0.0f, 0.0f};
    gas_ews_reset();
    gas_ews_set_model_result(1, hi, true);
    gas_ews_get_status(&st);
    CHECK(!st.model_alarm[0], "model alarm needs %d consecutive steps", GAS_EWS_DEBOUNCE_ON);
    gas_ews_set_model_result(2, hi, true);
    gas_ews_get_status(&st);
    CHECK(st.model_alarm[0] && st.level[0] == GAS_EWS_EARLY_WARNING && !st.model_alarm[1],
          "2 consecutive p>=thr -> CO early warning, NO2 untouched");
    gas_ews_set_model_result(2, lo, true);                      /* same step again: ignored */
    gas_ews_set_model_result(2 + GAS_EWS_DEBOUNCE_OFF - 1, lo, true);
    gas_ews_get_status(&st);
    CHECK(st.model_alarm[0], "still on before %d misses (skipped steps count as misses)", GAS_EWS_DEBOUNCE_OFF);
    gas_ews_set_model_result(2 + GAS_EWS_DEBOUNCE_OFF, lo, false);
    gas_ews_get_status(&st);
    CHECK(!st.model_alarm[0] && st.level[0] == GAS_EWS_SAFE && isnan(st.p_model[0]),
          "cleared after %d misses; invalid result -> p_model NAN", GAS_EWS_DEBOUNCE_OFF);
}

int main(int argc, char **argv)
{
    const char *dir = argc > 1 ? argv[1] : "golden";
    test_warmup_and_gap();
    test_model_debounce();
    replay(dir, "sim_co");
    replay(dir, "sim_no2");
    replay(dir, "device");
    printf(g_failures ? "\n%d check(s) FAILED\n" : "\nAll tests passed.\n", g_failures);
    return g_failures ? 1 : 0;
}

/**
 * @file sim_gas_ews_timeline.c
 *
 * @brief Host-side timeline simulation of gas_ews (rule + projection
 *        only, no model): feeds 5s samples into the real gas_ews.c and
 *        prints when each stage becomes available and when alarms fire.
 *        Source of the numbers in REVIEW_HOAT_DONG.md and README.md.
 *
 *   cd tools && gcc -std=c99 -O2 -I../include sim_gas_ews_timeline.c ../gas_ews.c -o sim -lm && ./sim
 *
 * Copyright (C) 2026 MinhNhat & BaoViet
 */

#include "gas_ews.h"

#include <math.h>
#include <stdio.h>

#define POLL_S 5.0
#define CLEAN_CO 2.0f
#define CLEAN_NO2 0.05f

typedef struct {
    const char *name;
    int gas;           /* GAS_EWS_CO / GAS_EWS_NO2 */
    float level;       /* ppm while the event is on */
    double start_s;    /* event start */
    double dur_s;      /* event duration, <0 = until the end */
    double hours;      /* total simulated time */
    double reboot_s;   /* >0: device reboots here (gas_ews history lost) */
} scenario_t;

static float gas_at(const scenario_t *sc, int g, double t)
{
    bool on = t >= sc->start_s && (sc->dur_s < 0 || t < sc->start_s + sc->dur_s);
    if (g == sc->gas && on) {
        return sc->level;
    }
    return g == GAS_EWS_CO ? CLEAN_CO : CLEAN_NO2;
}

static void run(const scenario_t *sc)
{
    gas_ews_reset();
    double preheat_end = -1, stel = -1, proj = -1, model_ok = -1;
    double early = -1, exceeded = -1, twa_alarm = -1, safe_again = -1;
    double t_boot = 0;
    bool rebooted = false;
    uint32_t last = 0;
    int g = sc->gas;
    double end = sc->start_s + sc->dur_s;

    for (double t = 0; t < sc->hours * 3600; t += POLL_S) {
        if (sc->reboot_s > 0 && !rebooted && t >= sc->reboot_s) {
            gas_ews_reset();
            rebooted = true;
            t_boot = t;
        }
        gas_ews_sample_t s = {
            .t_ms = (int64_t)((t - t_boot) * 1000),
            .co_ppm = gas_at(sc, GAS_EWS_CO, t),
            .no2_ppm = gas_at(sc, GAS_EWS_NO2, t),
            .temp_c = 28, .rh_pct = 70,
            .co_valid = true, .no2_valid = true, .th_valid = true,
        };
        gas_ews_feed(&s);
        gas_ews_status_t st;
        gas_ews_get_status(&st);
        if (st.steps == last) {
            continue;
        }
        last = st.steps;
        gas_ews_set_model_result(st.steps, NULL, false); /* model off: rule + projection only */

        if (preheat_end < 0 && !st.warmup) preheat_end = t;
        if (stel < 0 && !isnan(st.stel[g])) stel = t;
        if (proj < 0 && !isnan(st.proj[g])) proj = t;
        if (model_ok < 0 && st.model_ok) model_ok = t;
        if (t >= sc->start_s) {
            if (early < 0 && st.level[g] >= GAS_EWS_EARLY_WARNING) early = t;
            if (exceeded < 0 && st.level[g] == GAS_EWS_EXCEEDED) exceeded = t;
            if (twa_alarm < 0 && st.twa[g] >= (g == GAS_EWS_CO ? GAS_EWS_TWA_CO_PPM : GAS_EWS_TWA_NO2_PPM)) twa_alarm = t;
        }
        if (sc->dur_s >= 0 && t >= end && safe_again < 0 && st.level[g] == GAS_EWS_SAFE) safe_again = t;
    }

#define REL(x) ((x) < 0 ? -1.0 : (x) - sc->start_s)
    printf("%-34s preheat_end=%5.0fs stel=%5.0fs proj=%5.0fs model_ok=%5.0fs | "
           "from event start: early=%+6.0fs exceeded=%+6.0fs twa=%+6.0fs | safe %5.0fs after event\n",
           sc->name, preheat_end, stel, proj, model_ok, REL(early), REL(exceeded), REL(twa_alarm),
           safe_again < 0 ? -1.0 : safe_again - end);
}

int main(void)
{
    static const scenario_t kScenarios[] = {
        {"CO 40 ppm 30 min @1h", GAS_EWS_CO, 40, 3600, 1800, 3, 0},
        {"CO 50 ppm 30 min @1h", GAS_EWS_CO, 50, 3600, 1800, 3, 0},
        {"CO 100 ppm 30 min @1h", GAS_EWS_CO, 100, 3600, 1800, 3, 0},
        {"CO 300 ppm @1h", GAS_EWS_CO, 300, 3600, -1, 1.5, 0},
        {"CO 1000 ppm @1h", GAS_EWS_CO, 1000, 3600, -1, 1.5, 0},
        {"NO2 8 ppm 30 min @1h", GAS_EWS_NO2, 8, 3600, 1800, 3, 0},
        {"CO 20 ppm from boot", GAS_EWS_CO, 20, 0, -1, 12, 0},
        {"CO 25 ppm from boot", GAS_EWS_CO, 25, 0, -1, 12, 0},
        {"CO 30 ppm from boot", GAS_EWS_CO, 30, 0, -1, 12, 0},
        {"CO 25 ppm from boot, reboot at 5h", GAS_EWS_CO, 25, 0, -1, 14, 5 * 3600},
        {"NO2 3 ppm from boot", GAS_EWS_NO2, 3, 0, -1, 12, 0},
    };
    for (size_t i = 0; i < sizeof(kScenarios) / sizeof(kScenarios[0]); i++) {
        run(&kScenarios[i]);
    }
    return 0;
}

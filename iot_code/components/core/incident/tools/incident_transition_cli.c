/* Host-only transition tests using incident.c's actual candidate gate. */
#define INCIDENT_HOST_TEST 1
#include "../incident.c"

static void valid_snapshot(incident_snapshot_t *s, uint8_t level, bool no2)
{
    memset(s, 0, sizeof(*s));
    s->time_source = INCIDENT_TIME_SNTP; s->observed_at = 1790394600;
    s->overall_level = level;
    if (no2) { s->sensor_valid_mask = 8; s->no2_level = level; s->no2_ppm_x1000 = 100; }
    else { s->sensor_valid_mask = 4; s->co_level = level; s->co_ppm_x1000 = 100; }
}

static bool candidate(uint8_t before, uint8_t after, const incident_snapshot_t *snapshot, work_t *work)
{
    return prepare_incident_work(before, after, snapshot, work);
}

static bool allowed(void)
{
    incident_snapshot_t s; work_t w;
    valid_snapshot(&s, 1, false);
    if (!candidate(0, 1, &s, &w) || w.new_level != 1) return false;
    valid_snapshot(&s, 2, true);
    if (!candidate(0, 2, &s, &w) || w.new_level != 2) return false;
    valid_snapshot(&s, 2, false);
    return candidate(1, 2, &s, &w) && w.new_level == 2;
}

static bool rejected_same(void)
{
    incident_snapshot_t s; work_t w;
    for (uint8_t level = 0; level <= 2; ++level) {
        valid_snapshot(&s, level == 0 ? 1 : level, false);
        if (candidate(level, level, &s, &w)) return false;
    }
    return true;
}

static bool rejected_decreasing(void)
{
    incident_snapshot_t s; work_t w; valid_snapshot(&s, 1, false);
    if (candidate(1, 0, &s, &w) || candidate(2, 1, &s, &w)) return false;
    valid_snapshot(&s, 1, false);
    return !candidate(2, 0, &s, &w);
}

static bool warmup(void)
{
    incident_snapshot_t s; work_t w; valid_snapshot(&s, 1, false); s.warmup = true;
    return !candidate(0, 1, &s, &w);
}

static bool invalid_gas(void)
{
    incident_snapshot_t s; work_t w;
    valid_snapshot(&s, 1, false); s.sensor_valid_mask &= (uint8_t)~4u;
    if (candidate(0, 1, &s, &w)) return false;
    valid_snapshot(&s, 2, true); s.sensor_valid_mask &= (uint8_t)~8u;
    if (candidate(0, 2, &s, &w)) return false;
    valid_snapshot(&s, 1, false); s.co_level = 0; s.no2_level = 0;
    return !candidate(0, 1, &s, &w);
}

static bool invalid_time(void)
{
    incident_snapshot_t s; work_t w; valid_snapshot(&s, 1, false); s.time_source = INCIDENT_TIME_NONE;
    if (candidate(0, 1, &s, &w)) return false;
    valid_snapshot(&s, 1, false); s.observed_at = 0;
    return !candidate(0, 1, &s, &w);
}

static bool valid_times(void)
{
    incident_snapshot_t s; work_t w; valid_snapshot(&s, 1, false);
    if (!candidate(0, 1, &s, &w)) return false;
    s.time_source = INCIDENT_TIME_DS3231;
    return candidate(0, 1, &s, &w);
}

static bool mapping(void)
{
    uint8_t kind, severity; incident_kind_and_severity(1, &kind, &severity);
    if (kind != 1 || severity != 1) return false;
    incident_kind_and_severity(2, &kind, &severity);
    return kind == 2 && severity == 2;
}

static bool no_duplicate(void)
{
    incident_snapshot_t s; work_t w; unsigned count = 0;
    valid_snapshot(&s, 1, false); if (candidate(0, 1, &s, &w)) ++count;
    if (candidate(1, 1, &s, &w)) ++count;
    if (candidate(1, 1, &s, &w)) ++count;
    return count == 1;
}

static void report(const char *name, bool pass) { printf("%s: %s\n", name, pass ? "PASS" : "FAIL"); }

int main(void)
{
    bool a = allowed(), same = rejected_same(), down = rejected_decreasing(), heart = rejected_same();
    bool warm = warmup(), gas = invalid_gas(), time = invalid_time(), clocks = valid_times(), map = mapping(), dup = no_duplicate();
    report("ALLOWED TRANSITIONS", a); report("REJECT SAME LEVEL", same); report("REJECT DECREASING LEVEL", down);
    report("HEARTBEAT REJECTION", heart); report("WARMUP REJECTION", warm); report("INVALID TRIGGER GAS", gas);
    report("INVALID TIME", time); report("VALID SNTP", clocks); report("VALID RTC", clocks);
    report("KIND/SEVERITY MAPPING", map); report("NO DUPLICATE INCIDENT", dup);
    return a && same && down && heart && warm && gas && time && clocks && map && dup ? 0 : 1;
}

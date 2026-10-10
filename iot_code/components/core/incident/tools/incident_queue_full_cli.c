#define INCIDENT_HOST_QUEUE_TEST 1
#define INCIDENT_HOST_ACK_TEST 1
#define main incident_persistence_suite_main
#include "incident_persistence_cli.c"
#undef main

#include "mqtt.h"
#include "../../ai/ai_alarm_dispatch.c"

enum { EV_WORK_SEND = 10, EV_BUZZER = 11 };

typedef struct {
    work_t items[INCIDENT_WORK_QUEUE_CAPACITY];
    unsigned count;
    unsigned calls;
    unsigned rejects;
    uint32_t last_timeout;
} host_work_queue_t;

static host_work_queue_t g_work_queue;
static unsigned g_buzzer_calls;
static size_t g_buzzer_steps;

int xQueueSend(QueueHandle_t queue, const void *item, uint32_t timeout)
{
    host_work_queue_t *work_queue = queue;
    if (!work_queue || !item) return pdFALSE;
    ++work_queue->calls;
    work_queue->last_timeout = timeout;
    event(EV_WORK_SEND);
    if (work_queue->count == INCIDENT_WORK_QUEUE_CAPACITY) {
        ++work_queue->rejects;
        return pdFALSE;
    }
    work_queue->items[work_queue->count++] = *(const work_t *)item;
    return pdTRUE;
}

void buzzer_beep_pattern(const buzzer_pattern_step_t *steps, size_t count)
{
    if (steps && count > 0) {
        ++g_buzzer_calls;
        g_buzzer_steps = count;
        event(EV_BUZZER);
    }
}

static void reset_work_queue(void)
{
    memset(&g_work_queue, 0, sizeof(g_work_queue));
    g_buzzer_calls = 0;
    g_buzzer_steps = 0;
    s_work = &g_work_queue;
    incident_set_time_source(INCIDENT_TIME_SNTP);
}

static unsigned persistent_count(void)
{
    unsigned count = 0;
    for (unsigned i = 0; i < INCIDENT_QUEUE_CAPACITY; ++i) {
        queued_record_t record;
        if (load_record(i, &record)) ++count;
    }
    return count;
}

static bool records_distinct(const queued_record_t *a, const queued_record_t *b)
{
    return a->sequence != b->sequence && memcmp(a->incident_id, b->incident_id, 32) != 0 &&
           memcmp(a->evidence_hash, b->evidence_hash, 32) != 0 &&
           memcmp(a->signature, b->signature, 65) != 0 &&
           (a->len != b->len || memcmp(a->payload, b->payload, a->len) != 0);
}

static bool fill_persistent(unsigned count, queued_record_t records[INCIDENT_QUEUE_CAPACITY])
{
    reset_all();
    for (unsigned i = 0; i < count; ++i) {
        work_t work = valid_work(0, 1, UINT64_C(1700020000) + i);
        work.snapshot.temperature_c_x100 += (int32_t)i;
        process_work(&work);
    }
    if (persistent_count() != count) return false;
    for (unsigned i = 0; i < count; ++i) {
        if (!load_record(i, &records[i])) return false;
        for (unsigned j = 0; j < i; ++j) if (!records_distinct(&records[i], &records[j])) return false;
    }
    return true;
}

static void snapshot_slots(blob_t slots[INCIDENT_QUEUE_CAPACITY])
{
    memcpy(slots, g_blobs, sizeof(g_blobs));
}

static bool slots_equal(const blob_t slots[INCIDENT_QUEUE_CAPACITY])
{
    return memcmp(slots, g_blobs, sizeof(g_blobs)) == 0;
}

static bool make_ack(char out[512], const queued_record_t *record)
{
    char id[67], hash[67];
    hex32(record->incident_id, id);
    hex32(record->evidence_hash, hash);
    int length = snprintf(out, 512,
                          "{\"schema_version\":2,\"incident_id\":\"%s\","
                          "\"evidence_hash\":\"%s\",\"accepted\":true,"
                          "\"error_code\":\"\",\"received_at\":\"2026-09-27T07:00:00Z\"}",
                          id, hash);
    return length > 0 && length < 512;
}

static bool persistent_queue_fill(void)
{
    queued_record_t records[INCIDENT_QUEUE_CAPACITY];
    return fill_persistent(INCIDENT_QUEUE_CAPACITY, records) &&
           persistent_count() == INCIDENT_QUEUE_CAPACITY && find_empty() == -1 &&
           g_sequence == INCIDENT_QUEUE_CAPACITY && g_sign_calls == INCIDENT_QUEUE_CAPACITY;
}

static bool persistent_overflow_rejected(void)
{
    queued_record_t records[INCIDENT_QUEUE_CAPACITY]; blob_t before[INCIDENT_QUEUE_CAPACITY];
    if (!fill_persistent(INCIDENT_QUEUE_CAPACITY, records)) return false;
    snapshot_slots(before);
    uint64_t sequence = g_sequence; unsigned signs = g_sign_calls, publishes = g_publish_calls;
    work_t overflow = valid_work(0, 1, 1700021000);
    process_work(&overflow);
    return s_queue_full_count == 1 && persistent_count() == INCIDENT_QUEUE_CAPACITY &&
           slots_equal(before) && sequence == g_sequence && signs == g_sign_calls &&
           publishes == g_publish_calls;
}

static bool work_queue_overflow_rejected(void)
{
    reset_all(); reset_work_queue();
    incident_snapshot_t snapshot = valid_work(0, 1, 1700022000).snapshot;
    for (unsigned i = 0; i < INCIDENT_WORK_QUEUE_CAPACITY + 1; ++i) {
        incident_on_gas_ews_transition(0, 1, &snapshot);
    }
    if (g_work_queue.count != INCIDENT_WORK_QUEUE_CAPACITY ||
        g_work_queue.calls != INCIDENT_WORK_QUEUE_CAPACITY + 1 || g_work_queue.rejects != 1 ||
        g_work_queue.last_timeout != 0 || s_queue_full_count != 0 || g_sequence_present ||
        g_sign_calls != 0 || g_publish_calls != 0) return false;
    for (unsigned i = 0; i < g_work_queue.count; ++i) {
        if (g_work_queue.items[i].previous_level != 0 || g_work_queue.items[i].new_level != 1) return false;
    }
    return true;
}

static bool local_safety_unaffected(void)
{
    reset_all(); reset_work_queue();
    incident_snapshot_t snapshot = valid_work(0, 1, 1700023000).snapshot;
    for (unsigned i = 0; i < INCIDENT_WORK_QUEUE_CAPACITY; ++i) {
        incident_on_gas_ews_transition(0, 1, &snapshot);
    }
    g_event_count = 0; g_buzzer_calls = 0;
    uint8_t local_level = 1;
    ai_alarm_dispatch(0, local_level, &snapshot);
    bool work_full_safe = local_level == 1 && g_buzzer_calls == 1 && g_buzzer_steps == 5 &&
                          g_work_queue.rejects == 1 && g_work_queue.count == INCIDENT_WORK_QUEUE_CAPACITY &&
                          event_before(EV_BUZZER, EV_WORK_SEND);

    queued_record_t records[INCIDENT_QUEUE_CAPACITY];
    if (!work_full_safe || !fill_persistent(INCIDENT_QUEUE_CAPACITY, records)) return false;
    reset_work_queue(); g_event_count = 0;
    local_level = 2;
    snapshot = valid_work(1, 2, 1700023001).snapshot;
    ai_alarm_dispatch(1, local_level, &snapshot);
    if (g_work_queue.count != 1 || g_buzzer_calls != 1 || g_buzzer_steps != 7 ||
        !event_before(EV_BUZZER, EV_WORK_SEND)) return false;
    process_work(&g_work_queue.items[0]);
    return local_level == 2 && s_queue_full_count == 1 &&
           persistent_count() == INCIDENT_QUEUE_CAPACITY;
}

static bool queue_full_counter(void)
{
    queued_record_t records[INCIDENT_QUEUE_CAPACITY];
    if (!fill_persistent(INCIDENT_QUEUE_CAPACITY, records) || s_queue_full_count != 0) return false;
    work_t overflow = valid_work(0, 1, 1700024000);
    uint64_t sequence = g_sequence;
    process_work(&overflow);
    if (s_queue_full_count != 1 || g_sequence != sequence) return false;
    process_work(&overflow);
    return s_queue_full_count == 2 && g_sequence == sequence;
}

static bool no_overwrite(void)
{
    queued_record_t records[INCIDENT_QUEUE_CAPACITY]; blob_t before[INCIDENT_QUEUE_CAPACITY];
    if (!fill_persistent(INCIDENT_QUEUE_CAPACITY, records)) return false;
    snapshot_slots(before); work_t overflow = valid_work(0, 1, 1700025000);
    process_work(&overflow); process_work(&overflow); process_work(&overflow);
    return persistent_count() == INCIDENT_QUEUE_CAPACITY && slots_equal(before);
}

static bool no_partial_record(void)
{
    queued_record_t records[INCIDENT_QUEUE_CAPACITY], loaded; blob_t before[INCIDENT_QUEUE_CAPACITY];
    if (!fill_persistent(INCIDENT_QUEUE_CAPACITY, records)) return false;
    snapshot_slots(before); work_t overflow = valid_work(0, 1, 1700026000); process_work(&overflow);
    reset_runtime();
    if (!slots_equal(before) || persistent_count() != INCIDENT_QUEUE_CAPACITY ||
        g_staged.blob || g_staged.erase || g_staged.sequence) return false;
    for (unsigned i = 0; i < INCIDENT_QUEUE_CAPACITY; ++i) {
        if (!g_blobs[i].present || g_blobs[i].len != sizeof(queued_record_t) ||
            !load_record(i, &loaded) || loaded.len == 0 ||
            memcmp(&loaded, &records[i], sizeof(loaded)) != 0) return false;
    }
    return true;
}

static bool ack_frees_capacity(void)
{
    queued_record_t records[INCIDENT_QUEUE_CAPACITY], replacement; char ack[512];
    if (!fill_persistent(INCIDENT_QUEUE_CAPACITY, records)) return false;
    unsigned target = INCIDENT_QUEUE_CAPACITY / 2;
    blob_t before[INCIDENT_QUEUE_CAPACITY]; snapshot_slots(before);
    if (!make_ack(ack, &records[target]) || incident_handle_ack(ack) != ESP_OK ||
        persistent_count() != INCIDENT_QUEUE_CAPACITY - 1 || g_blobs[target].present) return false;
    uint64_t sequence = g_sequence; work_t work = valid_work(0, 1, 1700027000); process_work(&work);
    if (persistent_count() != INCIDENT_QUEUE_CAPACITY || !load_record(target, &replacement) ||
        replacement.sequence != sequence + 1 || !records_distinct(&replacement, &records[target])) return false;
    for (unsigned i = 0; i < INCIDENT_QUEUE_CAPACITY; ++i) {
        if (i != target && memcmp(&before[i], &g_blobs[i], sizeof(before[i])) != 0) return false;
    }
    return true;
}

static bool retry_while_full(void)
{
    queued_record_t records[INCIDENT_QUEUE_CAPACITY]; blob_t before[INCIDENT_QUEUE_CAPACITY];
    if (!fill_persistent(INCIDENT_QUEUE_CAPACITY, records)) return false;
    snapshot_slots(before); uint64_t sequence = g_sequence; unsigned signs = g_sign_calls;
    g_publish_calls = 0; g_mqtt_online = true; s_retry_count = 0;
    incident_retry_pending();
    if (g_publish_calls != INCIDENT_QUEUE_CAPACITY || s_retry_count != INCIDENT_QUEUE_CAPACITY ||
        g_sequence != sequence || g_sign_calls != signs || !slots_equal(before)) return false;
    for (unsigned i = 0; i < INCIDENT_QUEUE_CAPACITY; ++i) {
        if (g_published_len[i] != records[i].len ||
            memcmp(g_published[i], records[i].payload, records[i].len) != 0) return false;
    }
    return true;
}

static bool reboot_while_full(void)
{
    queued_record_t records[INCIDENT_QUEUE_CAPACITY], loaded; blob_t before[INCIDENT_QUEUE_CAPACITY]; char ack[512];
    if (!fill_persistent(INCIDENT_QUEUE_CAPACITY, records)) return false;
    snapshot_slots(before); uint64_t sequence = g_sequence; reset_runtime();
    if (persistent_count() != INCIDENT_QUEUE_CAPACITY || find_empty() != -1) return false;
    for (unsigned i = 0; i < INCIDENT_QUEUE_CAPACITY; ++i) {
        if (!load_record(i, &loaded) || memcmp(&loaded, &records[i], sizeof(loaded)) != 0) return false;
    }
    work_t overflow = valid_work(0, 1, 1700028000); process_work(&overflow);
    if (s_queue_full_count != 1 || g_sequence != sequence || !slots_equal(before)) return false;
    if (!make_ack(ack, &records[0]) || incident_handle_ack(ack) != ESP_OK || persistent_count() != INCIDENT_QUEUE_CAPACITY - 1) return false;
    process_work(&overflow);
    return persistent_count() == INCIDENT_QUEUE_CAPACITY && g_sequence == sequence + 1;
}

static bool boundary_capacity(void)
{
    queued_record_t records[INCIDENT_QUEUE_CAPACITY];
    unsigned below = INCIDENT_QUEUE_CAPACITY - 1;
    if (!fill_persistent(below, records) || persistent_count() != below || find_empty() < 0 ||
        s_queue_full_count != 0) return false;
    work_t boundary = valid_work(0, 1, 1700029000); process_work(&boundary);
    if (persistent_count() != INCIDENT_QUEUE_CAPACITY || find_empty() != -1 || s_queue_full_count != 0) return false;
    uint64_t sequence = g_sequence; process_work(&boundary);
    return persistent_count() == INCIDENT_QUEUE_CAPACITY && s_queue_full_count == 1 &&
           g_sequence == sequence;
}

int main(void)
{
    bool results[] = {
        persistent_queue_fill(), persistent_overflow_rejected(), work_queue_overflow_rejected(),
        local_safety_unaffected(), queue_full_counter(), no_overwrite(), no_partial_record(),
        ack_frees_capacity(), retry_while_full(), reboot_while_full(), boundary_capacity()
    };
    const char *names[] = {
        "PERSISTENT QUEUE FILL", "PERSISTENT OVERFLOW REJECTED", "WORK QUEUE OVERFLOW REJECTED",
        "LOCAL SAFETY UNAFFECTED", "QUEUE FULL COUNTER", "NO OVERWRITE", "NO PARTIAL RECORD",
        "ACK FREES CAPACITY", "RETRY WHILE FULL", "REBOOT WHILE FULL", "BOUNDARY CAPACITY"
    };
    bool pass = true;
    for (unsigned i = 0; i < sizeof(results) / sizeof(results[0]); ++i) {
        report(names[i], results[i]);
        pass = pass && results[i];
    }
    printf("QUEUE_FULL_TEST: %s\n", pass ? "PASS" : "FAIL");
    return pass ? 0 : 1;
}

#define INCIDENT_HOST_TEST 1
#define INCIDENT_HOST_PERSISTENCE_TEST 1
#include "../incident.c"

#include <stdlib.h>

enum { EV_SEQUENCE_COMMIT = 1, EV_SIGN, EV_RECORD_COMMIT, EV_MQTT };
typedef struct { bool present; size_t len; uint8_t bytes[4096]; } blob_t;
typedef struct { bool sequence; uint64_t sequence_value; bool blob; int blob_slot; blob_t blob_value; bool erase; int erase_slot; } staged_t;

static bool g_sequence_present;
static uint64_t g_sequence;
static blob_t g_blobs[INCIDENT_QUEUE_CAPACITY];
static staged_t g_staged;
static bool g_fail_set_blob;
static unsigned g_commit_calls, g_fail_commit_call;
static unsigned g_sign_calls, g_publish_calls;
static bool g_mqtt_online;
static char g_published[32][INCIDENT_PAYLOAD_MAX];
static size_t g_published_len[32];
static int g_events[64];
static size_t g_event_count;

static void event(int value) { if (g_event_count < sizeof(g_events) / sizeof(g_events[0])) g_events[g_event_count++] = value; }
static int slot_from_key(const char *key) { return key && key[0] == 'q' && key[1] >= '0' && key[1] < '0' + INCIDENT_QUEUE_CAPACITY && key[2] == '\0' ? key[1] - '0' : -1; }

esp_err_t nvs_open(const char *name, int mode, nvs_handle_t *handle) { (void)mode; if (!name || strcmp(name, INCIDENT_NS) != 0 || !handle) return ESP_ERR_INVALID_ARG; memset(&g_staged, 0, sizeof(g_staged)); *handle = 1; return ESP_OK; }
esp_err_t nvs_get_u64(nvs_handle_t handle, const char *key, uint64_t *value) { (void)handle; if (strcmp(key, INCIDENT_KEY_SEQ) != 0 || !value) return ESP_ERR_INVALID_ARG; if (!g_sequence_present) return ESP_ERR_NVS_NOT_FOUND; *value = g_sequence; return ESP_OK; }
esp_err_t nvs_set_u64(nvs_handle_t handle, const char *key, uint64_t value) { (void)handle; if (strcmp(key, INCIDENT_KEY_SEQ) != 0) return ESP_ERR_INVALID_ARG; g_staged.sequence = true; g_staged.sequence_value = value; return ESP_OK; }
esp_err_t nvs_get_blob(nvs_handle_t handle, const char *key, void *out, size_t *length) { (void)handle; int slot = slot_from_key(key); if (slot < 0 || !length) return ESP_ERR_INVALID_ARG; if (!g_blobs[slot].present) return ESP_ERR_NVS_NOT_FOUND; if (!out || *length < g_blobs[slot].len) { *length = g_blobs[slot].len; return ESP_FAIL; } memcpy(out, g_blobs[slot].bytes, g_blobs[slot].len); *length = g_blobs[slot].len; return ESP_OK; }
esp_err_t nvs_set_blob(nvs_handle_t handle, const char *key, const void *value, size_t length) { (void)handle; int slot = slot_from_key(key); if (g_fail_set_blob) { g_fail_set_blob = false; return ESP_FAIL; } if (slot < 0 || !value || length > sizeof(g_staged.blob_value.bytes)) return ESP_ERR_INVALID_ARG; g_staged.blob = true; g_staged.blob_slot = slot; g_staged.blob_value.present = true; g_staged.blob_value.len = length; memcpy(g_staged.blob_value.bytes, value, length); return ESP_OK; }
esp_err_t nvs_erase_key(nvs_handle_t handle, const char *key) { (void)handle; int slot = slot_from_key(key); if (slot < 0) return ESP_ERR_NVS_NOT_FOUND; g_staged.erase = true; g_staged.erase_slot = slot; return ESP_OK; }
esp_err_t nvs_commit(nvs_handle_t handle) { (void)handle; ++g_commit_calls; if (g_fail_commit_call == g_commit_calls) { memset(&g_staged, 0, sizeof(g_staged)); return ESP_FAIL; } if (g_staged.sequence) { g_sequence_present = true; g_sequence = g_staged.sequence_value; event(EV_SEQUENCE_COMMIT); } if (g_staged.blob) { g_blobs[g_staged.blob_slot] = g_staged.blob_value; event(EV_RECORD_COMMIT); } if (g_staged.erase) memset(&g_blobs[g_staged.erase_slot], 0, sizeof(g_blobs[0])); memset(&g_staged, 0, sizeof(g_staged)); return ESP_OK; }
void nvs_close(nvs_handle_t handle) { (void)handle; memset(&g_staged, 0, sizeof(g_staged)); }

int xSemaphoreTake(SemaphoreHandle_t semaphore, uint32_t timeout) { (void)semaphore; (void)timeout; return 1; }
int xSemaphoreGive(SemaphoreHandle_t semaphore) { (void)semaphore; return 1; }
int mqtt_publish(const char *topic, const char *payload, int qos, bool retain) { (void)topic; (void)qos; (void)retain; event(EV_MQTT); if (g_publish_calls < 32) { g_published_len[g_publish_calls] = strlen(payload); memcpy(g_published[g_publish_calls], payload, g_published_len[g_publish_calls] + 1); } ++g_publish_calls; return g_mqtt_online ? (int)g_publish_calls : -1; }
esp_err_t incident_test_sign_digest(const uint8_t digest[32], uint8_t signature[65]) { ++g_sign_calls; event(EV_SIGN); SHA256(digest, 32, signature); SHA256(signature, 32, signature + 32); signature[64] = 27; return ESP_OK; }

static void reset_runtime(void)
{
    memset(&g_staged, 0, sizeof(g_staged)); g_fail_set_blob = false; g_fail_commit_call = 0; g_commit_calls = 0;
    g_publish_calls = 0; memset(g_published, 0, sizeof(g_published)); memset(g_published_len, 0, sizeof(g_published_len));
    g_event_count = 0; memset(g_events, 0, sizeof(g_events)); s_lock = (void *)1; s_retry_count = 0; s_queue_full_count = 0;
    strcpy(s_device_id, "aa:bb:cc:dd:ee:ff"); strcpy(s_topic, "device/aa:bb:cc:dd:ee:ff/incident");
}

static void reset_all(void) { g_sequence_present = false; g_sequence = 0; memset(g_blobs, 0, sizeof(g_blobs)); g_sign_calls = 0; g_mqtt_online = false; reset_runtime(); }

static work_t valid_work(uint8_t before, uint8_t after, uint64_t observed)
{
    work_t w; memset(&w, 0, sizeof(w)); w.previous_level = before; w.new_level = after;
    w.snapshot.time_source = INCIDENT_TIME_SNTP; w.snapshot.observed_at = observed; w.snapshot.sensor_valid_mask = 15;
    w.snapshot.temperature_c_x100 = 2500; w.snapshot.humidity_pct_x100 = 5000; w.snapshot.co_ppm_x1000 = 60000;
    w.snapshot.overall_level = after; w.snapshot.co_level = after; w.snapshot.derived_valid_mask = 63;
    w.snapshot.model_probability_valid_mask = 3; w.snapshot.model_sha256[0] = 0x42;
    w.snapshot.calibration_revision = 7; w.snapshot.co_r0_q10000 = 98765; w.snapshot.no2_r0_q10000 = 43210;
    return w;
}

static bool event_before(int first, int second)
{
    size_t a = SIZE_MAX, b = SIZE_MAX; for (size_t i = 0; i < g_event_count; ++i) { if (g_events[i] == first && a == SIZE_MAX) a = i; if (g_events[i] == second && b == SIZE_MAX) b = i; }
    return a != SIZE_MAX && b != SIZE_MAX && a < b;
}

static bool sequence_initialization(void) { reset_all(); uint64_t v = 0; return next_sequence(&v) == ESP_OK && v == 1 && g_sequence_present && g_sequence == 1; }
static bool sequence_monotonic(void) { reset_all(); uint64_t a, b, c; return next_sequence(&a) == ESP_OK && next_sequence(&b) == ESP_OK && next_sequence(&c) == ESP_OK && a == 1 && b == 2 && c == 3; }
static bool sequence_reboot(void) { reset_all(); uint64_t a, b; if (next_sequence(&a) != ESP_OK) return false; reset_runtime(); return next_sequence(&b) == ESP_OK && b > a && b == 2; }
static bool sequence_no_reuse(void) { reset_all(); bool seen[8] = {0}; for (unsigned i = 0; i < 6; ++i) { uint64_t v; reset_runtime(); if (next_sequence(&v) != ESP_OK || v >= 8 || seen[v]) return false; seen[v] = true; } return true; }
static bool sequence_commit_failure(void) { reset_all(); uint64_t v = 99; g_fail_commit_call = 1; if (next_sequence(&v) == ESP_OK || v != 99 || g_sequence_present) return false; reset_runtime(); return next_sequence(&v) == ESP_OK && v == 1; }

static bool process_failure_paths(void)
{
    work_t w = valid_work(0, 1, 1700000000); reset_all(); g_fail_commit_call = 1; process_work(&w);
    if (g_sign_calls != 0 || g_publish_calls != 0 || g_sequence_present) return false;
    reset_all(); g_fail_set_blob = true; process_work(&w);
    if (!g_sequence_present || g_sequence != 1 || g_sign_calls != 1 || g_publish_calls != 0 || g_blobs[0].present) return false;
    reset_runtime(); g_fail_commit_call = 2; process_work(&w);
    return g_sequence == 2 && g_publish_calls == 0 && !g_blobs[0].present;
}

static bool roundtrip(void)
{
    reset_all(); queued_record_t original; memset(&original, 0, sizeof(original)); original.magic = INCIDENT_MAGIC; original.sequence = 9;
    original.len = (uint16_t)strlen("{\"schema_version\":2,\"observed_at\":\"1700000000\"}"); strcpy(original.payload, "{\"schema_version\":2,\"observed_at\":\"1700000000\"}");
    for (size_t i = 0; i < sizeof(original.signature); ++i) original.signature[i] = (uint8_t)i;
    original.incident_id[0] = 0x11; original.evidence_hash[0] = 0x22; original.checksum = record_checksum(&original);
    queued_record_t loaded; return save_record(0, &original) == ESP_OK && load_record(0, &loaded) && memcmp(&original, &loaded, sizeof(original)) == 0;
}

static bool persistence_and_retry(void)
{
    reset_all(); work_t w = valid_work(0, 1, 1700000001); process_work(&w); queued_record_t original;
    if (!load_record(0, &original) || g_publish_calls != 1 || g_mqtt_online || !event_before(EV_SEQUENCE_COMMIT, EV_SIGN) || !event_before(EV_SIGN, EV_RECORD_COMMIT) || !event_before(EV_RECORD_COMMIT, EV_MQTT)) return false;
    char initial[INCIDENT_PAYLOAD_MAX]; size_t initial_len = original.len; memcpy(initial, original.payload, initial_len + 1); uint8_t signature[65]; memcpy(signature, original.signature, 65);
    unsigned sign_before = g_sign_calls; uint64_t sequence_before = g_sequence; g_mqtt_online = true; g_publish_calls = 0; incident_retry_pending(); incident_retry_pending();
    if (g_publish_calls != 2 || g_sign_calls != sign_before || g_sequence != sequence_before) return false;
    for (unsigned i = 0; i < 2; ++i) if (g_published_len[i] != initial_len || memcmp(g_published[i], initial, initial_len) != 0) return false;
    queued_record_t after; return load_record(0, &after) && after.sequence == original.sequence && memcmp(after.incident_id, original.incident_id, 32) == 0 && memcmp(after.evidence_hash, original.evidence_hash, 32) == 0 && memcmp(after.signature, signature, 65) == 0;
}

static bool reboot_retry(void)
{
    reset_all(); work_t w = valid_work(0, 1, 1700000002); process_work(&w); queued_record_t before;
    if (!load_record(0, &before)) return false;
    unsigned sign_before = g_sign_calls; uint64_t sequence_before = g_sequence;
    reset_runtime(); g_mqtt_online = true; incident_retry_pending(); queued_record_t after;
    return g_publish_calls == 1 && g_sign_calls == sign_before && g_sequence == sequence_before && load_record(0, &after) &&
           memcmp(&before, &after, sizeof(before)) == 0 && g_published_len[0] == before.len && memcmp(g_published[0], before.payload, before.len) == 0;
}

static bool multi_record_restart(void)
{
    reset_all(); work_t a = valid_work(0, 1, 1700000010), b = valid_work(1, 2, 1700000020); process_work(&a); process_work(&b);
    queued_record_t first, second; if (!load_record(0, &first) || !load_record(1, &second) || first.sequence >= second.sequence) return false;
    reset_runtime(); g_mqtt_online = true; incident_retry_pending();
    return g_publish_calls == 2 && g_published_len[0] == first.len && g_published_len[1] == second.len &&
           memcmp(g_published[0], first.payload, first.len) == 0 && memcmp(g_published[1], second.payload, second.len) == 0;
}

static bool corrupted_record(void)
{
    reset_all(); work_t w = valid_work(0, 1, 1700000030); process_work(&w); if (!g_blobs[0].present) return false;
    queued_record_t *raw = (queued_record_t *)g_blobs[0].bytes; raw->payload[10] ^= 1; reset_runtime(); g_mqtt_online = true; queued_record_t ignored;
    incident_retry_pending(); return !load_record(0, &ignored) && g_publish_calls == 0;
}

static void report(const char *name, bool pass) { printf("%s: %s\n", name, pass ? "PASS" : "FAIL"); }

int main(void)
{
    bool init = sequence_initialization(), mono = sequence_monotonic(), reboot_seq = sequence_reboot(), no_reuse = sequence_no_reuse();
    bool commit_fail = sequence_commit_failure(), failures = process_failure_paths(), bytes = roundtrip();
    bool retry = persistence_and_retry(), reboot = reboot_retry(), multi = multi_record_restart(), corrupt = corrupted_record();
    report("SEQUENCE INITIALIZATION", init); report("SEQUENCE MONOTONIC", mono); report("SEQUENCE REBOOT DURABILITY", reboot_seq);
    report("SEQUENCE NO REUSE", no_reuse); report("SEQUENCE COMMIT FAILURE", commit_fail);
    report("PERSIST BEFORE PUBLISH", retry); report("SAVE FAILURE BLOCKS PUBLISH", failures);
    report("QUEUED RECORD BYTE ROUNDTRIP", bytes); report("OFFLINE RETRY EXACT BYTES", retry);
    report("REBOOT RETRY EXACT BYTES", reboot); report("MULTI-RECORD RESTART", multi);
    report("NO RESIGN ON RETRY", retry && reboot); report("NO NEW SEQUENCE ON RETRY", retry && reboot);
    report("CORRUPTED RECORD SAFETY", corrupt);
    bool pass = init && mono && reboot_seq && no_reuse && commit_fail && failures && bytes && retry && reboot && multi && corrupt;
    printf("NVS_REBOOT_RETRY_TEST: %s\n", pass ? "PASS" : "FAIL");
    return pass ? 0 : 1;
}

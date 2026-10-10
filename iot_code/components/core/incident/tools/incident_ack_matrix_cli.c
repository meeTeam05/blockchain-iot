#define INCIDENT_HOST_ACK_TEST 1
#define main incident_persistence_suite_main
#include "incident_persistence_cli.c"
#undef main

#include "mqtt.h"

typedef struct {
    blob_t slots[INCIDENT_QUEUE_CAPACITY];
    uint64_t sequence;
    unsigned sign_calls;
    unsigned publish_calls;
} queue_snapshot_t;

static unsigned queue_count(void)
{
    unsigned count = 0;
    for (unsigned i = 0; i < INCIDENT_QUEUE_CAPACITY; ++i) {
        queued_record_t record;
        if (load_record(i, &record)) ++count;
    }
    return count;
}

static void snapshot_queue(queue_snapshot_t *snapshot)
{
    memcpy(snapshot->slots, g_blobs, sizeof(snapshot->slots));
    snapshot->sequence = g_sequence;
    snapshot->sign_calls = g_sign_calls;
    snapshot->publish_calls = g_publish_calls;
}

static bool snapshot_unchanged(const queue_snapshot_t *snapshot, bool check_publish)
{
    return memcmp(snapshot->slots, g_blobs, sizeof(snapshot->slots)) == 0 &&
           snapshot->sequence == g_sequence && snapshot->sign_calls == g_sign_calls &&
           (!check_publish || snapshot->publish_calls == g_publish_calls);
}

static bool distinct_record(const queued_record_t *a, const queued_record_t *b)
{
    return a->sequence != b->sequence && memcmp(a->incident_id, b->incident_id, 32) != 0 &&
           memcmp(a->evidence_hash, b->evidence_hash, 32) != 0 &&
           memcmp(a->signature, b->signature, 65) != 0 &&
           (a->len != b->len || memcmp(a->payload, b->payload, a->len) != 0);
}

static bool prepare_records(unsigned count, queued_record_t records[INCIDENT_QUEUE_CAPACITY])
{
    reset_all();
    for (unsigned i = 0; i < count; ++i) {
        work_t work = valid_work(0, 1, UINT64_C(1700010000) + i);
        work.snapshot.temperature_c_x100 += (int32_t)i;
        process_work(&work);
    }
    if (queue_count() != count) return false;
    for (unsigned i = 0; i < count; ++i) {
        if (!load_record(i, &records[i])) return false;
        for (unsigned j = 0; j < i; ++j) if (!distinct_record(&records[i], &records[j])) return false;
    }
    return true;
}

static void record_hex(const queued_record_t *record, char incident_id[67], char evidence_hash[67])
{
    hex32(record->incident_id, incident_id);
    hex32(record->evidence_hash, evidence_hash);
}

static bool format_ack(char *out, size_t size, const char *schema, const char *id,
                       const char *hash, const char *accepted, const char *error_code)
{
    int length = snprintf(out, size,
                          "{\"schema_version\":%s,\"incident_id\":%s,"
                          "\"evidence_hash\":%s,\"accepted\":%s,"
                          "\"error_code\":\"%s\",\"received_at\":\"2026-09-27T07:00:00Z\"}",
                          schema, id, hash, accepted, error_code);
    return length > 0 && (size_t)length < size;
}

static bool exact_ack(char *out, size_t size, const queued_record_t *record,
                      const char *accepted, const char *error_code)
{
    char id[67], hash[67], quoted_id[70], quoted_hash[70];
    record_hex(record, id, hash);
    snprintf(quoted_id, sizeof(quoted_id), "\"%s\"", id);
    snprintf(quoted_hash, sizeof(quoted_hash), "\"%s\"", hash);
    return format_ack(out, size, "2", quoted_id, quoted_hash, accepted, error_code);
}

static esp_err_t dispatch_ack(const char *payload)
{
    return mqtt_dispatch_incident_ack(incident_handle_ack, payload);
}

static bool invalid_preserves(const char *payload)
{
    queued_record_t records[INCIDENT_QUEUE_CAPACITY];
    if (!prepare_records(2, records)) return false;
    queue_snapshot_t before;
    snapshot_queue(&before);
    esp_err_t result = dispatch_ack(payload);
    return result != ESP_OK && queue_count() == 2 && snapshot_unchanged(&before, true);
}

static bool valid_ack_delete(void)
{
    queued_record_t records[INCIDENT_QUEUE_CAPACITY]; char ack[512];
    if (!prepare_records(2, records) || !exact_ack(ack, sizeof(ack), &records[0], "true", "")) return false;
    blob_t second = g_blobs[1]; uint64_t sequence = g_sequence; unsigned signs = g_sign_calls, publishes = g_publish_calls;
    return dispatch_ack(ack) == ESP_OK && queue_count() == 1 && !g_blobs[0].present &&
           memcmp(&second, &g_blobs[1], sizeof(second)) == 0 && sequence == g_sequence &&
           signs == g_sign_calls && publishes == g_publish_calls;
}

static bool wrong_id_or_hash(bool wrong_id)
{
    queued_record_t records[INCIDENT_QUEUE_CAPACITY]; char ack[512], id[67], hash[67], qid[70], qhash[70];
    if (!prepare_records(2, records)) return false;
    record_hex(&records[0], id, hash); (wrong_id ? id : hash)[2] = (wrong_id ? id : hash)[2] == '0' ? '1' : '0';
    snprintf(qid, sizeof(qid), "\"%s\"", id); snprintf(qhash, sizeof(qhash), "\"%s\"", hash);
    if (!format_ack(ack, sizeof(ack), "2", qid, qhash, "true", "")) return false;
    queue_snapshot_t before; snapshot_queue(&before);
    return dispatch_ack(ack) == ESP_OK && snapshot_unchanged(&before, true);
}

static bool accepted_false(void)
{
    static const char *codes[] = {"validation_failed", "signature_invalid", ""};
    for (unsigned i = 0; i < sizeof(codes) / sizeof(codes[0]); ++i) {
        queued_record_t records[INCIDENT_QUEUE_CAPACITY]; char ack[512];
        if (!prepare_records(1, records) || !exact_ack(ack, sizeof(ack), &records[0], "false", codes[i])) return false;
        queue_snapshot_t before; snapshot_queue(&before);
        if (dispatch_ack(ack) == ESP_OK || !snapshot_unchanged(&before, true)) return false;
    }
    return true;
}

static bool wrong_schema(void)
{
    queued_record_t records[INCIDENT_QUEUE_CAPACITY]; char id[67], hash[67], qid[70], qhash[70], ack[512];
    if (!prepare_records(1, records)) return false;
    record_hex(&records[0], id, hash); snprintf(qid, sizeof(qid), "\"%s\"", id); snprintf(qhash, sizeof(qhash), "\"%s\"", hash);
    const char *schemas[] = {"1", "3"};
    for (unsigned i = 0; i < 2; ++i) {
        if (!format_ack(ack, sizeof(ack), schemas[i], qid, qhash, "true", "") || dispatch_ack(ack) == ESP_OK || queue_count() != 1) return false;
    }
    snprintf(ack, sizeof(ack), "{\"incident_id\":\"%s\",\"evidence_hash\":\"%s\",\"accepted\":true,\"error_code\":\"\",\"received_at\":\"now\"}", id, hash);
    return dispatch_ack(ack) != ESP_OK && queue_count() == 1;
}

static bool malformed_json(void)
{
    static const char *cases[] = {"{bad", "{\"schema_version\":2", "", "{}", "[]", "x", "{} trailing"};
    for (unsigned i = 0; i < sizeof(cases) / sizeof(cases[0]); ++i) if (!invalid_preserves(cases[i])) return false;
    return true;
}

static bool missing_fields(void)
{
    queued_record_t records[INCIDENT_QUEUE_CAPACITY]; char id[67], hash[67], ack[512];
    if (!prepare_records(1, records)) return false;
    record_hex(&records[0], id, hash);
    const char *cases[] = {
        "{\"schema_version\":2,\"evidence_hash\":\"%s\",\"accepted\":true,\"error_code\":\"\",\"received_at\":\"now\"}",
        "{\"schema_version\":2,\"incident_id\":\"%s\",\"accepted\":true,\"error_code\":\"\",\"received_at\":\"now\"}",
        "{\"schema_version\":2,\"incident_id\":\"%s\",\"evidence_hash\":\"%s\",\"error_code\":\"\",\"received_at\":\"now\"}",
        "{\"incident_id\":\"%s\",\"evidence_hash\":\"%s\",\"accepted\":true,\"error_code\":\"\",\"received_at\":\"now\"}",
        "{\"schema_version\":2,\"incident_id\":\"%s\",\"evidence_hash\":\"%s\",\"accepted\":true,\"received_at\":\"now\"}",
        "{\"schema_version\":2,\"incident_id\":\"%s\",\"evidence_hash\":\"%s\",\"accepted\":true,\"error_code\":\"\"}"
    };
    for (unsigned i = 0; i < 6; ++i) {
        if (i == 0) snprintf(ack, sizeof(ack), cases[i], hash);
        else if (i == 1) snprintf(ack, sizeof(ack), cases[i], id);
        else snprintf(ack, sizeof(ack), cases[i], id, hash);
        queue_snapshot_t before; snapshot_queue(&before);
        if (dispatch_ack(ack) == ESP_OK || !snapshot_unchanged(&before, true)) return false;
    }
    return true;
}

static bool invalid_types(void)
{
    queued_record_t records[INCIDENT_QUEUE_CAPACITY]; char id[67], hash[67], ack[512];
    if (!prepare_records(1, records)) return false;
    record_hex(&records[0], id, hash);
    const char *schema[] = {"\"2\"", "2", "2", "2"};
    char id_value[70], hash_value[70]; snprintf(id_value, sizeof(id_value), "\"%s\"", id); snprintf(hash_value, sizeof(hash_value), "\"%s\"", hash);
    const char *accepted[] = {"true", "\"true\"", "true", "true"};
    const char *ids[] = {id_value, id_value, "123", id_value};
    const char *hashes[] = {hash_value, hash_value, hash_value, "false"};
    for (unsigned i = 0; i < 4; ++i) {
        if (!format_ack(ack, sizeof(ack), schema[i], ids[i], hashes[i], accepted[i], "")) return false;
        queue_snapshot_t before; snapshot_queue(&before);
        if (dispatch_ack(ack) == ESP_OK || !snapshot_unchanged(&before, true)) return false;
    }
    return true;
}

static void uppercase_hex(char *value)
{
    for (size_t i = 2; value[i]; ++i) if (value[i] >= 'a' && value[i] <= 'f') value[i] = (char)(value[i] - 'a' + 'A');
}

static bool invalid_hex_length(void)
{
    queued_record_t records[INCIDENT_QUEUE_CAPACITY]; char id[140], hash[140], qid[144], qhash[144], ack[600];
    if (!prepare_records(1, records)) return false;
    char valid_id[67], valid_hash[67]; record_hex(&records[0], valid_id, valid_hash);
    for (unsigned field = 0; field < 2; ++field) {
        for (unsigned variant = 0; variant < 7; ++variant) {
            strcpy(id, valid_id); strcpy(hash, valid_hash); char *target = field == 0 ? id : hash;
            if (variant == 0) memmove(target, target + 2, strlen(target + 2) + 1);
            else if (variant == 1) uppercase_hex(target);
            else if (variant == 2) target[strlen(target) - 1] = '\0';
            else if (variant == 3) target[10] = '\0';
            else if (variant == 4) strcat(target, "00");
            else if (variant == 5) target[5] = 'z';
            else strcpy(target, "0x0000000000000000000000000000000000000000000000000000000000000000");
            snprintf(qid, sizeof(qid), "\"%s\"", id); snprintf(qhash, sizeof(qhash), "\"%s\"", hash);
            if (!format_ack(ack, sizeof(ack), "2", qid, qhash, "true", "")) return false;
            queue_snapshot_t before; snapshot_queue(&before);
            esp_err_t result = dispatch_ack(ack);
            if (variant != 6 && result == ESP_OK) return false;
            if (!snapshot_unchanged(&before, true)) return false;
        }
    }
    return true;
}

static bool duplicate_ack(void)
{
    queued_record_t records[INCIDENT_QUEUE_CAPACITY]; char ack[512];
    if (!prepare_records(2, records) || !exact_ack(ack, sizeof(ack), &records[0], "true", "")) return false;
    if (dispatch_ack(ack) != ESP_OK || queue_count() != 1) return false;
    queue_snapshot_t before; snapshot_queue(&before);
    return dispatch_ack(ack) == ESP_OK && snapshot_unchanged(&before, true) && queue_count() == 1;
}

static bool unknown_incident(void)
{
    queued_record_t records[INCIDENT_QUEUE_CAPACITY]; char ack[512];
    if (!prepare_records(2, records)) return false;
    const char *zero = "\"0x0000000000000000000000000000000000000000000000000000000000000000\"";
    if (!format_ack(ack, sizeof(ack), "2", zero, zero, "true", "")) return false;
    queue_snapshot_t before; snapshot_queue(&before);
    return dispatch_ack(ack) == ESP_OK && snapshot_unchanged(&before, true);
}

static bool cross_match(void)
{
    queued_record_t records[INCIDENT_QUEUE_CAPACITY]; char a_id[67], a_hash[67], b_id[67], b_hash[67], qid[70], qhash[70], ack[512];
    if (!prepare_records(2, records)) return false;
    record_hex(&records[0], a_id, a_hash); record_hex(&records[1], b_id, b_hash);
    const char *ids[] = {a_id, b_id}; const char *hashes[] = {b_hash, a_hash};
    for (unsigned i = 0; i < 2; ++i) {
        snprintf(qid, sizeof(qid), "\"%s\"", ids[i]); snprintf(qhash, sizeof(qhash), "\"%s\"", hashes[i]);
        format_ack(ack, sizeof(ack), "2", qid, qhash, "true", ""); queue_snapshot_t before; snapshot_queue(&before);
        if (dispatch_ack(ack) != ESP_OK || !snapshot_unchanged(&before, true)) return false;
    }
    return true;
}

static bool multi_record_delete(void)
{
    for (unsigned target = 0; target < 3; ++target) {
        queued_record_t records[INCIDENT_QUEUE_CAPACITY]; char ack[512];
        if (!prepare_records(3, records) || !exact_ack(ack, sizeof(ack), &records[target], "true", "")) return false;
        blob_t before[3]; memcpy(before, g_blobs, sizeof(before));
        if (dispatch_ack(ack) != ESP_OK || queue_count() != 2 || g_blobs[target].present) return false;
        for (unsigned i = 0; i < 3; ++i) if (i != target && memcmp(&before[i], &g_blobs[i], sizeof(before[i])) != 0) return false;
    }
    return true;
}

static bool ack_retry_interaction(void)
{
    queued_record_t records[INCIDENT_QUEUE_CAPACITY]; char ack[512];
    if (!prepare_records(1, records) || !exact_ack(ack, sizeof(ack), &records[0], "true", "")) return false;
    g_publish_calls = 0; g_mqtt_online = true;
    if (dispatch_ack(ack) != ESP_OK) return false;
    incident_retry_pending();
    if (g_publish_calls != 0) return false;
    if (!prepare_records(1, records)) return false;
    queued_record_t stored = records[0];
    char id[67], hash[67], qid[70], qhash[70]; record_hex(&stored, id, hash); hash[2] = hash[2] == '0' ? '1' : '0';
    snprintf(qid, sizeof(qid), "\"%s\"", id); snprintf(qhash, sizeof(qhash), "\"%s\"", hash); format_ack(ack, sizeof(ack), "2", qid, qhash, "true", "");
    g_publish_calls = 0; g_mqtt_online = true;
    if (dispatch_ack(ack) != ESP_OK) return false;
    incident_retry_pending();
    return g_publish_calls == 1 && g_published_len[0] == stored.len && memcmp(g_published[0], stored.payload, stored.len) == 0;
}

static bool invalid_ack_preserves_bytes(void)
{
    queued_record_t records[INCIDENT_QUEUE_CAPACITY]; char ack[512];
    if (!prepare_records(2, records) || !exact_ack(ack, sizeof(ack), &records[0], "false", "signature_invalid")) return false;
    queue_snapshot_t before; snapshot_queue(&before);
    return dispatch_ack(ack) != ESP_OK && snapshot_unchanged(&before, true);
}

static bool delete_commit_failure(void)
{
    queued_record_t records[INCIDENT_QUEUE_CAPACITY], after; char ack[512];
    if (!prepare_records(1, records) || !exact_ack(ack, sizeof(ack), &records[0], "true", "")) return false;
    g_fail_commit_call = g_commit_calls + 1;
    if (dispatch_ack(ack) == ESP_OK || !load_record(0, &after) || memcmp(&records[0], &after, sizeof(after)) != 0) return false;
    reset_runtime();
    return load_record(0, &after) && memcmp(&records[0], &after, sizeof(after)) == 0;
}

int main(int argc, char **argv)
{
    if (argc == 3 && strcmp(argv[1], "--validate-json") == 0) {
        reset_all();
        esp_err_t result = dispatch_ack(argv[2]);
        printf("ACK_CONTRACT_TEST: %s\n", result == ESP_OK ? "PASS" : "FAIL");
        return result == ESP_OK ? 0 : 1;
    }
    if (argc != 1) {
        fprintf(stderr, "usage: %s [--validate-json JSON]\n", argv[0]);
        return 2;
    }
    bool results[] = {
        valid_ack_delete(), wrong_id_or_hash(true), wrong_id_or_hash(false), accepted_false(),
        wrong_schema(), malformed_json(), missing_fields(), invalid_types(), invalid_hex_length(),
        duplicate_ack(), unknown_incident(), cross_match(), multi_record_delete(),
        ack_retry_interaction(), invalid_ack_preserves_bytes(), delete_commit_failure()
    };
    const char *names[] = {
        "VALID ACK DELETE", "WRONG INCIDENT ID", "WRONG EVIDENCE HASH", "ACCEPTED FALSE",
        "WRONG SCHEMA", "MALFORMED JSON", "MISSING FIELDS", "INVALID FIELD TYPES",
        "INVALID HEX/LENGTH", "DUPLICATE ACK", "UNKNOWN INCIDENT", "CROSS-MATCH PROTECTION",
        "MULTI-RECORD DELETE SAFETY", "ACK/RETRY INTERACTION", "INVALID ACK PRESERVES BYTES",
        "DELETE COMMIT FAILURE"
    };
    bool pass = true;
    for (unsigned i = 0; i < sizeof(results) / sizeof(results[0]); ++i) { report(names[i], results[i]); pass = pass && results[i]; }
    printf("ACK_MATRIX_TEST: %s\n", pass ? "PASS" : "FAIL");
    return pass ? 0 : 1;
}

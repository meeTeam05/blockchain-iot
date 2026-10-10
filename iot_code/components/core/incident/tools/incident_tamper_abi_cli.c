/* Host-only negative tests which execute the production Schema-v2 codec. */
#define INCIDENT_HOST_TEST 1
#define INCIDENT_HOST_CRYPTO_TEST 1
#include "../incident.c"

#include <limits.h>

static const uint8_t k_signer[20] = {
    0xf3, 0x9f, 0xd6, 0xe5, 0x1a, 0xad, 0x88, 0xf6, 0xf4, 0xce,
    0x6a, 0xb8, 0x82, 0x72, 0x79, 0xcf, 0xff, 0xb9, 0x22, 0x66,
};

static const char k_signature_1[] =
    "0xa48786e95357d2d8c0a0b4a7837e30046532460bb301f3bc68ec616d0b908cd2"
    "7868c50aef1bc5bb8c2d9fbcd09703730ecbf8eacc173acf906f3447edca6b5b1c";
static const char k_signature_2[] =
    "0x545008a77becaddff7d20e4594c7b9e19e6bb599bf481025a7236f6ab012e277"
    "758726dedca1379b5eda517a53d4fea0e9e88970b1f7c95a7908fe9681464a061c";

static bool parse_hex(const char *text, uint8_t *out, size_t bytes)
{
    if (text == NULL || strlen(text) != bytes * 2 + 2 || text[0] != '0' || text[1] != 'x') return false;
    for (size_t i = 0; i < bytes; ++i) {
        char a = text[2 + i * 2], b = text[3 + i * 2];
        int hi = a >= '0' && a <= '9' ? a - '0' : a >= 'a' && a <= 'f' ? a - 'a' + 10 : -1;
        int lo = b >= '0' && b <= '9' ? b - '0' : b >= 'a' && b <= 'f' ? b - 'a' + 10 : -1;
        if (hi < 0 || lo < 0) return false;
        out[i] = (uint8_t)((hi << 4) | lo);
    }
    return true;
}

static void fixture(evidence_t *e, int which)
{
    memset(e, 0, sizeof(*e));
    e->schema_version = 2; e->time_source = 1; e->snapshot.sensor_valid_mask = 15;
    e->snapshot.temperature_c_x100 = 3047; e->snapshot.humidity_pct_x100 = 7445;
    e->snapshot.co_ppm_x1000 = which == 1 ? 52000 : 70000;
    e->snapshot.no2_ppm_x1000 = which == 1 ? 323 : 450;
    e->snapshot.overall_level = which == 1 ? 1 : 2; e->snapshot.co_level = which == 1 ? 1 : 2;
    e->snapshot.co_alarm_source_mask = which == 1 ? 4 : 1; e->snapshot.derived_valid_mask = 63;
    e->snapshot.co_stel15_ppm_x1000 = which == 1 ? 24000 : 35000;
    e->snapshot.no2_stel15_ppm_x1000 = which == 1 ? 350 : 400;
    e->snapshot.co_twa8h_ppm_x1000 = which == 1 ? 1600 : 1800;
    e->snapshot.no2_twa8h_ppm_x1000 = which == 1 ? 22 : 25;
    e->snapshot.co_proj10_ppm_x1000 = which == 1 ? 36000 : 50000;
    e->snapshot.no2_proj10_ppm_x1000 = which == 1 ? 400 : 500;
    e->snapshot.model_probability_valid_mask = which == 1 ? 3 : 0;
    e->snapshot.co_model_probability_bps = which == 1 ? 9102 : 0;
    e->snapshot.no2_model_probability_bps = which == 1 ? 39 : 0;
    e->incident_kind = which == 1 ? 1 : 2; e->severity = which == 1 ? 1 : 2;
    e->sequence = which == 1 ? 43 : 44; e->observed_at = which == 1 ? 1790394600 : 1790394700;
    e->snapshot.calibration_revision = 3; e->snapshot.co_r0_q10000 = 98765; e->snapshot.no2_r0_q10000 = 43210;
    (void)parse_hex32("0xd1a789f1e6ad1e2b5225fb8ed78876b5ef348c2a81741e46c8fcb50c85048dcc", e->model_sha256);
    set_calibration(e);
    keccak256("aa:bb:cc:dd:ee:ff", 17, e->device_id_hash);
    hash_incident_id(e->device_id_hash, e->sequence, e->incident_id);
    keccak256("0.1.1-gas-ews", 13, e->firmware_version_hash);
}

static bool signature_is_not_signer(const uint8_t digest[32], const uint8_t signature[65])
{
    uint8_t public_key[65], address_hash[32];
    if (recover_public_key(digest, signature, public_key) != ESP_OK) return true;
    keccak256(public_key + 1, 64, address_hash);
    return memcmp(address_hash + 12, k_signer, sizeof(k_signer)) != 0;
}

static bool signature_is_signer(const uint8_t digest[32], const uint8_t signature[65])
{
    return !signature_is_not_signer(digest, signature);
}

static void mutate_evidence(evidence_t *e, unsigned n)
{
    switch (n) {
    case 0: e->snapshot.temperature_c_x100 ^= 1; break;
    case 1: e->snapshot.humidity_pct_x100++; break;
    case 2: e->snapshot.co_ppm_x1000++; break;
    case 3: e->snapshot.no2_ppm_x1000++; break;
    case 4: e->snapshot.overall_level ^= 3; break;
    case 5: e->snapshot.co_level ^= 3; break;
    case 6: e->snapshot.no2_level ^= 1; break;
    case 7: e->snapshot.co_alarm_source_mask ^= 1; break;
    case 8: e->snapshot.no2_alarm_source_mask ^= 1; break;
    case 9: e->snapshot.derived_valid_mask ^= 1; break;
    case 10: e->snapshot.co_stel15_ppm_x1000++; break;
    case 11: e->snapshot.model_probability_valid_mask ^= 1; break;
    case 12: e->snapshot.co_model_probability_bps++; break;
    case 13: e->calibration_revision++; break;
    case 14: e->calibration_hash[0] ^= 1; break;
    case 15: e->model_sha256[0] ^= 1; break;
    }
}

static bool evidence_tamper_test(void)
{
    for (int which = 1; which <= 2; ++which) {
        evidence_t original; uint8_t hash[32], digest[32], sig[65];
        fixture(&original, which); hash_evidence(&original, hash);
        if (!hash_digest(&original, hash, digest) || !parse_hex(which == 1 ? k_signature_1 : k_signature_2, sig, 65) || !signature_is_signer(digest, sig)) return false;
        for (unsigned n = 0; n < 16; ++n) {
            evidence_t changed = original; uint8_t changed_hash[32], changed_digest[32];
            mutate_evidence(&changed, n); hash_evidence(&changed, changed_hash);
            if (memcmp(hash, changed_hash, 32) == 0 || !hash_digest(&changed, changed_hash, changed_digest) ||
                memcmp(digest, changed_digest, 32) == 0 || !signature_is_not_signer(changed_digest, sig)) return false;
        }
    }
    return true;
}

static bool attestation_tamper_test(void)
{
    for (int which = 1; which <= 2; ++which) {
        evidence_t original; uint8_t evidence_hash[32], digest[32], sig[65];
        fixture(&original, which); hash_evidence(&original, evidence_hash);
        if (!hash_digest(&original, evidence_hash, digest) || !parse_hex(which == 1 ? k_signature_1 : k_signature_2, sig, 65)) return false;
        for (unsigned n = 0; n < 6; ++n) {
            evidence_t changed = original; uint8_t changed_hash[32], changed_digest[32];
            memcpy(changed_hash, evidence_hash, sizeof(changed_hash));
            if (n == 0) changed.device_id_hash[0] ^= 1;
            else if (n == 1) changed.incident_id[0] ^= 1;
            else if (n == 2) changed.sequence++;
            else if (n == 3) changed.observed_at++;
            else if (n == 4) changed.severity ^= 3;
            else changed_hash[0] ^= 1;
            if (!hash_digest(&changed, changed_hash, changed_digest) || memcmp(digest, changed_digest, 32) == 0 ||
                !signature_is_not_signer(changed_digest, sig)) return false;
        }
    }
    return true;
}

static void reference_u(uint8_t out[32], uint64_t value)
{
    memset(out, 0, 32);
    for (unsigned i = 0; i < 8; ++i) out[31 - i] = (uint8_t)(value >> (i * 8));
}

static void reference_i32(uint8_t out[32], int32_t value)
{
    uint32_t raw = (uint32_t)value;
    memset(out, value < 0 ? 0xff : 0, 32);
    for (unsigned i = 0; i < 4; ++i) out[31 - i] = (uint8_t)(raw >> (i * 8));
}

static bool int32_abi_test(void)
{
    const int32_t values[] = {-1, -550, INT32_MIN, 0, 3047};
    for (unsigned i = 0; i < sizeof(values) / sizeof(values[0]); ++i) {
        uint8_t actual[32], expected[32]; abi_i32(actual, values[i]); reference_i32(expected, values[i]);
        if (memcmp(actual, expected, 32) != 0) return false;
    }
    uint8_t minus_550[32]; abi_i32(minus_550, -550);
    static const uint8_t suffix[] = {0xff, 0xff, 0xfd, 0xda};
    for (unsigned i = 0; i < 28; ++i) if (minus_550[i] != 0xff) return false;
    return memcmp(minus_550 + 28, suffix, sizeof(suffix)) == 0;
}

static bool uint_abi_test(void)
{
    const uint64_t values[] = {0, 1, 2, 43, 44, 255, 10000, 65535, 0xffffffffULL, UINT64_MAX};
    for (unsigned i = 0; i < sizeof(values) / sizeof(values[0]); ++i) {
        uint8_t actual[32], expected[32]; abi_u(actual, values[i]); reference_u(expected, values[i]);
        if (memcmp(actual, expected, 32) != 0) return false;
    }
    return true;
}

static bool bytes32_test(void)
{
    evidence_t e; uint8_t actual[32], expected[32]; fixture(&e, 1);
    const uint8_t *fields[] = {e.device_id_hash, e.incident_id, e.firmware_version_hash, e.model_sha256, e.calibration_hash};
    for (unsigned i = 0; i < sizeof(fields) / sizeof(fields[0]); ++i) {
        keccak_t k; keccak_init(&k); abi_hash_field(&k, fields[i]); keccak_final(&k, actual);
        keccak256(fields[i], 32, expected);
        if (memcmp(actual, expected, 32) != 0) return false;
    }
    return true;
}

static bool valid_masks_test(void)
{
    for (unsigned bit = 0; bit < 6; ++bit) {
        evidence_t changed, zeroed; uint8_t a[32], b[32]; fixture(&changed, 1); zeroed = changed;
        uint32_t *changed_values[] = {&changed.snapshot.co_stel15_ppm_x1000, &changed.snapshot.no2_stel15_ppm_x1000,
            &changed.snapshot.co_twa8h_ppm_x1000, &changed.snapshot.no2_twa8h_ppm_x1000,
            &changed.snapshot.co_proj10_ppm_x1000, &changed.snapshot.no2_proj10_ppm_x1000};
        uint32_t *zeroed_values[] = {&zeroed.snapshot.co_stel15_ppm_x1000, &zeroed.snapshot.no2_stel15_ppm_x1000,
            &zeroed.snapshot.co_twa8h_ppm_x1000, &zeroed.snapshot.no2_twa8h_ppm_x1000,
            &zeroed.snapshot.co_proj10_ppm_x1000, &zeroed.snapshot.no2_proj10_ppm_x1000};
        *changed_values[bit] = 123456 + bit; *zeroed_values[bit] = 0;
        changed.snapshot.derived_valid_mask &= (uint8_t)~(1u << bit);
        zeroed.snapshot.derived_valid_mask &= (uint8_t)~(1u << bit);
        canonicalize_snapshot(&changed.snapshot); canonicalize_snapshot(&zeroed.snapshot);
        hash_evidence(&changed, a); hash_evidence(&zeroed, b);
        if (*changed_values[bit] != 0 || memcmp(a, b, 32) != 0) return false;
    }
    evidence_t unavailable, valid_zero; uint8_t a[32], b[32]; fixture(&unavailable, 1); valid_zero = unavailable;
    unavailable.snapshot.model_probability_valid_mask = 0; unavailable.snapshot.co_model_probability_bps = 9102; unavailable.snapshot.no2_model_probability_bps = 39;
    valid_zero.snapshot.model_probability_valid_mask = 3; valid_zero.snapshot.co_model_probability_bps = 0; valid_zero.snapshot.no2_model_probability_bps = 0;
    canonicalize_snapshot(&unavailable.snapshot); canonicalize_snapshot(&valid_zero.snapshot);
    hash_evidence(&unavailable, a); hash_evidence(&valid_zero, b);
    return unavailable.snapshot.co_model_probability_bps == 0 && unavailable.snapshot.no2_model_probability_bps == 0 && memcmp(a, b, 32) != 0;
}

static bool source_masks_test(void)
{
    for (uint8_t mask = 1; mask <= 7; ++mask) {
        evidence_t e; uint8_t actual[32], expected[32]; fixture(&e, 1); e.snapshot.co_alarm_source_mask = mask;
        canonicalize_snapshot(&e.snapshot); abi_u(actual, e.snapshot.co_alarm_source_mask); reference_u(expected, mask);
        if (e.snapshot.co_alarm_source_mask != mask || memcmp(actual, expected, 32) != 0) return false;
    }
    return true;
}

static bool enum_contract_test(void)
{
    evidence_t early, exceeded; fixture(&early, 1); fixture(&exceeded, 2);
    return early.snapshot.overall_level == 1 && early.incident_kind == 1 && early.severity == 1 &&
           exceeded.snapshot.overall_level == 2 && exceeded.incident_kind == 2 && exceeded.severity == 2;
}

static bool non_json_packed_test(void)
{
    evidence_t e; uint8_t evidence_hash[32], json_hash[32], packed_hash[32], type_hash[32];
    const char json[] = "{\"schema_version\":2,\"temperature_c_x100\":3047,\"co_ppm_x1000\":52000}";
    uint8_t packed[32 + 2 + 32 + 32 + 8 + 8 + 1 + 1 + 1 + 4]; size_t n = 0;
    fixture(&e, 1); hash_evidence(&e, evidence_hash); keccak256(json, strlen(json), json_hash);
    keccak256(k_evidence_type, strlen(k_evidence_type), type_hash); memcpy(packed + n, type_hash, 32); n += 32;
    packed[n++] = 0; packed[n++] = 2; memcpy(packed + n, e.device_id_hash, 32); n += 32; memcpy(packed + n, e.incident_id, 32); n += 32;
    for (int i = 7; i >= 0; --i) packed[n++] = (uint8_t)(e.sequence >> (i * 8));
    for (int i = 7; i >= 0; --i) packed[n++] = (uint8_t)(e.observed_at >> (i * 8));
    packed[n++] = e.time_source; packed[n++] = e.snapshot.sensor_valid_mask; packed[n++] = 2;
    for (int i = 3; i >= 0; --i) packed[n++] = (uint8_t)((uint32_t)e.snapshot.temperature_c_x100 >> (i * 8));
    keccak256(packed, n, packed_hash);
    return memcmp(evidence_hash, json_hash, 32) != 0 && memcmp(evidence_hash, packed_hash, 32) != 0;
}

static bool type_strings_test(void)
{
    static const char evidence[] = "IncidentEvidence(uint16 schemaVersion,bytes32 deviceIdHash,bytes32 incidentId,uint64 sequence,uint64 observedAt,uint8 timeSource,uint8 sensorValidMask,uint8 detectionMethod,int32 temperatureCx100,uint16 humidityPctX100,uint32 coPpmX1000,uint32 no2PpmX1000,uint8 overallLevel,uint8 coLevel,uint8 no2Level,uint8 coAlarmSourceMask,uint8 no2AlarmSourceMask,uint8 derivedValidMask,uint32 coStel15PpmX1000,uint32 no2Stel15PpmX1000,uint32 coTwa8hPpmX1000,uint32 no2Twa8hPpmX1000,uint32 coProj10PpmX1000,uint32 no2Proj10PpmX1000,uint8 modelProbabilityValidMask,uint16 coModelProbabilityBps,uint16 no2ModelProbabilityBps,uint8 incidentKind,uint8 severity,bytes32 firmwareVersionHash,bytes32 modelSha256,uint32 calibrationRevision,bytes32 calibrationHash)";
    static const char attestation[] = "IncidentAttestation(bytes32 deviceIdHash,bytes32 incidentId,uint64 sequence,uint64 observedAt,uint8 severity,bytes32 evidenceHash)";
    return strcmp(k_evidence_type, evidence) == 0 && strcmp(k_attestation_type, attestation) == 0;
}

static void report(const char *name, bool pass) { printf("%s:\n%s\n\n", name, pass ? "PASS" : "FAIL"); }

int main(void)
{
    bool evidence = evidence_tamper_test(), attestation = attestation_tamper_test(), int32 = int32_abi_test();
    bool uints = uint_abi_test(), bytes = bytes32_test(), masks = valid_masks_test(), sources = source_masks_test();
    bool enums = enum_contract_test(), hash_rule = non_json_packed_test(), types = type_strings_test();
    report("EVIDENCE TAMPER", evidence); report("ATTESTATION TAMPER", attestation); report("NEGATIVE INT32 ABI", int32);
    report("UINT ABI / ENDIAN", uints); report("BYTES32", bytes); report("VALID MASKS", masks);
    report("ALARM SOURCE MASKS", sources); report("ENUM CONTRACT", enums);
    report("NON-JSON / NON-PACKED HASH RULE", hash_rule); report("TYPE STRING INTEGRITY", types);
    return evidence && attestation && int32 && uints && bytes && masks && sources && enums && hash_rule && types ? 0 : 1;
}

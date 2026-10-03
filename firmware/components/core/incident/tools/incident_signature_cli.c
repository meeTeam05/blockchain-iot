/* Host-only signature verifier. It includes the firmware translation unit so
 * sign_digest_with_private_key() is the exact routine linked on ESP-IDF. */
#define INCIDENT_HOST_TEST 1
#define INCIDENT_HOST_CRYPTO_TEST 1
#include "../incident.c"

#include <stdlib.h>

static void fixture(evidence_t *e, int which)
{
    memset(e, 0, sizeof(*e));
    e->schema_version = 2;
    e->time_source = 1;
    e->snapshot.sensor_valid_mask = 15;
    e->snapshot.temperature_c_x100 = 3047;
    e->snapshot.humidity_pct_x100 = 7445;
    e->snapshot.co_ppm_x1000 = which == 1 ? 52000 : 70000;
    e->snapshot.no2_ppm_x1000 = which == 1 ? 323 : 450;
    e->snapshot.overall_level = which == 1 ? 1 : 2;
    e->snapshot.co_level = which == 1 ? 1 : 2;
    e->snapshot.co_alarm_source_mask = which == 1 ? 4 : 1;
    e->snapshot.derived_valid_mask = 63;
    e->snapshot.co_stel15_ppm_x1000 = which == 1 ? 24000 : 35000;
    e->snapshot.no2_stel15_ppm_x1000 = which == 1 ? 350 : 400;
    e->snapshot.co_twa8h_ppm_x1000 = which == 1 ? 1600 : 1800;
    e->snapshot.no2_twa8h_ppm_x1000 = which == 1 ? 22 : 25;
    e->snapshot.co_proj10_ppm_x1000 = which == 1 ? 36000 : 50000;
    e->snapshot.no2_proj10_ppm_x1000 = which == 1 ? 400 : 500;
    e->snapshot.model_probability_valid_mask = which == 1 ? 3 : 0;
    e->snapshot.co_model_probability_bps = which == 1 ? 9102 : 0;
    e->snapshot.no2_model_probability_bps = which == 1 ? 39 : 0;
    e->incident_kind = which == 1 ? 1 : 2;
    e->severity = which == 1 ? 1 : 2;
    e->sequence = which == 1 ? 43 : 44;
    e->observed_at = which == 1 ? 1790394600 : 1790394700;
    e->snapshot.calibration_revision = 3;
    e->snapshot.co_r0_q10000 = 98765;
    e->snapshot.no2_r0_q10000 = 43210;
    parse_hex32("0xd1a789f1e6ad1e2b5225fb8ed78876b5ef348c2a81741e46c8fcb50c85048dcc", e->model_sha256);
    set_calibration(e);
    keccak256("aa:bb:cc:dd:ee:ff", 17, e->device_id_hash);
    hash_incident_id(e->device_id_hash, e->sequence, e->incident_id);
    keccak256("0.1.1-gas-ews", 13, e->firmware_version_hash);
}

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

static void hex(const uint8_t *in, size_t bytes, char *out)
{
    static const char digits[] = "0123456789abcdef";
    out[0] = '0'; out[1] = 'x';
    for (size_t i = 0; i < bytes; ++i) { out[2 + i * 2] = digits[in[i] >> 4]; out[3 + i * 2] = digits[in[i] & 15]; }
    out[bytes * 2 + 2] = '\0';
}

static bool address_from_signature(const uint8_t digest[32], const uint8_t signature[65], char address[43])
{
    uint8_t public_key[65], hash[32];
    if (recover_public_key(digest, signature, public_key) != ESP_OK) return false;
    keccak256(public_key + 1, 64, hash);
    hex(hash + 12, 20, address);
    return true;
}

int main(int argc, char **argv)
{
    if (argc == 4 && strcmp(argv[1], "recover") == 0) {
        uint8_t digest[32], signature[65];
        char signer[43];
        if (!parse_hex(argv[2], digest, sizeof(digest)) || !parse_hex(argv[3], signature, sizeof(signature))) return 2;
        if (!address_from_signature(digest, signature, signer)) { puts("invalid"); return 0; }
        puts(signer);
        return 0;
    }
    if (argc != 4 || (argv[1][0] != '1' && argv[1][0] != '2')) return 2;
    evidence_t e;
    uint8_t digest[32], evidence_hash[32], private_key[32], signature[65], second[65], fixture_signature[65];
    char digest_hex[67], signature_hex[133], signer[43];
    fixture(&e, argv[1][0] - '0');
    hash_evidence(&e, evidence_hash);
    if (!hash_digest(&e, evidence_hash, digest) || !parse_hex(argv[2], private_key, sizeof(private_key)) ||
        !parse_hex(argv[3], fixture_signature, sizeof(fixture_signature))) return 3;
    if (sign_digest_with_private_key(digest, private_key, signature) != ESP_OK ||
        sign_digest_with_private_key(digest, private_key, second) != ESP_OK) return 4;
    hex(digest, sizeof(digest), digest_hex); hex(signature, sizeof(signature), signature_hex);
    if (!address_from_signature(digest, fixture_signature, signer)) return 5;
    printf("digest=%s\nsignature=%s\ndeterministic=%s\nlow_s=%s\nrecovered=%s\n",
           digest_hex, signature_hex, memcmp(signature, second, sizeof(signature)) == 0 ? "true" : "false",
           signature_has_low_s(signature) ? "true" : "false", signer);
    memset(private_key, 0, sizeof(private_key));
    return 0;
}

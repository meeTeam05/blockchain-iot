#include "esp_err.h"

#define CONFIG_SA_INCIDENT_SIGNER_PROVISION_BENCH 1
#define INCIDENT_SIGNER_PROVISION_HOST_TEST 1
#include "../incident_signer_provision_bench.c"

#include <stdio.h>

static bool g_signer_exists;
static unsigned g_provision_calls;
static uint8_t g_provisioned_key[32];

esp_err_t incident_get_signer_address(char out[43])
{
    if (!g_signer_exists) return ESP_ERR_INVALID_STATE;
    memcpy(out, "0x1111111111111111111111111111111111111111", 43);
    return ESP_OK;
}

esp_err_t incident_provision_signer(const uint8_t private_key[32])
{
    g_provision_calls++;
    memcpy(g_provisioned_key, private_key, sizeof(g_provisioned_key));
    g_signer_exists = true;
    return ESP_OK;
}

static void make_valid_hex(char out[65])
{
    memset(out, '0', 64);
    out[63] = '1';
    out[64] = '\0';
}

static bool buffer_is_zero(const uint8_t *buffer, size_t length)
{
    for (size_t i = 0; i < length; ++i) {
        if (buffer[i] != 0) return false;
    }
    return true;
}

static void report(const char *name, bool pass, bool *all_pass)
{
    printf("%s: %s\n", name, pass ? "PASS" : "FAIL");
    *all_pass = *all_pass && pass;
}

int main(void)
{
    bool pass = true;
    char valid[65];
    uint8_t key[32];
    make_valid_hex(valid);

    memset(key, 0xa5, sizeof(key));
    report("EXACT 64 HEX", signer_prov_decode_key(valid, key) == ESP_OK, &pass);
    signer_prov_zeroize(key, sizeof(key));

    char short_hex[64];
    memcpy(short_hex, valid, 63);
    short_hex[63] = '\0';
    memset(key, 0xa5, sizeof(key));
    report("63 HEX REJECTED", signer_prov_decode_key(short_hex, key) == ESP_ERR_INVALID_ARG &&
           buffer_is_zero(key, sizeof(key)), &pass);

    char long_hex[66];
    memcpy(long_hex, valid, 64);
    long_hex[64] = '0';
    long_hex[65] = '\0';
    memset(key, 0xa5, sizeof(key));
    report("65 HEX REJECTED", signer_prov_decode_key(long_hex, key) == ESP_ERR_INVALID_ARG &&
           buffer_is_zero(key, sizeof(key)), &pass);

    char non_hex[65];
    memcpy(non_hex, valid, sizeof(non_hex));
    non_hex[17] = 'g';
    memset(key, 0xa5, sizeof(key));
    report("NON-HEX REJECTED", signer_prov_decode_key(non_hex, key) == ESP_ERR_INVALID_ARG &&
           buffer_is_zero(key, sizeof(key)), &pass);

    char zero_hex[65];
    memset(zero_hex, '0', 64);
    zero_hex[64] = '\0';
    memset(key, 0xa5, sizeof(key));
    report("ZERO SCALAR REJECTED", signer_prov_decode_key(zero_hex, key) == ESP_ERR_INVALID_ARG &&
           buffer_is_zero(key, sizeof(key)), &pass);

    const char curve_order[] = "fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141";
    memset(key, 0xa5, sizeof(key));
    report("OUT-OF-RANGE SCALAR REJECTED", signer_prov_decode_key(curve_order, key) == ESP_ERR_INVALID_ARG &&
           buffer_is_zero(key, sizeof(key)), &pass);

    g_signer_exists = true;
    g_provision_calls = 0;
    memset(key, 0, sizeof(key));
    key[31] = 1;
    report("EXISTING SIGNER REJECTED", signer_prov_store_key(key) == ESP_ERR_INVALID_STATE &&
           g_provision_calls == 0 && buffer_is_zero(key, sizeof(key)), &pass);

    g_signer_exists = false;
    g_provision_calls = 0;
    memset(g_provisioned_key, 0, sizeof(g_provisioned_key));
    memset(key, 0, sizeof(key));
    key[31] = 1;
    report("PRODUCTION API SUCCESS PATH", signer_prov_store_key(key) == ESP_OK &&
           g_provision_calls == 1 && g_provisioned_key[31] == 1 &&
           buffer_is_zero(key, sizeof(key)), &pass);

    char line[SIGNER_PROV_LINE_CAPACITY];
    snprintf(line, sizeof(line), "%s%s", SIGNER_PROV_COMMAND_PREFIX, valid);
    g_signer_exists = false;
    g_provision_calls = 0;
    report("COMMAND SECRET TEXT ZEROIZED", signer_prov_process_line(line) == ESP_OK &&
           g_provision_calls == 1 &&
           buffer_is_zero((const uint8_t *)line + strlen(SIGNER_PROV_COMMAND_PREFIX), 64), &pass);

    uint8_t zeroize_probe[32];
    memset(zeroize_probe, 0xa5, sizeof(zeroize_probe));
    signer_prov_zeroize(zeroize_probe, sizeof(zeroize_probe));
    report("COMPILER-SAFE ZEROIZATION", buffer_is_zero(zeroize_probe, sizeof(zeroize_probe)), &pass);

    printf("SIGNER_PROVISION_BENCH_TEST: %s\n", pass ? "PASS" : "FAIL");
    return pass ? 0 : 1;
}

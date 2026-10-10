/* Test/operator-only UART bridge to the production signer lifecycle API. */
#ifndef INCIDENT_SIGNER_PROVISION_HOST_TEST
#include "sdkconfig.h"
#endif

#if CONFIG_SA_INCIDENT_SIGNER_PROVISION_BENCH

#include "incident.h"
#include "incident_signer_provision_bench.h"

#include "mbedtls/ecp.h"
#include "mbedtls/platform_util.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

#ifndef INCIDENT_SIGNER_PROVISION_HOST_TEST
#include "esp_log.h"
#include "esp_rom_uart.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#endif

#define SIGNER_PROV_COMMAND_PREFIX "incident signer-provision "
#define SIGNER_PROV_HEX_LENGTH 64U
#define SIGNER_PROV_LINE_CAPACITY 96U
#define SIGNER_PROV_TASK_STACK 4096U
#define SIGNER_PROV_TASK_PRIORITY 1U

#ifndef INCIDENT_SIGNER_PROVISION_HOST_TEST
static const char *TAG = "SIGNER_PROV";
#define SIGNER_PROV_INFO(format, ...) ESP_LOGI(TAG, format, ##__VA_ARGS__)
#define SIGNER_PROV_ERROR(format, ...) ESP_LOGE(TAG, format, ##__VA_ARGS__)
#else
#define SIGNER_PROV_INFO(format, ...) ((void)0)
#define SIGNER_PROV_ERROR(format, ...) ((void)0)
#endif

static void signer_prov_zeroize(void *buffer, size_t length)
{
    mbedtls_platform_zeroize(buffer, length);
}

static int hex_nibble(char value)
{
    if (value >= '0' && value <= '9') return value - '0';
    if (value >= 'a' && value <= 'f') return value - 'a' + 10;
    if (value >= 'A' && value <= 'F') return value - 'A' + 10;
    return -1;
}

static bool signer_prov_scalar_valid(const uint8_t private_key[32])
{
    mbedtls_ecp_group group;
    mbedtls_mpi scalar;
    mbedtls_ecp_group_init(&group);
    mbedtls_mpi_init(&scalar);

    int rc = mbedtls_ecp_group_load(&group, MBEDTLS_ECP_DP_SECP256K1);
    if (rc == 0) rc = mbedtls_mpi_read_binary(&scalar, private_key, 32);
    bool valid = rc == 0 && mbedtls_mpi_cmp_int(&scalar, 0) > 0 &&
                 mbedtls_mpi_cmp_mpi(&scalar, &group.N) < 0;

    mbedtls_mpi_free(&scalar);
    mbedtls_ecp_group_free(&group);
    return valid;
}

static esp_err_t signer_prov_decode_key(const char *hex, uint8_t private_key[32])
{
    if (private_key == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    signer_prov_zeroize(private_key, 32);
    if (hex == NULL || strlen(hex) != SIGNER_PROV_HEX_LENGTH) return ESP_ERR_INVALID_ARG;

    for (size_t i = 0; i < 32; ++i) {
        int high = hex_nibble(hex[i * 2]);
        int low = hex_nibble(hex[i * 2 + 1]);
        if (high < 0 || low < 0) {
            signer_prov_zeroize(private_key, 32);
            return ESP_ERR_INVALID_ARG;
        }
        private_key[i] = (uint8_t)((high << 4) | low);
    }

    if (!signer_prov_scalar_valid(private_key)) {
        signer_prov_zeroize(private_key, 32);
        return ESP_ERR_INVALID_ARG;
    }
    return ESP_OK;
}

static esp_err_t signer_prov_store_key(uint8_t private_key[32])
{
    char address[43] = {0};
    esp_err_t existing = incident_get_signer_address(address);
    if (existing == ESP_OK) {
        SIGNER_PROV_ERROR("signer already provisioned");
        SIGNER_PROV_INFO("signer address=%s", address);
        signer_prov_zeroize(private_key, 32);
        return ESP_ERR_INVALID_STATE;
    }
    if (existing != ESP_ERR_INVALID_STATE) {
        SIGNER_PROV_ERROR("unable to verify existing signer (%d)", (int)existing);
        signer_prov_zeroize(private_key, 32);
        return existing;
    }

    esp_err_t err = incident_provision_signer(private_key);
    signer_prov_zeroize(private_key, 32);
    if (err != ESP_OK) {
        SIGNER_PROV_ERROR("provisioning failed (%d)", (int)err);
        return err;
    }

    err = incident_get_signer_address(address);
    if (err != ESP_OK) {
        SIGNER_PROV_ERROR("post-write verification failed (%d)", (int)err);
        return err;
    }
    SIGNER_PROV_INFO("provisioning success");
    SIGNER_PROV_INFO("signer address=%s", address);
    return ESP_OK;
}

static esp_err_t signer_prov_process_line(char *line)
{
    const size_t prefix_length = sizeof(SIGNER_PROV_COMMAND_PREFIX) - 1U;
    if (line == NULL || strncmp(line, SIGNER_PROV_COMMAND_PREFIX, prefix_length) != 0) {
        return ESP_ERR_INVALID_ARG;
    }

    char *hex = line + prefix_length;
    uint8_t private_key[32] = {0};
    esp_err_t err = signer_prov_decode_key(hex, private_key);

    /* Remove the ASCII form before any NVS/crypto call or status logging. */
    signer_prov_zeroize(hex, strlen(hex));
    if (err != ESP_OK) {
        signer_prov_zeroize(private_key, sizeof(private_key));
        return err;
    }
    return signer_prov_store_key(private_key);
}

#ifndef INCIDENT_SIGNER_PROVISION_HOST_TEST
static void signer_prov_task(void *argument)
{
    (void)argument;
    char line[SIGNER_PROV_LINE_CAPACITY] = {0};
    size_t used = 0;
    bool overflow = false;

    SIGNER_PROV_INFO("UART command ready; firmware input echo is disabled");
    SIGNER_PROV_INFO("syntax: incident signer-provision <64 hex chars>");

    for (;;) {
        uint8_t value = 0;
        if (esp_rom_output_rx_one_char(&value) != 0) {
            vTaskDelay(pdMS_TO_TICKS(10));
            continue;
        }

        if (value == '\r' || value == '\n') {
            if (used == 0 && !overflow) continue;
            if (!overflow) {
                line[used] = '\0';
                if (signer_prov_process_line(line) == ESP_ERR_INVALID_ARG) {
                    SIGNER_PROV_ERROR("command rejected");
                }
            } else {
                SIGNER_PROV_ERROR("command rejected: input too long");
            }
            signer_prov_zeroize(line, sizeof(line));
            used = 0;
            overflow = false;
            continue;
        }

        if (value == '\b' || value == 0x7f) {
            if (used > 0 && !overflow) line[--used] = '\0';
            continue;
        }

        if (overflow) continue;
        if (used + 1U >= sizeof(line)) {
            signer_prov_zeroize(line, sizeof(line));
            used = 0;
            overflow = true;
            continue;
        }
        line[used++] = (char)value;
    }
}

esp_err_t incident_signer_provision_bench_start(void)
{
    BaseType_t result = xTaskCreate(signer_prov_task, "signer_prov", SIGNER_PROV_TASK_STACK,
                                    NULL, SIGNER_PROV_TASK_PRIORITY, NULL);
    return result == pdPASS ? ESP_OK : ESP_ERR_NO_MEM;
}
#endif

#endif /* CONFIG_SA_INCIDENT_SIGNER_PROVISION_BENCH */

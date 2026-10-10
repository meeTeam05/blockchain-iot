/**
 * @file ble_prov.c
 * 
 * @brief BLE Wi-Fi provisioning implementation using NimBLE.
 * 
 * Copyright (C) 2026 MinhNhat & BaoViet
 */

#include "ble_prov.h"
#include "wifi.h"

#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#include "host/ble_hs.h"
#include "host/ble_gap.h"
#include "host/ble_gatt.h"
#include "services/gap/ble_svc_gap.h"
#include "services/gatt/ble_svc_gatt.h"

#include "nvs_flash.h"
#include "nvs.h"
#include "esp_mac.h"
#include "esp_log.h"

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/event_groups.h"

#include <string.h>
#include <stdio.h>

#include "config.h"
#include "mbedtls/platform_util.h"

static const char *TAG = "ble_prov";

#define PROV_DONE_BIT BIT0
#define PROV_FAIL_BIT BIT1

/* GATT 16-bit UUIDs (vendor range 0xFF00-0xFFFF) */
static const ble_uuid16_t PROV_SVC_UUID = BLE_UUID16_INIT(0xFFFE);
static const ble_uuid16_t SSID_CHR_UUID = BLE_UUID16_INIT(0xFF01);
static const ble_uuid16_t PASS_CHR_UUID = BLE_UUID16_INIT(0xFF02);
static const ble_uuid16_t STAT_CHR_UUID = BLE_UUID16_INIT(0xFF03);

static char s_device_name[24];
static uint8_t s_own_addr_type;
static uint16_t s_conn_handle = BLE_HS_CONN_HANDLE_NONE;
static uint16_t s_status_val_handle;

static char s_ssid[64];
static char s_password[64];
static bool s_got_ssid;
static bool s_got_pass;

static EventGroupHandle_t s_prov_eg;
static TaskHandle_t s_prov_task_handle;
static bool s_nimble_initialized;
static portMUX_TYPE s_prov_eg_lock = portMUX_INITIALIZER_UNLOCKED;
static uint32_t s_prov_eg_users;

static void start_advertise(void);
static int gap_event(struct ble_gap_event *ev, void *arg);
static int prov_chr_access(uint16_t conn_handle, uint16_t attr_handle, struct ble_gatt_access_ctxt *ctxt, void *arg);
static void cleanup_start_failure(void);

static EventGroupHandle_t prov_event_group_acquire(void)
{
    EventGroupHandle_t prov_eg;

    portENTER_CRITICAL(&s_prov_eg_lock);
    prov_eg = s_prov_eg;
    if (prov_eg != NULL) {
        s_prov_eg_users++;
    }
    portEXIT_CRITICAL(&s_prov_eg_lock);

    return prov_eg;
}

static void prov_event_group_release(void)
{
    portENTER_CRITICAL(&s_prov_eg_lock);
    if (s_prov_eg_users > 0) {
        s_prov_eg_users--;
    }
    portEXIT_CRITICAL(&s_prov_eg_lock);
}

static void prov_event_group_wait_for_users(void)
{
    while (true) {
        uint32_t active_users = 0;

        portENTER_CRITICAL(&s_prov_eg_lock);
        active_users = s_prov_eg_users;
        portEXIT_CRITICAL(&s_prov_eg_lock);

        if (active_users == 0) {
            return;
        }

        vTaskDelay(pdMS_TO_TICKS(1));
    }
}

static const struct ble_gatt_svc_def s_gatt_svcs[] = {
    {
        .type = BLE_GATT_SVC_TYPE_PRIMARY,
        .uuid = &PROV_SVC_UUID.u,
        .characteristics =
            (struct ble_gatt_chr_def[]){
                {
                    /* 0xFF01 - SSID write */
                    .uuid = &SSID_CHR_UUID.u,
                    .access_cb = prov_chr_access,
                    .flags = BLE_GATT_CHR_F_WRITE | BLE_GATT_CHR_F_WRITE_NO_RSP,
                },
                {
                    /* 0xFF02 - Password write */
                    .uuid = &PASS_CHR_UUID.u,
                    .access_cb = prov_chr_access,
                    .flags = BLE_GATT_CHR_F_WRITE | BLE_GATT_CHR_F_WRITE_NO_RSP,
                },
                {
                    /* 0xFF03 - Status notify */
                    .uuid = &STAT_CHR_UUID.u,
                    .access_cb = prov_chr_access,
                    .flags = BLE_GATT_CHR_F_NOTIFY,
                    .val_handle = &s_status_val_handle,
                },
                {0}, /* terminator */
            },
    },
    {0}, /* terminator */
};

static esp_err_t save_credentials(const char *ssid, const char *password)
{
    esp_err_t guard_err = config_nvs_write_begin();
    if (guard_err != ESP_OK) {
        ESP_LOGW(TAG, "Skipping NVS save during factory reset (%s)", esp_err_to_name(guard_err));
        return guard_err;
    }

    nvs_handle_t h;
    esp_err_t err = nvs_open(SA_NVS_WIFI_NAMESPACE, NVS_READWRITE, &h);
    if (err != ESP_OK) {
        config_nvs_write_end();
        return err;
    }

    err = nvs_set_str(h, SA_NVS_KEY_SSID, ssid);
    if (err == ESP_OK) {
        err = nvs_set_str(h, SA_NVS_KEY_PASS, password);
    }
    if (err == ESP_OK) {
        err = nvs_set_u8(h, SA_NVS_KEY_DONE, 1);
    }
    if (err == ESP_OK) {
        err = nvs_commit(h);
    }
    nvs_close(h);
    config_nvs_write_end();
    if (err == ESP_OK) {
        ESP_LOGI(TAG, "Credentials saved to NVS");
    }
    return err;
}

static int prov_chr_access(uint16_t conn_handle, uint16_t attr_handle, struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    if (ctxt->op != BLE_GATT_ACCESS_OP_WRITE_CHR) {
        return BLE_ATT_ERR_UNLIKELY;
    }

    uint16_t len = OS_MBUF_PKTLEN(ctxt->om);

    if (ble_uuid_cmp(ctxt->chr->uuid, &SSID_CHR_UUID.u) == 0) {
        if (len == 0 || len >= sizeof(s_ssid)) {
            return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
        }
        os_mbuf_copydata(ctxt->om, 0, len, s_ssid);
        s_ssid[len] = '\0';
        s_got_ssid = true;
        ESP_LOGI(TAG, "Received SSID: %s", s_ssid);

    } else if (ble_uuid_cmp(ctxt->chr->uuid, &PASS_CHR_UUID.u) == 0) {
        if (len >= sizeof(s_password)) {
            return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
        }
        os_mbuf_copydata(ctxt->om, 0, len, s_password);
        s_password[len] = '\0';
        s_got_pass = true;
        ESP_LOGI(TAG, "Received password (len=%u)", len);

    } else {
        return BLE_ATT_ERR_UNLIKELY;
    }

    /* Both credentials received -> wake provisioning task */
    if (s_got_ssid && s_got_pass && s_prov_task_handle != NULL) {
        xTaskNotifyGive(s_prov_task_handle);
    }

    return 0;
}

/* Provisioning task */

static void prov_task(void *arg)
{
    /* Block until GATT access_cb has both credentials */
    uint32_t notified = ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(CONFIG_SA_PROV_TIMEOUT_MS));
    if (notified == 0) {
        ESP_LOGW(TAG, "Provisioning timed out; no credentials received");
        EventGroupHandle_t prov_eg = prov_event_group_acquire();
        if (prov_eg != NULL) {
            xEventGroupSetBits(prov_eg, PROV_FAIL_BIT);
            prov_event_group_release();
        }
        mbedtls_platform_zeroize(s_ssid, sizeof(s_ssid));
        mbedtls_platform_zeroize(s_password, sizeof(s_password));
        s_prov_task_handle = NULL;
        vTaskDelete(NULL);
        return;
    }

    ESP_LOGI(TAG, "Attempting WiFi connect to SSID: %s", s_ssid);

    esp_err_t err = wifi_sta_connect(s_ssid, s_password, CONFIG_SA_WIFI_CONNECT_TIMEOUT_MS);

    /* Build JSON status payload */
    char json[80];
    if (err == ESP_OK) {
        char ip[16] = {0};
        wifi_sta_get_ip(ip, sizeof(ip));
        uint8_t mac[6];
        esp_read_mac(mac, ESP_MAC_WIFI_STA);
        char mac_str[18];
        snprintf(
            mac_str, sizeof(mac_str), "%02x:%02x:%02x:%02x:%02x:%02x", mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
        snprintf(json, sizeof(json), "{\"ip\":\"%s\",\"device_id\":\"%s\",\"status\":\"ok\"}", ip, mac_str);
        esp_err_t save_err = save_credentials(s_ssid, s_password);
        if (save_err != ESP_OK) {
            err = save_err;
            snprintf(json, sizeof(json), "{\"status\":\"fail\"}");
            ESP_LOGW(TAG, "Provisioning NVS save failed: %s", esp_err_to_name(save_err));
        } else {
            ESP_LOGI(TAG, "Provisioning OK; IP: %s", ip);
        }
    } else {
        snprintf(json, sizeof(json), "{\"status\":\"fail\"}");
        ESP_LOGW(TAG, "WiFi connect failed: %s", esp_err_to_name(err));
    }

    /* Notify the BLE client with the result */
    if (s_conn_handle != BLE_HS_CONN_HANDLE_NONE) {
        struct os_mbuf *om = ble_hs_mbuf_from_flat(json, strlen(json));
        if (om != NULL) {
            int rc = ble_gatts_notify_custom(s_conn_handle, s_status_val_handle, om);
            if (rc != 0) {
                ESP_LOGW(TAG, "Notify failed: %d", rc);
            }
        }
        /* Give Flutter 500 ms to receive the notification before BLE stops */
        vTaskDelay(pdMS_TO_TICKS(500));
    }

    /* Signal ble_prov_start() to unblock */
    EventGroupHandle_t prov_eg = prov_event_group_acquire();
    if (prov_eg != NULL) {
        xEventGroupSetBits(prov_eg, err == ESP_OK ? PROV_DONE_BIT : PROV_FAIL_BIT);
        prov_event_group_release();
    }
    mbedtls_platform_zeroize(s_ssid, sizeof(s_ssid));
    mbedtls_platform_zeroize(s_password, sizeof(s_password));
    s_prov_task_handle = NULL;
    vTaskDelete(NULL);
}

/* BLE advertising */

static void start_advertise(void)
{
    struct ble_hs_adv_fields fields = {0};
    fields.flags = BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP;
    fields.name = (const uint8_t *)s_device_name;
    fields.name_len = (uint8_t)strlen(s_device_name);
    fields.name_is_complete = 1;

    int rc = ble_gap_adv_set_fields(&fields);
    if (rc != 0) {
        ESP_LOGE(TAG, "adv_set_fields error: %d", rc);
        return;
    }

    struct ble_gap_adv_params adv_params = {0};
    adv_params.conn_mode = BLE_GAP_CONN_MODE_UND;
    adv_params.disc_mode = BLE_GAP_DISC_MODE_GEN;

    rc = ble_gap_adv_start(s_own_addr_type, NULL, BLE_HS_FOREVER, &adv_params, gap_event, NULL);
    if (rc != 0) {
        ESP_LOGE(TAG, "adv_start error: %d", rc);
    } else {
        ESP_LOGI(TAG, "Advertising as '%s'", s_device_name);
    }
}

/* GAP event handler */

static int gap_event(struct ble_gap_event *ev, void *arg)
{
    switch (ev->type) {
    case BLE_GAP_EVENT_CONNECT:
        if (ev->connect.status == 0) {
            s_conn_handle = ev->connect.conn_handle;
            ESP_LOGI(TAG, "Client connected (handle=%u)", s_conn_handle);
        } else {
            s_conn_handle = BLE_HS_CONN_HANDLE_NONE;
            start_advertise(); /* re-advertise if connect failed */
        }
        break;

    case BLE_GAP_EVENT_DISCONNECT:
        ESP_LOGI(TAG, "Client disconnected (reason=%d)", ev->disconnect.reason);
        s_conn_handle = BLE_HS_CONN_HANDLE_NONE;
        /* Re-advertise only if provisioning not yet complete */
        EventGroupHandle_t prov_eg = prov_event_group_acquire();
        EventBits_t bits = prov_eg != NULL ? xEventGroupGetBits(prov_eg) : (PROV_DONE_BIT | PROV_FAIL_BIT);
        if (prov_eg != NULL) {
            prov_event_group_release();
        }
        if (!(bits & (PROV_DONE_BIT | PROV_FAIL_BIT))) {
            start_advertise();
        }
        break;

    default:
        break;
    }
    return 0;
}

/* NimBLE host sync callback */

static void on_sync(void)
{
    ble_hs_id_infer_auto(0, &s_own_addr_type);

    /* Build name: SA_PROV_NAME_PREFIX + last 3 MAC bytes */
    uint8_t mac[6];
    esp_read_mac(mac, ESP_MAC_WIFI_STA);
    snprintf(s_device_name, sizeof(s_device_name), SA_PROV_NAME_PREFIX "_%02X%02X%02X", mac[3], mac[4], mac[5]);
    ble_svc_gap_device_name_set(s_device_name);

    start_advertise();
}

/* NimBLE host task */

static void nimble_host_task(void *param)
{
    ESP_LOGI(TAG, "NimBLE host task started");
    nimble_port_run(); /* blocks until nimble_port_stop() */
    nimble_port_freertos_deinit();
    vTaskDelete(NULL);
}

/* Public API */

bool ble_prov_is_provisioned(void)
{
    nvs_handle_t h;
    if (nvs_open(SA_NVS_WIFI_NAMESPACE, NVS_READONLY, &h) != ESP_OK) {
        return false;
    }
    uint8_t flag = 0;
    nvs_get_u8(h, SA_NVS_KEY_DONE, &flag);
    nvs_close(h);
    return flag == 1;
}

esp_err_t ble_prov_start(void)
{
    s_prov_eg = xEventGroupCreate();
    if (s_prov_eg == NULL) {
        ESP_LOGE(TAG, "Failed to create provisioning event group");
        return ESP_ERR_NO_MEM;
    }

    s_got_ssid = false;
    s_got_pass = false;
    s_conn_handle = BLE_HS_CONN_HANDLE_NONE;
    s_prov_task_handle = NULL;

    memset(s_ssid, 0, sizeof(s_ssid));
    memset(s_password, 0, sizeof(s_password));

    /* Provisioning task waits for credentials, then connects WiFi. */
    BaseType_t rc = xTaskCreatePinnedToCore(prov_task, "ble_prov_t", 4096, NULL, 5, &s_prov_task_handle, APP_CPU_NUM);
    if (rc != pdPASS) {
        ESP_LOGE(TAG, "prov_task create failed; insufficient heap");
        cleanup_start_failure();
        return ESP_ERR_NO_MEM;
    }

    /* Init NimBLE host + GATT */
    esp_err_t err = nimble_port_init();
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "nimble_port_init failed: %s", esp_err_to_name(err));
        cleanup_start_failure();
        return err;
    }
    s_nimble_initialized = true;

    ble_svc_gap_init();
    ble_svc_gatt_init();

    int ble_rc = ble_gatts_count_cfg(s_gatt_svcs);
    if (ble_rc != 0) {
        ESP_LOGE(TAG, "ble_gatts_count_cfg failed: %d", ble_rc);
        cleanup_start_failure();
        return ESP_FAIL;
    }

    ble_rc = ble_gatts_add_svcs(s_gatt_svcs);
    if (ble_rc != 0) {
        ESP_LOGE(TAG, "ble_gatts_add_svcs failed: %d", ble_rc);
        cleanup_start_failure();
        return ESP_FAIL;
    }

    ble_hs_cfg.sync_cb = on_sync;
    ble_hs_cfg.reset_cb = NULL;

    nimble_port_freertos_init(nimble_host_task);

    /* Block until provisioning succeeds or fails */
    EventBits_t bits = xEventGroupWaitBits(s_prov_eg, PROV_DONE_BIT | PROV_FAIL_BIT, pdFALSE, pdFALSE, portMAX_DELAY);

    return (bits & PROV_DONE_BIT) ? ESP_OK : ESP_FAIL;
}

void ble_prov_stop(void)
{
    if (s_nimble_initialized) {
        nimble_port_stop();
        nimble_port_deinit();
        s_nimble_initialized = false;
    }

    EventGroupHandle_t prov_eg = NULL;

    portENTER_CRITICAL(&s_prov_eg_lock);
    prov_eg = s_prov_eg;
    s_prov_eg = NULL;
    portEXIT_CRITICAL(&s_prov_eg_lock);

    if (prov_eg != NULL) {
        prov_event_group_wait_for_users();
        vEventGroupDelete(prov_eg);
    }
}

esp_err_t ble_prov_load_credentials(char *ssid_buf, size_t ssid_len, char *pass_buf, size_t pass_len)
{
    nvs_handle_t h;
    esp_err_t err = nvs_open(SA_NVS_WIFI_NAMESPACE, NVS_READONLY, &h);
    if (err != ESP_OK)
        return err;

    err = nvs_get_str(h, SA_NVS_KEY_SSID, ssid_buf, &ssid_len);
    if (err != ESP_OK) {
        nvs_close(h);
        return err;
    }

    err = nvs_get_str(h, SA_NVS_KEY_PASS, pass_buf, &pass_len);
    nvs_close(h);
    return err;
}

esp_err_t ble_prov_reset(void)
{
    esp_err_t guard_err = config_nvs_write_begin();
    if (guard_err != ESP_OK) {
        return guard_err;
    }

    nvs_handle_t h;
    esp_err_t err = nvs_open(SA_NVS_WIFI_NAMESPACE, NVS_READWRITE, &h);
    if (err != ESP_OK) {
        config_nvs_write_end();
        return err;
    }

    nvs_erase_all(h);
    err = nvs_commit(h);
    nvs_close(h);
    config_nvs_write_end();
    if (err == ESP_OK) {
        ESP_LOGI(TAG, "Provisioning credentials cleared");
    }
    return err;
}

static void cleanup_start_failure(void)
{
    if (s_prov_task_handle != NULL) {
        vTaskDelete(s_prov_task_handle);
        s_prov_task_handle = NULL;
    }
    if (s_nimble_initialized) {
        nimble_port_deinit();
        s_nimble_initialized = false;
    }
    EventGroupHandle_t prov_eg = NULL;

    portENTER_CRITICAL(&s_prov_eg_lock);
    prov_eg = s_prov_eg;
    s_prov_eg = NULL;
    portEXIT_CRITICAL(&s_prov_eg_lock);

    if (prov_eg != NULL) {
        prov_event_group_wait_for_users();
        vEventGroupDelete(prov_eg);
    }
}

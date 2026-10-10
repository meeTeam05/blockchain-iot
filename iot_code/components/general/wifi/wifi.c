/**
 * @file wifi.c
 * 
 * @brief Wi-Fi station mode driver.
 * 
 * Copyright (C) 2026 MinhNhat & BaoViet
 */

#include "wifi.h"

#include "esp_wifi.h"
#include "esp_event.h"
#include "esp_netif.h"
#include "esp_log.h"
#include "lwip/ip4_addr.h"

#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/task.h"

#include <string.h>

#include "config.h"

static const char *TAG = "wifi_sta";

#define WIFI_CONNECTED_BIT BIT0
#define WIFI_FAIL_BIT      BIT1

static EventGroupHandle_t s_wifi_eg;
static esp_netif_t *s_netif;
static esp_event_handler_instance_t s_wifi_event_handler;
static esp_event_handler_instance_t s_ip_event_handler;
static char s_ip[16];
static bool s_initialized;
static int s_reconnect_count;
static portMUX_TYPE s_state_lock = portMUX_INITIALIZER_UNLOCKED;
static uint32_t s_wifi_eg_users;

#define WIFI_MAX_RECONNECT_ATTEMPTS 10

static bool wifi_cleanup_err_is_benign(esp_err_t err)
{
    return err == ESP_OK || err == ESP_ERR_WIFI_NOT_INIT || err == ESP_ERR_WIFI_NOT_STARTED
           || err == ESP_ERR_WIFI_NOT_CONNECT;
}

static void wifi_record_cleanup_result(const char *step, esp_err_t step_err, esp_err_t *first_err)
{
    if (step_err == ESP_OK) {
        return;
    }

    if (wifi_cleanup_err_is_benign(step_err)) {
        ESP_LOGW(TAG, "%s during Wi-Fi cleanup: %s", step, esp_err_to_name(step_err));
        return;
    }

    ESP_LOGE(TAG, "%s during Wi-Fi cleanup failed: %s", step, esp_err_to_name(step_err));
    if (first_err != NULL && *first_err == ESP_OK) {
        *first_err = step_err;
    }
}

static EventGroupHandle_t wifi_event_group_acquire(void)
{
    EventGroupHandle_t wifi_eg = NULL;

    portENTER_CRITICAL(&s_state_lock);
    if (s_wifi_eg != NULL) {
        s_wifi_eg_users++;
        wifi_eg = s_wifi_eg;
    }
    portEXIT_CRITICAL(&s_state_lock);

    return wifi_eg;
}

static void wifi_event_group_release(void)
{
    portENTER_CRITICAL(&s_state_lock);
    if (s_wifi_eg_users > 0) {
        s_wifi_eg_users--;
    }
    portEXIT_CRITICAL(&s_state_lock);
}

static void wifi_event_group_wait_for_users(void)
{
    while (1) {
        uint32_t active_users = 0;

        portENTER_CRITICAL(&s_state_lock);
        active_users = s_wifi_eg_users;
        portEXIT_CRITICAL(&s_state_lock);

        if (active_users == 0) {
            return;
        }

        vTaskDelay(pdMS_TO_TICKS(1));
    }
}

static int wifi_reconnect_count_increment(void)
{
    int attempt = 0;

    portENTER_CRITICAL(&s_state_lock);
    if (s_reconnect_count < WIFI_MAX_RECONNECT_ATTEMPTS) {
        s_reconnect_count++;
        attempt = s_reconnect_count;
    }
    portEXIT_CRITICAL(&s_state_lock);

    return attempt;
}

static void wifi_reconnect_count_reset(void)
{
    portENTER_CRITICAL(&s_state_lock);
    s_reconnect_count = 0;
    portEXIT_CRITICAL(&s_state_lock);
}

static void wifi_reconnect_count_exhaust(void)
{
    portENTER_CRITICAL(&s_state_lock);
    s_reconnect_count = WIFI_MAX_RECONNECT_ATTEMPTS;
    portEXIT_CRITICAL(&s_state_lock);
}

static void wifi_ip_copy_out(char *buf, size_t len)
{
    portENTER_CRITICAL(&s_state_lock);
    strlcpy(buf, s_ip, len);
    portEXIT_CRITICAL(&s_state_lock);
}

static void wifi_ip_store(const char *ip)
{
    portENTER_CRITICAL(&s_state_lock);
    strlcpy(s_ip, ip, sizeof(s_ip));
    portEXIT_CRITICAL(&s_state_lock);
}

static void wifi_abort_pending_connect(EventGroupHandle_t wifi_eg)
{
    wifi_reconnect_count_exhaust();
    xEventGroupClearBits(wifi_eg, WIFI_CONNECTED_BIT | WIFI_FAIL_BIT);

    esp_err_t err = esp_wifi_disconnect();
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "esp_wifi_disconnect after connect timeout failed: %s", esp_err_to_name(err));
    }
}

static esp_err_t wifi_apply_custom_dns(void)
{
    esp_netif_t *sta_netif = esp_netif_get_handle_from_ifkey("WIFI_STA_DEF");
    if (sta_netif == NULL) {
        ESP_LOGE(TAG, "WIFI_STA_DEF netif not found; cannot apply custom DNS");
        return ESP_ERR_NOT_FOUND;
    }

    uint32_t dns_addr = ipaddr_addr(SA_CUSTOM_DNS_SERVER);
    if (dns_addr == IPADDR_NONE) {
        ESP_LOGE(TAG, "Invalid SA_CUSTOM_DNS_SERVER value: %s", SA_CUSTOM_DNS_SERVER);
        return ESP_ERR_INVALID_ARG;
    }

    esp_netif_dns_info_t dns = {0};
    dns.ip.u_addr.ip4.addr = dns_addr;
    dns.ip.type = ESP_IPADDR_TYPE_V4;

    esp_err_t err = esp_netif_set_dns_info(sta_netif, ESP_NETIF_DNS_MAIN, &dns);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Failed to apply custom DNS %s: %s", SA_CUSTOM_DNS_SERVER, esp_err_to_name(err));
        return err;
    }

    ESP_LOGI(TAG, "Applied custom DNS on WIFI_STA_DEF: %s", SA_CUSTOM_DNS_SERVER);
    return ESP_OK;
}

static void wifi_event_handler(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    EventGroupHandle_t wifi_eg = wifi_event_group_acquire();
    if (wifi_eg == NULL) {
        return;
    }

    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        xEventGroupClearBits(wifi_eg, WIFI_CONNECTED_BIT);

        int attempt = wifi_reconnect_count_increment();
        if (attempt > 0) {
            ESP_LOGW(TAG, "Disconnected; reconnect attempt %d/%d", attempt, WIFI_MAX_RECONNECT_ATTEMPTS);
            esp_wifi_connect();
        } else {
            ESP_LOGE(TAG, "Disconnected; max reconnect attempts reached, giving up");
            xEventGroupSetBits(wifi_eg, WIFI_FAIL_BIT);
        }

    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *ev = (ip_event_got_ip_t *)data;
        char ip[sizeof(s_ip)];
        snprintf(ip, sizeof(ip), IPSTR, IP2STR(&ev->ip_info.ip));
        wifi_ip_store(ip);
        ESP_LOGI(TAG, "Got IP: %s", ip);
        esp_err_t dns_err = wifi_apply_custom_dns();
        if (dns_err != ESP_OK) {
            ESP_LOGW(TAG, "Continuing with DHCP DNS after custom DNS apply failure");
        }
        wifi_reconnect_count_reset();
        xEventGroupClearBits(wifi_eg, WIFI_FAIL_BIT);
        xEventGroupSetBits(wifi_eg, WIFI_CONNECTED_BIT);
    }

    wifi_event_group_release();
}

esp_err_t wifi_sta_init(void)
{
    if (s_initialized) {
        return ESP_OK; /* idempotent */
    }

    bool wifi_inited = false;
    esp_err_t err = ESP_OK;

    s_wifi_eg = xEventGroupCreate();
    if (s_wifi_eg == NULL) {
        return ESP_ERR_NO_MEM;
    }

    s_netif = esp_netif_create_default_wifi_sta();
    if (s_netif == NULL) {
        err = ESP_FAIL;
        goto fail;
    }

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    err = esp_wifi_init(&cfg);
    if (err != ESP_OK) {
        goto fail;
    }
    wifi_inited = true;

    err = esp_event_handler_instance_register(
        WIFI_EVENT, ESP_EVENT_ANY_ID, &wifi_event_handler, NULL, &s_wifi_event_handler);
    if (err != ESP_OK) {
        goto fail;
    }

    err = esp_event_handler_instance_register(
        IP_EVENT, IP_EVENT_STA_GOT_IP, &wifi_event_handler, NULL, &s_ip_event_handler);
    if (err != ESP_OK) {
        goto fail;
    }

    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_start());

    s_initialized = true;
    ESP_LOGI(TAG, "Wi-Fi station initialized");
    return ESP_OK;

fail:
    if (s_wifi_event_handler != NULL) {
        esp_event_handler_instance_unregister(WIFI_EVENT, ESP_EVENT_ANY_ID, s_wifi_event_handler);
        s_wifi_event_handler = NULL;
    }
    if (s_ip_event_handler != NULL) {
        esp_event_handler_instance_unregister(IP_EVENT, IP_EVENT_STA_GOT_IP, s_ip_event_handler);
        s_ip_event_handler = NULL;
    }
    if (s_netif != NULL) {
        esp_netif_destroy(s_netif);
        s_netif = NULL;
    }
    if (wifi_inited) {
        esp_wifi_deinit();
    }
    if (s_wifi_eg != NULL) {
        vEventGroupDelete(s_wifi_eg);
        s_wifi_eg = NULL;
    }
    return err;
}

esp_err_t wifi_sta_connect(const char *ssid, const char *password, uint32_t timeout_ms)
{
    EventGroupHandle_t wifi_eg = wifi_event_group_acquire();
    if (wifi_eg == NULL) {
        return ESP_ERR_INVALID_STATE;
    }

    if (!s_initialized)
        goto invalid_state;
    if (ssid == NULL || password == NULL)
        goto invalid_arg;

    /* Fresh connection attempt starts with a clean retry budget and event state */
    wifi_reconnect_count_reset();
    xEventGroupClearBits(wifi_eg, WIFI_CONNECTED_BIT | WIFI_FAIL_BIT);

    wifi_config_t cfg = {0};
    strncpy((char *)cfg.sta.ssid, ssid, sizeof(cfg.sta.ssid) - 1);
    strncpy((char *)cfg.sta.password, password, sizeof(cfg.sta.password) - 1);
    cfg.sta.threshold.authmode = (*password == '\0') ? WIFI_AUTH_OPEN : WIFI_AUTH_WPA2_PSK;

    esp_err_t err = esp_wifi_set_config(WIFI_IF_STA, &cfg);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "set_config failed: %s", esp_err_to_name(err));
        wifi_event_group_release();
        return err;
    }

    err = esp_wifi_connect();
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "esp_wifi_connect failed: %s", esp_err_to_name(err));
        wifi_event_group_release();
        return err;
    }

    EventBits_t bits =
        xEventGroupWaitBits(wifi_eg, WIFI_CONNECTED_BIT | WIFI_FAIL_BIT, pdFALSE, pdFALSE, pdMS_TO_TICKS(timeout_ms));
    if (bits & WIFI_CONNECTED_BIT) {
        wifi_event_group_release();
        return ESP_OK;
    }
    if (bits & WIFI_FAIL_BIT) {
        wifi_event_group_release();
        return ESP_FAIL;
    }

    wifi_abort_pending_connect(wifi_eg);
    wifi_event_group_release();
    return ESP_ERR_TIMEOUT;

invalid_state:
    wifi_event_group_release();
    return ESP_ERR_INVALID_STATE;

invalid_arg:
    wifi_event_group_release();
    return ESP_ERR_INVALID_ARG;
}

bool wifi_sta_is_connected(void)
{
    EventGroupHandle_t wifi_eg = wifi_event_group_acquire();
    if (wifi_eg == NULL)
        return false;

    bool is_connected = (xEventGroupGetBits(wifi_eg) & WIFI_CONNECTED_BIT) != 0;
    wifi_event_group_release();
    return is_connected;
}

esp_err_t wifi_sta_get_ssid(char *buf, size_t len)
{
    if (buf == NULL || len == 0) {
        return ESP_ERR_INVALID_ARG;
    }

    wifi_ap_record_t ap_info = {0};
    esp_err_t err = esp_wifi_sta_get_ap_info(&ap_info);
    if (err != ESP_OK) {
        return err;
    }

    strlcpy(buf, (const char *)ap_info.ssid, len);
    return ESP_OK;
}

esp_err_t wifi_sta_get_rssi(int *rssi_dbm)
{
    if (rssi_dbm == NULL) {
        return ESP_ERR_INVALID_ARG;
    }

    wifi_ap_record_t ap_info = {0};
    esp_err_t err = esp_wifi_sta_get_ap_info(&ap_info);
    if (err != ESP_OK) {
        return err;
    }

    *rssi_dbm = ap_info.rssi;
    return ESP_OK;
}

void wifi_sta_get_ip(char *buf, size_t len)
{
    if (buf == NULL || len == 0)
        return;
    wifi_ip_copy_out(buf, len);
}

esp_err_t wifi_sta_deinit(void)
{
    if (!s_initialized)
        return ESP_OK;

    EventGroupHandle_t wifi_eg = NULL;
    esp_netif_t *netif = NULL;
    esp_event_handler_instance_t wifi_handler = NULL;
    esp_event_handler_instance_t ip_handler = NULL;
    esp_err_t err = ESP_OK;

    portENTER_CRITICAL(&s_state_lock);
    wifi_eg = s_wifi_eg;
    s_wifi_eg = NULL;
    netif = s_netif;
    s_netif = NULL;
    wifi_handler = s_wifi_event_handler;
    s_wifi_event_handler = NULL;
    ip_handler = s_ip_event_handler;
    s_ip_event_handler = NULL;
    s_initialized = false;
    s_reconnect_count = 0;
    s_ip[0] = '\0';
    portEXIT_CRITICAL(&s_state_lock);

    if (wifi_eg != NULL) {
        xEventGroupSetBits(wifi_eg, WIFI_FAIL_BIT);
    }
    if (wifi_handler != NULL) {
        wifi_record_cleanup_result("esp_event_handler_instance_unregister(WIFI_EVENT)",
                                   esp_event_handler_instance_unregister(WIFI_EVENT, ESP_EVENT_ANY_ID, wifi_handler),
                                   &err);
    }
    if (ip_handler != NULL) {
        wifi_record_cleanup_result("esp_event_handler_instance_unregister(IP_EVENT)",
                                   esp_event_handler_instance_unregister(IP_EVENT, IP_EVENT_STA_GOT_IP, ip_handler),
                                   &err);
    }
    wifi_event_group_wait_for_users();

    wifi_record_cleanup_result("esp_wifi_disconnect", esp_wifi_disconnect(), &err);
    wifi_record_cleanup_result("esp_wifi_stop", esp_wifi_stop(), &err);
    wifi_record_cleanup_result("esp_wifi_deinit", esp_wifi_deinit(), &err);
    if (netif != NULL) {
        esp_netif_destroy(netif);
    }
    if (wifi_eg != NULL) {
        vEventGroupDelete(wifi_eg);
    }
    return err;
}

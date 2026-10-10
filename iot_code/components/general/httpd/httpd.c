/**
 * @file httpd.c
 *
 * @brief HTTP info server + mDNS advertisement.
 *
 * Architecture:
 *   - httpd_server_start() inits mDNS then starts the HTTP server.
 *   - GET /api/info returns device_id, firmware version, and current IP.
 *   - POST /api/config stores the first MQTT credential set from provisioning.
 *
 * Copyright (C) 2026 MinhNhat & BaoViet
 */

#include "httpd.h"

#include "cJSON.h"
#include "config.h"
#include "esp_http_server.h"
#include "esp_log.h"
#include "esp_system.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include <string.h>

static const char *TAG = "httpd";
#define MAX_CONFIG_BODY_LEN 512
#define MAX_CONFIG_RECV_TIMEOUTS 3

/* Handler context */

typedef struct {
    char device_id[64];
    char ip[16];
} httpd_ctx_t;

static httpd_ctx_t s_ctx;

/* GET /api/info */

static esp_err_t info_get_handler(httpd_req_t *req)
{
    httpd_ctx_t *ctx = (httpd_ctx_t *)req->user_ctx;

    char resp[256];
    snprintf(resp,
             sizeof(resp),
             "{\"device_id\":\"%s\",\"firmware\":\"%s\",\"ip\":\"%s\"}",
             ctx->device_id,
             FIRMWARE_VERSION,
             ctx->ip);

    httpd_resp_set_type(req, "application/json");
    httpd_resp_sendstr(req, resp);
    ESP_LOGI(TAG, "GET /api/info -> %s", resp);
    return ESP_OK;
}

static void restart_task(void *arg)
{
    (void)arg;
    vTaskDelay(pdMS_TO_TICKS(750));
    esp_restart();
}

static esp_err_t send_json_error(httpd_req_t *req, const char *status, const char *error)
{
    char resp[128];
    snprintf(resp, sizeof(resp), "{\"error\":\"%s\"}", error);
    httpd_resp_set_status(req, status);
    httpd_resp_set_type(req, "application/json");
    return httpd_resp_sendstr(req, resp);
}

/* POST /api/config */

static esp_err_t config_post_handler(httpd_req_t *req)
{
    if (req->content_len <= 0 || req->content_len > MAX_CONFIG_BODY_LEN) {
        return send_json_error(req, "400 Bad Request", "invalid content length");
    }

    char body[MAX_CONFIG_BODY_LEN + 1] = {0};
    size_t received = 0;
    int timeout_count = 0;
    while (received < (size_t)req->content_len) {
        int rc = httpd_req_recv(req, body + received, (size_t)req->content_len - received);
        if (rc == HTTPD_SOCK_ERR_TIMEOUT) {
            timeout_count++;
            if (timeout_count >= MAX_CONFIG_RECV_TIMEOUTS) {
                ESP_LOGW(TAG,
                         "POST /api/config recv timed out after %d attempts (received=%u/%lu)",
                         timeout_count,
                         (unsigned)received,
                         (unsigned long)req->content_len);
                return send_json_error(req, "408 Request Timeout", "request body receive timeout");
            }
            continue;
        }
        if (rc <= 0) {
            ESP_LOGW(TAG,
                     "POST /api/config recv failed (rc=%d received=%u/%lu)",
                     rc,
                     (unsigned)received,
                     (unsigned long)req->content_len);
            return send_json_error(req, "400 Bad Request", "request body receive failed");
        }
        timeout_count = 0;
        received += (size_t)rc;
    }
    body[received] = '\0';

    cJSON *root = cJSON_ParseWithLength(body, received);
    if (root == NULL) {
        return send_json_error(req, "400 Bad Request", "invalid JSON");
    }

    cJSON *j_device_id = cJSON_GetObjectItemCaseSensitive(root, "device_id");
    cJSON *j_secret_key = cJSON_GetObjectItemCaseSensitive(root, "secret_key");
    cJSON *j_broker_uri = cJSON_GetObjectItemCaseSensitive(root, "broker_uri");

    const char *broker_uri = cJSON_IsString(j_broker_uri) ? j_broker_uri->valuestring : NULL;
    if (!cJSON_IsString(j_device_id) || !cJSON_IsString(j_secret_key)) {
        cJSON_Delete(root);
        return send_json_error(req, "400 Bad Request", "device_id and secret_key required");
    }

    char existing_broker[128] = {0};
    char existing_secret_key[64] = {0};
    esp_err_t err = config_get_mqtt_creds(
        existing_broker, sizeof(existing_broker), existing_secret_key, sizeof(existing_secret_key));
    if (err != ESP_OK) {
        cJSON_Delete(root);
        return send_json_error(req, "500 Internal Server Error", "config read failed");
    }
    if (existing_secret_key[0] != '\0') {
        cJSON_Delete(root);
        return send_json_error(req, "409 Conflict", "mqtt config already provisioned");
    }

    if (strcmp(j_device_id->valuestring, s_ctx.device_id) != 0) {
        cJSON_Delete(root);
        return send_json_error(req, "400 Bad Request", "device_id must match device MAC");
    }

    err = config_set_mqtt_config(broker_uri, j_device_id->valuestring, j_secret_key->valuestring);
    cJSON_Delete(root);

    if (err == ESP_ERR_INVALID_ARG) {
        return send_json_error(req, "400 Bad Request", "invalid mqtt config");
    }
    if (err != ESP_OK) {
        return send_json_error(req, "500 Internal Server Error", "config write failed");
    }

    BaseType_t restart_rc = xTaskCreate(restart_task, "config_reboot", 2048, NULL, 5, NULL);
    if (restart_rc != pdPASS) {
        ESP_LOGE(TAG, "failed to create config_reboot task");
        return send_json_error(req, "500 Internal Server Error", "config saved but reboot failed");
    }

    httpd_resp_set_type(req, "application/json");
    return httpd_resp_sendstr(req, "{\"ok\":true,\"rebooting\":true}");
}

static const httpd_uri_t uri_info = {
    .uri = "/api/info",
    .method = HTTP_GET,
    .handler = info_get_handler,
    .user_ctx = &s_ctx,
};

static const httpd_uri_t uri_config = {
    .uri = "/api/config",
    .method = HTTP_POST,
    .handler = config_post_handler,
    .user_ctx = NULL,
};

/* Public API */

esp_err_t httpd_server_start(const char *device_id, const char *ip)
{
    /* Store context for URI handlers */
    strlcpy(s_ctx.device_id, device_id != NULL ? device_id : "", sizeof(s_ctx.device_id));
    strlcpy(s_ctx.ip, ip != NULL ? ip : "", sizeof(s_ctx.ip));

    /* HTTP server */
    httpd_handle_t server = NULL;
    httpd_config_t cfg = HTTPD_DEFAULT_CONFIG();
    cfg.server_port = SA_HTTPD_PORT;

    esp_err_t err = httpd_start(&server, &cfg);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "httpd_start failed (%s)", esp_err_to_name(err));
        return err;
    }

    err = httpd_register_uri_handler(server, &uri_info);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "httpd_register_uri_handler(/api/info) failed (%s)", esp_err_to_name(err));
        httpd_stop(server);
        return err;
    }

    err = httpd_register_uri_handler(server, &uri_config);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "httpd_register_uri_handler(/api/config) failed (%s)", esp_err_to_name(err));
        httpd_stop(server);
        return err;
    }

    ESP_LOGI(TAG, "HTTP server started on port %d (device: %s)", SA_HTTPD_PORT, device_id);
    return ESP_OK;
}

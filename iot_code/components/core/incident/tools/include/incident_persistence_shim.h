#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef int nvs_handle_t;

#define NVS_READONLY 0
#define NVS_READWRITE 1
#define portMAX_DELAY 0xffffffffu
#define pdFALSE 0
#define pdTRUE 1

esp_err_t nvs_open(const char *name, int mode, nvs_handle_t *handle);
esp_err_t nvs_get_u64(nvs_handle_t handle, const char *key, uint64_t *value);
esp_err_t nvs_set_u64(nvs_handle_t handle, const char *key, uint64_t value);
esp_err_t nvs_get_blob(nvs_handle_t handle, const char *key, void *out, size_t *length);
esp_err_t nvs_set_blob(nvs_handle_t handle, const char *key, const void *value, size_t length);
esp_err_t nvs_erase_key(nvs_handle_t handle, const char *key);
esp_err_t nvs_commit(nvs_handle_t handle);
void nvs_close(nvs_handle_t handle);

int xSemaphoreTake(SemaphoreHandle_t semaphore, uint32_t timeout);
int xSemaphoreGive(SemaphoreHandle_t semaphore);
#ifdef INCIDENT_HOST_QUEUE_TEST
int xQueueSend(QueueHandle_t queue, const void *item, uint32_t timeout);
#endif
int mqtt_publish(const char *topic, const char *payload, int qos, bool retain);
esp_err_t incident_test_sign_digest(const uint8_t digest[32], uint8_t signature[65]);

#define ESP_LOGW(tag, format, ...) ((void)0)
#define ESP_LOGE(tag, format, ...) ((void)0)

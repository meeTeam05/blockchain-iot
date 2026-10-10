/**
 * @file relay.c
 * 
 * @brief Relay control component
 * 
 * Copyright (C) 2026 MinhNhat & BaoViet
 */

#include "relay.h"

#include "esp_log.h"
#include "nvs.h"
#include "sdkconfig.h"

#include "driver/gpio.h"

#include "freertos/FreeRTOS.h"

#include "buzzer.h"
#include "config.h"
#include "display_service.h"
#include "mqtt.h"

#include "cJSON.h"

#include <stdio.h>
#include <string.h>
#include <time.h>

#define RELAY_BEEP_MS_SINGLE  50
#define RELAY_BEEP_MS_ALL_OFF 100

#define RELAY_NVS_NAMESPACE "device"
#define RELAY_KEY_1         "relay_1"
#define RELAY_KEY_2         "relay_2"
#define RELAY_KEY_3         "relay_3"

static const char *TAG = "relay";

static const gpio_num_t s_pins[RELAY_CHANNEL_COUNT] = {
    (gpio_num_t)CONFIG_SA_RELAY_1_PIN,
    (gpio_num_t)CONFIG_SA_RELAY_2_PIN,
    (gpio_num_t)CONFIG_SA_RELAY_3_PIN,
};

static const char *s_keys[RELAY_CHANNEL_COUNT] = {
    RELAY_KEY_1,
    RELAY_KEY_2,
    RELAY_KEY_3,
};

static bool s_state[RELAY_CHANNEL_COUNT] = {false, false, false};
static char s_shadow_topic[96] = {0};
static portMUX_TYPE s_state_lock = portMUX_INITIALIZER_UNLOCKED;

static void relay_push_display_state(void)
{
    bool states[RELAY_CHANNEL_COUNT] = {false, false, false};
    if (relay_get_all(states) == ESP_OK) {
        display_service_set_relay_states(states);
    }
}

static esp_err_t relay_persist_state_value(int index, bool on)
{
    esp_err_t guard_err = config_nvs_write_begin();
    if (guard_err != ESP_OK) {
        return guard_err;
    }

    nvs_handle_t h;
    esp_err_t err = nvs_open(RELAY_NVS_NAMESPACE, NVS_READWRITE, &h);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "nvs_open(%s) failed: %s", RELAY_NVS_NAMESPACE, esp_err_to_name(err));
        config_nvs_write_end();
        return err;
    }

    err = nvs_set_u8(h, s_keys[index], on ? 1 : 0);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "nvs_set_u8(%s) failed: %s", s_keys[index], esp_err_to_name(err));
        nvs_close(h);
        config_nvs_write_end();
        return err;
    }

    err = nvs_commit(h);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "nvs_commit failed: %s", esp_err_to_name(err));
    }

    nvs_close(h);
    config_nvs_write_end();
    return err;
}

static esp_err_t relay_apply_gpio_state(int index, bool on)
{
    esp_err_t err = gpio_set_level(s_pins[index], on ? 1 : 0);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "gpio_set_level(channel=%d) failed: %s", index + 1, esp_err_to_name(err));
    }
    return err;
}

static esp_err_t relay_rollback_state(int index, bool prev_state)
{
    esp_err_t err = relay_apply_gpio_state(index, prev_state);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Failed to roll back relay_%d GPIO state", index + 1);
        return err;
    }

    portENTER_CRITICAL(&s_state_lock);
    s_state[index] = prev_state;
    portEXIT_CRITICAL(&s_state_lock);

    err = relay_persist_state_value(index, prev_state);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Failed to roll back relay_%d persisted state", index + 1);
    }

    return err;
}

static esp_err_t relay_publish_delta(int channel, bool on)
{
    cJSON *root = cJSON_CreateObject();
    if (root == NULL) {
        ESP_LOGE(TAG, "cJSON_CreateObject failed");
        return ESP_ERR_NO_MEM;
    }

    cJSON_AddStringToObject(root, "mode", "on");

    char relay_key[16] = {0};
    snprintf(relay_key, sizeof(relay_key), "relay_%d", channel);
    cJSON_AddBoolToObject(root, relay_key, on);
    cJSON_AddNumberToObject(root, "ts", (double)time(NULL));

    char *payload = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);
    if (payload == NULL) {
        ESP_LOGE(TAG, "cJSON_PrintUnformatted failed");
        return ESP_ERR_NO_MEM;
    }

    int msg_id = mqtt_publish(s_shadow_topic, payload, 1, false);
    cJSON_free(payload);

    if (msg_id < 0) {
        ESP_LOGW(TAG, "mqtt_publish failed; MQTT not ready yet");
        return ESP_FAIL;
    }

    return ESP_OK;
}

esp_err_t relay_init(const char *device_id)
{
    if (device_id == NULL || device_id[0] == '\0') {
        return ESP_ERR_INVALID_ARG;
    }

    gpio_config_t cfg = {
        .pin_bit_mask = (1ULL << s_pins[0]) | (1ULL << s_pins[1]) | (1ULL << s_pins[2]),
        .mode = GPIO_MODE_OUTPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };

    esp_err_t err = gpio_config(&cfg);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "gpio_config failed: %s", esp_err_to_name(err));
        return err;
    }

    nvs_handle_t h;
    err = nvs_open(RELAY_NVS_NAMESPACE, NVS_READONLY, &h);
    if (err != ESP_OK && err != ESP_ERR_NVS_NOT_FOUND) {
        ESP_LOGE(TAG, "nvs_open(%s) failed: %s", RELAY_NVS_NAMESPACE, esp_err_to_name(err));
        return err;
    }

    for (int i = 0; i < RELAY_CHANNEL_COUNT; i++) {
        uint8_t saved = 0;
        if (err == ESP_OK) {
            esp_err_t r = nvs_get_u8(h, s_keys[i], &saved);
            if (r != ESP_OK && r != ESP_ERR_NVS_NOT_FOUND) {
                nvs_close(h);
                ESP_LOGE(TAG, "nvs_get_u8(%s) failed: %s", s_keys[i], esp_err_to_name(r));
                return r;
            }
        }

        bool restored_on = (saved != 0);

        portENTER_CRITICAL(&s_state_lock);
        s_state[i] = restored_on;
        portEXIT_CRITICAL(&s_state_lock);

        esp_err_t gpio_err = relay_apply_gpio_state(i, restored_on);
        if (gpio_err != ESP_OK) {
            if (err == ESP_OK) {
                nvs_close(h);
            }
            return gpio_err;
        }
    }

    if (err == ESP_OK) {
        nvs_close(h);
    }

    snprintf(s_shadow_topic, sizeof(s_shadow_topic), "device/%s/shadow/report", device_id);
    relay_push_display_state();

    ESP_LOGI(TAG,
             "init OK (pins=%d,%d,%d state=[%s,%s,%s])",
             (int)s_pins[0],
             (int)s_pins[1],
             (int)s_pins[2],
             s_state[0] ? "on" : "off",
             s_state[1] ? "on" : "off",
             s_state[2] ? "on" : "off");

    return ESP_OK;
}

esp_err_t relay_set(int channel, bool on)
{
    if (channel < 1 || channel > RELAY_CHANNEL_COUNT) {
        return ESP_ERR_INVALID_ARG;
    }

    if (!device_mode_get()) {
        return ESP_ERR_INVALID_STATE;
    }

    int index = channel - 1;
    bool prev_state;

    portENTER_CRITICAL(&s_state_lock);
    prev_state = s_state[index];
    if (prev_state == on) {
        portEXIT_CRITICAL(&s_state_lock);
        return ESP_OK;
    }
    s_state[index] = on;
    portEXIT_CRITICAL(&s_state_lock);

    esp_err_t err = relay_apply_gpio_state(index, on);
    if (err != ESP_OK) {
        portENTER_CRITICAL(&s_state_lock);
        s_state[index] = prev_state;
        portEXIT_CRITICAL(&s_state_lock);
        return err;
    }

    err = relay_persist_state_value(index, on);
    if (err != ESP_OK) {
        esp_err_t rollback_err = relay_rollback_state(index, prev_state);
        return rollback_err != ESP_OK ? rollback_err : err;
    }

    err = relay_publish_delta(channel, on);
    if (err != ESP_OK) {
        ESP_LOGW(TAG,
                 "relay_%d state changed locally but shadow publish failed: %s",
                 channel,
                 esp_err_to_name(err));
    }

    relay_push_display_state();
    buzzer_beep_ms(RELAY_BEEP_MS_SINGLE);
    return ESP_OK;
}

esp_err_t relay_get(int channel, bool *on)
{
    if (channel < 1 || channel > RELAY_CHANNEL_COUNT || on == NULL) {
        return ESP_ERR_INVALID_ARG;
    }

    portENTER_CRITICAL(&s_state_lock);
    *on = s_state[channel - 1];
    portEXIT_CRITICAL(&s_state_lock);

    return ESP_OK;
}

esp_err_t relay_get_all(bool states[RELAY_CHANNEL_COUNT])
{
    if (states == NULL) {
        return ESP_ERR_INVALID_ARG;
    }

    portENTER_CRITICAL(&s_state_lock);
    for (int i = 0; i < RELAY_CHANNEL_COUNT; i++) {
        states[i] = s_state[i];
    }
    portEXIT_CRITICAL(&s_state_lock);

    return ESP_OK;
}

static esp_err_t relay_force_all_off_common(bool beep)
{
    bool any_changed = false;
    esp_err_t first_err = ESP_OK;

    for (int i = 0; i < RELAY_CHANNEL_COUNT; i++) {
        bool was_on;

        portENTER_CRITICAL(&s_state_lock);
        was_on = s_state[i];
        if (was_on) {
            s_state[i] = false;
        }
        portEXIT_CRITICAL(&s_state_lock);

        if (!was_on) {
            continue;
        }

        esp_err_t err = relay_apply_gpio_state(i, false);
        if (err != ESP_OK) {
            if (first_err == ESP_OK) {
                first_err = err;
            }
        }

        err = relay_persist_state_value(i, false);
        if (err != ESP_OK) {
            if (first_err == ESP_OK) {
                first_err = err;
            }
        }

        any_changed = true;
    }

    if (beep && any_changed) {
        buzzer_beep_ms(RELAY_BEEP_MS_ALL_OFF);
    }

    relay_push_display_state();
    return first_err;
}

esp_err_t relay_force_all_off(void)
{
    return relay_force_all_off_common(true);
}

esp_err_t relay_force_all_off_silent(void)
{
    return relay_force_all_off_common(false);
}

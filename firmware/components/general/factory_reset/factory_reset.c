/**
 * @file factory_reset.c
 *
 * @brief Physical factory reset button with 50 ms polling and hold-to-reset.
 *
 * State machine (runs in factory_reset_task):
 *
 *   IDLE  -> button not pressed, hold_ms == 0
 *   HOLD  -> button pressed, 0 < hold_ms < SA_FACTORY_RESET_HOLD_MS
 *             LED switches to FACTORY_RESET (red blink) after 1 s
 *   RESET -> hold_ms >= SA_FACTORY_RESET_HOLD_MS -> factory_reset_run()
 *
 * Releasing during HOLD restores the LED state that was active before hold
 * started and returns to IDLE with no side effects.
 *
 * Copyright (C) 2026 MinhNhat & BaoViet
 */

#include "factory_reset.h"

#include "config.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "led.h"
#include "mqtt.h"
#include "sensor_task.h"
#include "wifi.h"

static const char *TAG = "factory_reset";

/* Hold duration after which LED feedback begins (1 s) */
#define FEEDBACK_THRESHOLD_MS 1000

/* Polling interval */
#define POLL_MS 50

static gpio_num_t s_gpio;

/* Reset sequence */

esp_err_t factory_reset_run(void)
{
    esp_err_t err = config_factory_reset_begin();
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "config_factory_reset_begin failed (%s)", esp_err_to_name(err));
        return err;
    }

    ESP_LOGW(TAG, "Factory reset triggered; erasing provisioning data");
    ESP_LOGW(TAG, "Factory reset scope: Wi-Fi provisioning + MQTT creds/URI + mode + relay state");
    ESP_LOGW(TAG, "Blockchain signer and pending incidents are preserved for explicit lifecycle management");
    ESP_LOGW(TAG, "Gas calibration R0 is preserved in the '%s' NVS partition", SA_NVS_CALIB_PARTITION);

    /* Solid red: point of no return */
    led_set_state(LED_STATE_ERROR);

    /* Stop new telemetry/shadow work before the MQTT client is torn down. */
    sensor_task_set_enabled(false);

    /* 1. Clean WiFi shutdown */
    err = wifi_sta_deinit();
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "Continuing factory reset after wifi_sta_deinit error (%s)", esp_err_to_name(err));
    }

    /* 2. Clean MQTT shutdown (suppresses spurious reconnects during reboot) */
    mqtt_stop();

    /* 3. Erase only user provisioning/runtime-control namespaces. */
    err = config_factory_reset_erase_provisioning();
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "targeted provisioning erase failed (%s)", esp_err_to_name(err));
        config_factory_reset_end();
        return err;
    }

    /* Brief settle for peripheral shutdown while reset guard stays held. */
    vTaskDelay(pdMS_TO_TICKS(500));

    ESP_LOGI(TAG, "Rebooting into BLE provisioning mode");
    esp_restart();

    /* If restart ever returns, release the guard before reporting the error. */
    config_factory_reset_end();
    return ESP_OK;
}

#if SA_ENABLE_FACTORY_RESET

/* Polling task */

static void factory_reset_task(void *arg)
{
    uint32_t hold_ms = 0;
    bool was_holding = false;
    led_state_t saved_state = LED_STATE_ONLINE;

    while (1) {
        vTaskDelay(pdMS_TO_TICKS(POLL_MS));

        /* Active-low: GPIO low = button pressed */
        int level = gpio_get_level(s_gpio);

        if (level != 0) {
            /* Button released or not pressed */
            if (was_holding) {
                /* User cancelled; restore the previous LED state. */
                ESP_LOGI(TAG, "Hold cancelled after %lu ms", (unsigned long)hold_ms);
                led_set_state(saved_state);
            }
            hold_ms = 0;
            was_holding = false;
            continue;
        }

        /* Button is held down */
        hold_ms += POLL_MS;

        /* Start giving visible feedback after FEEDBACK_THRESHOLD_MS */
        if (hold_ms >= FEEDBACK_THRESHOLD_MS && !was_holding) {
            /* Snapshot current LED state so we can restore it on cancel */
            saved_state = led_get_state();
            was_holding = true;
            led_set_state(LED_STATE_FACTORY_RESET);
            ESP_LOGI(TAG, "Hold detected; keep holding for factory reset (%d ms total)", SA_FACTORY_RESET_HOLD_MS);
        }

        if (hold_ms >= (uint32_t)SA_FACTORY_RESET_HOLD_MS) {
            esp_err_t err = factory_reset_run();
            if (err != ESP_OK) {
                hold_ms = 0;
                was_holding = false;
                led_set_state(LED_STATE_ERROR);
                vTaskDelay(pdMS_TO_TICKS(1000));
            }
        }
    }
}
#endif /* SA_ENABLE_FACTORY_RESET */

/* Public API */

esp_err_t factory_reset_init(gpio_num_t gpio)
{
#if SA_ENABLE_FACTORY_RESET
    s_gpio = gpio;

    gpio_config_t cfg = {
        .pin_bit_mask = (1ULL << gpio),
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    esp_err_t err = gpio_config(&cfg);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "gpio_config failed (%s)", esp_err_to_name(err));
        return err;
    }

    /* Core 1, priority 4, stack 3072 B: lightweight polling task. */
    BaseType_t rc = xTaskCreatePinnedToCore(factory_reset_task, "fr_task", 3072, NULL, 4, NULL, APP_CPU_NUM);
    if (rc != pdPASS) {
        ESP_LOGE(TAG, "xTaskCreatePinnedToCore failed");
        return ESP_FAIL;
    }

    ESP_LOGI(TAG, "init OK (GPIO%d, hold=%d ms)", gpio, SA_FACTORY_RESET_HOLD_MS);
    return ESP_OK;
#else
    (void)gpio;
    return ESP_OK;
#endif
}

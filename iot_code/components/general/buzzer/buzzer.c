/**
 * @file buzzer.c
 * 
 * @brief Buzzer driver implementation.
 * 
 * Copyright (C) 2026 MinhNhat & BaoViet
 */

#include "buzzer.h"

#include "config.h"

#include <stdbool.h>

#if SA_ENABLE_BUZZER

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

#include "driver/ledc.h"

#define BUZZER_FREQ_HZ      2000
#define BUZZER_DUTY_RES     LEDC_TIMER_10_BIT
#define BUZZER_DUTY_HALF    (1U << 9)
#define BUZZER_LEDC_MODE    LEDC_LOW_SPEED_MODE
#define BUZZER_LEDC_TIMER   LEDC_TIMER_1
#define BUZZER_LEDC_CHANNEL LEDC_CHANNEL_0
#define BUZZER_QUEUE_DEPTH  8
#define BUZZER_TASK_STACK   2048
#define BUZZER_TASK_PRIO    2

static const char *TAG = "buzzer";
static bool s_initialized = false;
static StaticSemaphore_t s_buzzer_lock_buf;
static SemaphoreHandle_t s_buzzer_lock;
static portMUX_TYPE s_buzzer_lock_guard = portMUX_INITIALIZER_UNLOCKED;
static QueueHandle_t s_buzzer_queue;
static TaskHandle_t s_buzzer_task_handle;

typedef buzzer_pattern_step_t buzzer_queue_item_t;

static void buzzer_task_fn(void *arg);
static bool buzzer_prepare_queue_locked(QueueHandle_t *queue_out, size_t needed_slots);
static SemaphoreHandle_t ensure_buzzer_lock(void)
{
    if (s_buzzer_lock != NULL) {
        return s_buzzer_lock;
    }

    portENTER_CRITICAL(&s_buzzer_lock_guard);
    if (s_buzzer_lock == NULL) {
        s_buzzer_lock = xSemaphoreCreateMutexStatic(&s_buzzer_lock_buf);
    }
    portEXIT_CRITICAL(&s_buzzer_lock_guard);

    return s_buzzer_lock;
}

static esp_err_t buzzer_init_locked(void)
{
    if (s_initialized) {
        return ESP_OK;
    }

    ledc_timer_config_t timer_cfg = {
        .speed_mode = BUZZER_LEDC_MODE,
        .duty_resolution = BUZZER_DUTY_RES,
        .timer_num = BUZZER_LEDC_TIMER,
        .freq_hz = BUZZER_FREQ_HZ,
        .clk_cfg = LEDC_AUTO_CLK,
    };

    esp_err_t err = ledc_timer_config(&timer_cfg);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "ledc_timer_config failed (%s)", esp_err_to_name(err));
        return err;
    }

    ledc_channel_config_t ch_cfg = {
        .gpio_num = CONFIG_SA_BUZZER_PIN,
        .speed_mode = BUZZER_LEDC_MODE,
        .channel = BUZZER_LEDC_CHANNEL,
        .timer_sel = BUZZER_LEDC_TIMER,
        .duty = 0,
        .hpoint = 0,
    };

    err = ledc_channel_config(&ch_cfg);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "ledc_channel_config failed (%s)", esp_err_to_name(err));
        return err;
    }

    s_buzzer_queue = xQueueCreate(BUZZER_QUEUE_DEPTH, sizeof(buzzer_queue_item_t));
    if (s_buzzer_queue == NULL) {
        ESP_LOGE(TAG, "xQueueCreate failed");
        return ESP_ERR_NO_MEM;
    }

    BaseType_t task_rc = xTaskCreate(buzzer_task_fn, "buzzer_task", BUZZER_TASK_STACK, NULL, BUZZER_TASK_PRIO, &s_buzzer_task_handle);
    if (task_rc != pdPASS) {
        ESP_LOGE(TAG, "xTaskCreate failed");
        vQueueDelete(s_buzzer_queue);
        s_buzzer_queue = NULL;
        return ESP_FAIL;
    }

    s_initialized = true;
    ESP_LOGI(TAG, "init OK (GPIO%d, %d Hz)", CONFIG_SA_BUZZER_PIN, BUZZER_FREQ_HZ);
    return ESP_OK;
}

static bool buzzer_prepare_queue_locked(QueueHandle_t *queue_out, size_t needed_slots)
{
    if (!s_initialized) {
        esp_err_t init_err = buzzer_init_locked();
        if (init_err != ESP_OK) {
            ESP_LOGE(TAG, "buzzer_init failed before beep (%s)", esp_err_to_name(init_err));
            return false;
        }
    }

    QueueHandle_t queue = s_buzzer_queue;
    if (queue == NULL) {
        ESP_LOGE(TAG, "buzzer queue missing");
        return false;
    }

    if ((size_t)uxQueueSpacesAvailable(queue) < needed_slots) {
        ESP_LOGW(TAG, "buzzer queue lacks space for %lu step(s)", (unsigned long)needed_slots);
        return false;
    }

    *queue_out = queue;
    return true;
}

static esp_err_t buzzer_set_output(bool enabled)
{
    esp_err_t err = ledc_set_duty(BUZZER_LEDC_MODE, BUZZER_LEDC_CHANNEL, enabled ? BUZZER_DUTY_HALF : 0);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "ledc_set_duty(%s) failed (%s)", enabled ? "on" : "off", esp_err_to_name(err));
        return err;
    }

    err = ledc_update_duty(BUZZER_LEDC_MODE, BUZZER_LEDC_CHANNEL);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "ledc_update_duty(%s) failed (%s)", enabled ? "on" : "off", esp_err_to_name(err));
        return err;
    }

    return ESP_OK;
}

static void buzzer_task_fn(void *arg)
{
    (void)arg;

    buzzer_queue_item_t step = {0};
    while (true) {
        if (xQueueReceive(s_buzzer_queue, &step, portMAX_DELAY) != pdTRUE) {
            continue;
        }

        if (step.enabled) {
            if (buzzer_set_output(true) != ESP_OK) {
                continue;
            }
        } else {
            buzzer_set_output(false);
        }

        vTaskDelay(pdMS_TO_TICKS(step.duration_ms));

        if (step.enabled) {
            buzzer_set_output(false);
        }
    }
}

esp_err_t buzzer_init(void)
{
    SemaphoreHandle_t lock = ensure_buzzer_lock();
    if (lock == NULL) {
        return ESP_ERR_NO_MEM;
    }

    if (xSemaphoreTake(lock, portMAX_DELAY) != pdTRUE) {
        return ESP_FAIL;
    }

    esp_err_t err = buzzer_init_locked();
    xSemaphoreGive(lock);
    return err;
}

void buzzer_beep_ms(uint32_t duration_ms)
{
    if (duration_ms == 0) {
        return;
    }

    const buzzer_pattern_step_t step = {
        .enabled = true,
        .duration_ms = duration_ms,
    };
    buzzer_beep_pattern(&step, 1);
}

void buzzer_beep_pattern(const buzzer_pattern_step_t *steps, size_t count)
{
    if (steps == NULL || count == 0) {
        return;
    }

    for (size_t i = 0; i < count; i++) {
        if (steps[i].duration_ms == 0) {
            ESP_LOGW(TAG, "buzzer pattern step %lu has zero duration", (unsigned long)i);
            return;
        }
    }

    SemaphoreHandle_t lock = ensure_buzzer_lock();
    if (lock == NULL) {
        ESP_LOGE(TAG, "buzzer lock init failed");
        return;
    }

    if (xSemaphoreTake(lock, portMAX_DELAY) != pdTRUE) {
        ESP_LOGE(TAG, "buzzer lock take failed");
        return;
    }

    QueueHandle_t queue = NULL;
    if (!buzzer_prepare_queue_locked(&queue, count)) {
        xSemaphoreGive(lock);
        return;
    }

    for (size_t i = 0; i < count; i++) {
        buzzer_queue_item_t step = steps[i];
        if (xQueueSend(queue, &step, 0) != pdTRUE) {
            ESP_LOGW(TAG, "buzzer queue full - dropped pattern at step %lu", (unsigned long)i);
            break;
        }
    }

    xSemaphoreGive(lock);
}

#else

esp_err_t buzzer_init(void)
{
    return ESP_OK;
}

void buzzer_beep_ms(uint32_t duration_ms)
{
    (void)duration_ms;
}

void buzzer_beep_pattern(const buzzer_pattern_step_t *steps, size_t count)
{
    (void)steps;
    (void)count;
}

#endif

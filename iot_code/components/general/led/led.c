/**
 * @file led.c
 *
 * @brief WS2812 RGB LED driver with raw RMT byte encoding and a 500 ms blink timer.
 *
 * Uses only the built-in esp_driver_rmt component (no external dependencies).
 *
 * Timing at 10 MHz RMT clock (1 tick = 100 ns):
 *   bit0 - HIGH 400 ns (4 ticks), LOW 850 ns (9 ticks)
 *   bit1 - HIGH 800 ns (8 ticks), LOW 450 ns (5 ticks)
 *   reset - line idles LOW for 500 ms between writes (>> 50 us required)
 *
 * Copyright (C) 2026 MinhNhat & BaoViet
 */

#include "led.h"

#include "config.h"
#include "driver/rmt_encoder.h"
#include "driver/rmt_tx.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

/* Color table, driver state, and helpers. */

#if SA_ENABLE_LED

static const char *TAG = "led";

typedef struct {
    uint8_t r, g, b;
    bool blink;
} led_color_t;

static const led_color_t s_color_table[] = {
    [LED_STATE_BOOT] = {80, 80, 80, true},         /* white  blink  */
    [LED_STATE_BLE] = {0, 0, 180, true},           /* blue   blink  */
    [LED_STATE_WIFI] = {200, 180, 0, true},        /* yellow blink  */
    [LED_STATE_ONLINE] = {0, 180, 0, false},       /* green  static */
    [LED_STATE_OTA] = {120, 0, 120, true},         /* purple blink  */
    [LED_STATE_ERROR] = {180, 0, 0, false},        /* red    static - fatal */
    [LED_STATE_FACTORY_RESET] = {180, 0, 0, true}, /* red    blink  - cancellable */
    [LED_STATE_OFF] = {0, 0, 0, false},
};

static rmt_channel_handle_t s_chan = NULL;
static rmt_encoder_handle_t s_encoder = NULL;
static esp_timer_handle_t s_timer = NULL;
static TaskHandle_t s_led_task = NULL;

static portMUX_TYPE s_spinlock = portMUX_INITIALIZER_UNLOCKED;
static volatile led_state_t s_state = LED_STATE_OFF;
static volatile bool s_led_on = false;

static void request_led_refresh(void)
{
    if (s_led_task == NULL) {
        return;
    }

    if (xPortInIsrContext()) {
        BaseType_t higher_priority_task_woken = pdFALSE;
        vTaskNotifyGiveFromISR(s_led_task, &higher_priority_task_woken);
        portYIELD_FROM_ISR(higher_priority_task_woken);
        return;
    }

    xTaskNotifyGive(s_led_task);
}

static void write_color(uint8_t r, uint8_t g, uint8_t b)
{
    /* WS2812 requires GRB byte order */
    uint8_t grb[3] = {g, r, b};
    rmt_transmit_config_t tx_cfg = {.loop_count = 0};
    rmt_transmit(s_chan, s_encoder, grb, sizeof(grb), &tx_cfg);
    /* portMAX_DELAY: wait until TX-done ISR fires (~31 µs). Never times out. */
    rmt_tx_wait_all_done(s_chan, portMAX_DELAY);
}

static void led_task(void *arg)
{
    (void)arg;

    while (true) {
        ulTaskNotifyTake(pdTRUE, portMAX_DELAY);

        led_state_t state;
        bool on;

        portENTER_CRITICAL(&s_spinlock);
        state = s_state;
        on = s_led_on;
        portEXIT_CRITICAL(&s_spinlock);

        if (on) {
            write_color(s_color_table[state].r, s_color_table[state].g, s_color_table[state].b);
        } else {
            write_color(0, 0, 0);
        }
    }
}

static void blink_timer_cb(void *arg)
{
    (void)arg;

    led_state_t state;

    portENTER_CRITICAL(&s_spinlock);
    state = s_state;
    if (s_color_table[state].blink) {
        s_led_on = !s_led_on;
    } else {
        s_led_on = true;
    }
    portEXIT_CRITICAL(&s_spinlock);

    request_led_refresh();
}

static void cleanup_init_failure(void)
{
    if (s_led_task != NULL) {
        vTaskDelete(s_led_task);
        s_led_task = NULL;
    }

    if (s_timer != NULL) {
        esp_timer_delete(s_timer);
        s_timer = NULL;
    }

    if (s_encoder != NULL) {
        rmt_del_encoder(s_encoder);
        s_encoder = NULL;
    }

    if (s_chan != NULL) {
        esp_err_t err = rmt_disable(s_chan);
        if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {
            ESP_LOGW(TAG, "rmt_disable during cleanup failed (%s)", esp_err_to_name(err));
        }
        rmt_del_channel(s_chan);
        s_chan = NULL;
    }
}

#endif /* SA_ENABLE_LED */

/* Public API */

esp_err_t led_init(void)
{
#if SA_ENABLE_LED
    /* RMT TX channel - 10 MHz clock gives 100 ns per tick. */
    rmt_tx_channel_config_t chan_cfg = {
        .gpio_num = SA_LED_PIN,
        .clk_src = RMT_CLK_SRC_DEFAULT,
        .resolution_hz = 10 * 1000 * 1000,
        .mem_block_symbols = 64,
        .trans_queue_depth = 4,
    };
    esp_err_t err = rmt_new_tx_channel(&chan_cfg, &s_chan);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "rmt_new_tx_channel failed (%s)", esp_err_to_name(err));
        return err;
    }

    /* WS2812B NRZ bit timing (10 MHz = 100 ns/tick):
     *   bit0 - HIGH 400 ns (4 ticks), LOW 850 ns (9 ticks)  [spec: 0.4/0.85 us]
     *   bit1 - HIGH 800 ns (8 ticks), LOW 450 ns (5 ticks)  [spec: 0.8/0.45 us] */
    rmt_bytes_encoder_config_t enc_cfg = {
        .bit0 = {.duration0 = 4, .level0 = 1, .duration1 = 9, .level1 = 0},
        .bit1 = {.duration0 = 8, .level0 = 1, .duration1 = 5, .level1 = 0},
        .flags = {.msb_first = 1},
    };
    err = rmt_new_bytes_encoder(&enc_cfg, &s_encoder);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "rmt_new_bytes_encoder failed (%s)", esp_err_to_name(err));
        cleanup_init_failure();
        return err;
    }

    err = rmt_enable(s_chan);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "rmt_enable failed (%s)", esp_err_to_name(err));
        cleanup_init_failure();
        return err;
    }

    /* Blank the LED before starting the timer */
    write_color(0, 0, 0);

    /* 500 ms periodic timer drives blink states */
    esp_timer_create_args_t timer_args = {
        .callback = blink_timer_cb,
        .arg = NULL,
        .name = "led_blink",
        .dispatch_method = ESP_TIMER_TASK,
    };
    err = esp_timer_create(&timer_args, &s_timer);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "esp_timer_create failed (%s)", esp_err_to_name(err));
        cleanup_init_failure();
        return err;
    }

    BaseType_t rc = xTaskCreatePinnedToCore(led_task, "led_task", 2048, NULL, 4, &s_led_task, APP_CPU_NUM);
    if (rc != pdPASS) {
        ESP_LOGE(TAG, "xTaskCreatePinnedToCore failed");
        cleanup_init_failure();
        return ESP_ERR_NO_MEM;
    }

    err = esp_timer_start_periodic(s_timer, 500 * 1000ULL); /* µs */
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "esp_timer_start_periodic failed (%s)", esp_err_to_name(err));
        cleanup_init_failure();
        return err;
    }

    ESP_LOGI(TAG, "init OK (GPIO%d)", SA_LED_PIN);
    return ESP_OK;
#else
    return ESP_OK;
#endif
}

void led_set_state(led_state_t state)
{
#if SA_ENABLE_LED
    portENTER_CRITICAL(&s_spinlock);
    s_state = state;
    s_led_on = true; /* start each new state with LED on */
    portEXIT_CRITICAL(&s_spinlock);
    request_led_refresh();
#else
    (void)state;
#endif
}

led_state_t led_get_state(void)
{
#if SA_ENABLE_LED
    portENTER_CRITICAL(&s_spinlock);
    led_state_t state = s_state;
    portEXIT_CRITICAL(&s_spinlock);
    return state;
#else
    return LED_STATE_OFF;
#endif
}

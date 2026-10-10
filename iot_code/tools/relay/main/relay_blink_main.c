#include "driver/gpio.h"
#include "esp_err.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "relay_tool";

static const gpio_num_t s_relay_pins[] = {
    GPIO_NUM_17,
    GPIO_NUM_18,
    GPIO_NUM_8,
};

static void configure_relays(void)
{
    gpio_config_t cfg = {
        .pin_bit_mask = 0,
        .mode = GPIO_MODE_OUTPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };

    for (size_t i = 0; i < sizeof(s_relay_pins) / sizeof(s_relay_pins[0]); ++i) {
        cfg.pin_bit_mask |= (1ULL << s_relay_pins[i]);
    }

    ESP_ERROR_CHECK(gpio_config(&cfg));

    for (size_t i = 0; i < sizeof(s_relay_pins) / sizeof(s_relay_pins[0]); ++i) {
        ESP_ERROR_CHECK(gpio_set_level(s_relay_pins[i], 0));
    }
}

void app_main(void)
{
    bool on = false;

    configure_relays();

    while (1) {
        on = !on;

        for (size_t i = 0; i < sizeof(s_relay_pins) / sizeof(s_relay_pins[0]); ++i) {
            ESP_ERROR_CHECK(gpio_set_level(s_relay_pins[i], on ? 1 : 0));
        }

        ESP_LOGI(TAG, "GPIO17/GPIO18/GPIO8 -> %s", on ? "HIGH" : "LOW");
        vTaskDelay(pdMS_TO_TICKS(1000));
    }
}

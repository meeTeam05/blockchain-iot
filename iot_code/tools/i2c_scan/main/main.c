/**
 * @file main.c
 * @brief I2C bus scanner that probes all 7-bit addresses and logs responders.
 *
 * Build & flash:
 *   cd iot_code/tools/i2c_scan
 *   idf.py build flash monitor
 */

#include "driver/i2c_master.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#define SDA_PIN  GPIO_NUM_12
#define SCL_PIN  GPIO_NUM_13
#define PROBE_MS 20 /* timeout per address probe */

static const char *TAG = "I2C_SCAN";

void app_main(void)
{
    i2c_master_bus_config_t bus_cfg = {
        .i2c_port = I2C_NUM_0,
        .sda_io_num = SDA_PIN,
        .scl_io_num = SCL_PIN,
        .clk_source = I2C_CLK_SRC_DEFAULT,
        .glitch_ignore_cnt = 7,
        .flags.enable_internal_pullup = true,
    };

    i2c_master_bus_handle_t bus;
    ESP_ERROR_CHECK(i2c_new_master_bus(&bus_cfg, &bus));

    ESP_LOGI(TAG, "Scanning I2C bus; SDA: GPIO%d  SCL: GPIO%d", SDA_PIN, SCL_PIN);

    /* Release any stuck SDA before probing */
    i2c_master_bus_reset(bus);

    ESP_LOGI(TAG, "     0  1  2  3  4  5  6  7  8  9  A  B  C  D  E  F");

    int found = 0;

    for (uint8_t row = 0; row < 8; row++) {
        char line[64];
        int pos = 0;
        pos += snprintf(line + pos, sizeof(line) - pos, "%02X: ", row << 4);

        for (uint8_t col = 0; col < 16; col++) {
            uint8_t addr = (row << 4) | col;

            /* Skip reserved ranges: 0x00-0x07 and 0x78-0x7F */
            if (addr < 0x08 || addr > 0x77) {
                pos += snprintf(line + pos, sizeof(line) - pos, "   ");
                continue;
            }

            if (i2c_master_probe(bus, addr, PROBE_MS) == ESP_OK) {
                pos += snprintf(line + pos, sizeof(line) - pos, "%02X ", addr);
                found++;
            } else {
                pos += snprintf(line + pos, sizeof(line) - pos, "-- ");
            }
        }
        ESP_LOGI(TAG, "%s", line);
    }

    if (found == 0) {
        ESP_LOGW(TAG, "No devices found; check wiring and pull-ups");
    } else {
        ESP_LOGI(TAG, "Scan complete: %d device(s) found", found);
    }

    i2c_del_master_bus(bus);

    /* Loop so monitor stays open */
    while (1) {
        vTaskDelay(pdMS_TO_TICKS(5000));
    }
}

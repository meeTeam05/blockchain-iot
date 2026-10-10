/**
 * @file ili9225.c
 *
 * @brief Raw SPI ILI9225 panel driver for the smart-air firmware.
 *
 * Copyright (C) 2026 MinhNhat & BaoViet
 */

#include "ili9225.h"

#include "driver/gpio.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "ili9225";

static spi_device_handle_t s_spi = NULL;
static int s_pin_dc = -1;
static int s_pin_rst = -1;
static int s_pin_cs = -1;
static uint8_t s_invalid_area_logs = 0;

static inline void dc_cmd(void)
{
    gpio_set_level(s_pin_dc, 0);
}

static inline void dc_data(void)
{
    gpio_set_level(s_pin_dc, 1);
}

static inline void cs_low(void)
{
    gpio_set_level(s_pin_cs, 0);
}

static inline void cs_high(void)
{
    gpio_set_level(s_pin_cs, 1);
}

static esp_err_t spi_tx(const uint8_t *buf, size_t len)
{
    if (buf == NULL || len == 0) {
        return ESP_ERR_INVALID_ARG;
    }

    spi_transaction_t t = {
        .length = len * 8,
        .tx_buffer = buf,
    };

    return spi_device_polling_transmit(s_spi, &t);
}

static esp_err_t wr_reg(uint8_t reg, uint16_t val)
{
    uint8_t cmd[2] = {0x00, reg};
    uint8_t data[2] = {(uint8_t)(val >> 8), (uint8_t)(val & 0xFF)};

    cs_low();
    dc_cmd();
    esp_err_t err = spi_tx(cmd, sizeof(cmd));
    if (err == ESP_OK) {
        dc_data();
        err = spi_tx(data, sizeof(data));
    }
    cs_high();

    return err;
}

static void hw_reset(void)
{
    gpio_set_level(s_pin_rst, 1);
    vTaskDelay(pdMS_TO_TICKS(1));
    gpio_set_level(s_pin_rst, 0);
    vTaskDelay(pdMS_TO_TICKS(10));
    gpio_set_level(s_pin_rst, 1);
    vTaskDelay(pdMS_TO_TICKS(50));
}

static esp_err_t panel_init_seq(void)
{
    esp_err_t err = ESP_OK;

    err |= wr_reg(0x10, 0x0000);
    err |= wr_reg(0x11, 0x0000);
    err |= wr_reg(0x12, 0x0000);
    err |= wr_reg(0x13, 0x0000);
    err |= wr_reg(0x14, 0x0000);
    vTaskDelay(pdMS_TO_TICKS(40));

    err |= wr_reg(0x11, 0x0018);
    err |= wr_reg(0x12, 0x6121);
    err |= wr_reg(0x13, 0x006F);
    err |= wr_reg(0x14, 0x495F);
    err |= wr_reg(0x10, 0x0800);
    vTaskDelay(pdMS_TO_TICKS(10));
    err |= wr_reg(0x11, 0x103B);
    vTaskDelay(pdMS_TO_TICKS(50));

    err |= wr_reg(0x01, 0x011C);
    err |= wr_reg(0x02, 0x0100);
    err |= wr_reg(0x03, 0x1030);
    err |= wr_reg(0x07, 0x0000);
    err |= wr_reg(0x08, 0x0808);
    err |= wr_reg(0x0B, 0x1100);
    err |= wr_reg(0x0C, 0x0000);
    err |= wr_reg(0x0F, 0x0D01);
    err |= wr_reg(0x15, 0x0020);

    err |= wr_reg(0x20, 0x0000);
    err |= wr_reg(0x21, 0x0000);

    err |= wr_reg(0x50, 0x0000);
    err |= wr_reg(0x51, 0x060A);
    err |= wr_reg(0x52, 0x0D0A);
    err |= wr_reg(0x53, 0x0303);
    err |= wr_reg(0x54, 0x0A0D);
    err |= wr_reg(0x55, 0x0A06);
    err |= wr_reg(0x56, 0x0000);
    err |= wr_reg(0x57, 0x0303);
    err |= wr_reg(0x58, 0x0000);
    err |= wr_reg(0x59, 0x0000);

    err |= wr_reg(0x36, 0x00AF);
    err |= wr_reg(0x37, 0x0000);
    err |= wr_reg(0x38, 0x00DB);
    err |= wr_reg(0x39, 0x0000);

    vTaskDelay(pdMS_TO_TICKS(50));
    err |= wr_reg(0x07, 0x1017);

    return err;
}

esp_err_t ili9225_init(const ili9225_cfg_t *cfg)
{
    if (cfg == NULL) {
        return ESP_ERR_INVALID_ARG;
    }

    if (s_spi != NULL) {
        return ESP_OK;
    }

    s_pin_dc = cfg->pin_dc;
    s_pin_rst = cfg->pin_rst;
    s_pin_cs = cfg->pin_cs;

    gpio_config_t io = {
        .pin_bit_mask = (1ULL << cfg->pin_dc) |
                        (1ULL << cfg->pin_rst) |
                        (1ULL << cfg->pin_cs),
        .mode = GPIO_MODE_OUTPUT,
    };

    esp_err_t err = gpio_config(&io);
    if (err != ESP_OK) {
        return err;
    }
    gpio_set_level(cfg->pin_cs, 1);

    spi_bus_config_t bus = {
        .mosi_io_num = cfg->pin_mosi,
        .miso_io_num = -1,
        .sclk_io_num = cfg->pin_clk,
        .quadwp_io_num = -1,
        .quadhd_io_num = -1,
        .max_transfer_sz = ILI9225_PHYS_W * ILI9225_PHYS_H * 2 + 16,
    };

    err = spi_bus_initialize(cfg->host, &bus, SPI_DMA_CH_AUTO);
    if (err != ESP_OK) {
        return err;
    }

    spi_device_interface_config_t dev = {
        .clock_speed_hz = cfg->clock_speed_hz,
        .mode = 0,
        .spics_io_num = -1,
        .queue_size = 4,
    };

    err = spi_bus_add_device(cfg->host, &dev, &s_spi);
    if (err != ESP_OK) {
        return err;
    }

    hw_reset();
    err = panel_init_seq();
    if (err != ESP_OK) {
        return err;
    }

    ESP_LOGI(TAG, "init OK (176x220 portrait, SPI %d Hz)", cfg->clock_speed_hz);
    return ESP_OK;
}

esp_err_t ili9225_write_area(uint16_t x1,
                             uint16_t y1,
                             uint16_t x2,
                             uint16_t y2,
                             const uint8_t *pixel_bytes,
                             size_t len)
{
    if (s_spi == NULL || pixel_bytes == NULL || len == 0) {
        return ESP_ERR_INVALID_STATE;
    }
    if (x1 > x2 || y1 > y2 || x2 >= ILI9225_PHYS_W || y2 >= ILI9225_PHYS_H) {
        if (s_invalid_area_logs < 8) {
            ESP_LOGW(TAG,
                     "reject area x1=%u y1=%u x2=%u y2=%u (phys %ux%u)",
                     x1,
                     y1,
                     x2,
                     y2,
                     ILI9225_PHYS_W,
                     ILI9225_PHYS_H);
            s_invalid_area_logs++;
        }
        return ESP_ERR_INVALID_ARG;
    }

    size_t expected_len = (size_t)(x2 - x1 + 1U) * (size_t)(y2 - y1 + 1U) * 2U;
    if (len != expected_len) {
        if (s_invalid_area_logs < 8) {
            ESP_LOGW(TAG,
                     "reject len=%u expected=%u for area x1=%u y1=%u x2=%u y2=%u",
                     (unsigned)len,
                     (unsigned)expected_len,
                     x1,
                     y1,
                     x2,
                     y2);
            s_invalid_area_logs++;
        }
        return ESP_ERR_INVALID_SIZE;
    }

    esp_err_t err = ESP_OK;
    err |= wr_reg(0x36, x2);
    err |= wr_reg(0x37, x1);
    err |= wr_reg(0x38, y2);
    err |= wr_reg(0x39, y1);
    err |= wr_reg(0x20, x1);
    err |= wr_reg(0x21, y1);
    if (err != ESP_OK) {
        return err;
    }

    const uint8_t cmd[2] = {0x00, 0x22};
    cs_low();
    dc_cmd();
    err = spi_tx(cmd, sizeof(cmd));
    if (err == ESP_OK) {
        dc_data();
        err = spi_tx(pixel_bytes, len);
    }
    cs_high();

    return err;
}

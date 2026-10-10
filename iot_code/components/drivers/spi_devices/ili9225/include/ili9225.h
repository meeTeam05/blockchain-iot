/**
 * @file ili9225.h
 *
 * @brief Raw SPI ILI9225 panel driver for the smart-air firmware.
 *
 * Copyright (C) 2026 MinhNhat & BaoViet
 */

#pragma once

#include "driver/spi_master.h"
#include "esp_err.h"

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define ILI9225_PHYS_W 176
#define ILI9225_PHYS_H 220

typedef struct {
    spi_host_device_t host;
    int pin_clk;
    int pin_mosi;
    int pin_dc;
    int pin_rst;
    int pin_cs;
    int clock_speed_hz;
} ili9225_cfg_t;

/**
 * @brief Initialize the panel, SPI bus/device, and power-on sequence.
 *
 * Safe to call once during boot. Repeated successful calls are no-ops.
 */
esp_err_t ili9225_init(const ili9225_cfg_t *cfg);

/**
 * @brief Write one inclusive rectangular RGB565 region to GRAM.
 *
 * @param x1          Start X coordinate in chip-native portrait space.
 * @param y1          Start Y coordinate in chip-native portrait space.
 * @param x2          End X coordinate in chip-native portrait space.
 * @param y2          End Y coordinate in chip-native portrait space.
 * @param pixel_bytes RGB565 bytes in the exact on-wire order expected by the panel.
 * @param len         Byte length of pixel_bytes. Must equal area pixel count * 2.
 */
esp_err_t ili9225_write_area(uint16_t x1,
                             uint16_t y1,
                             uint16_t x2,
                             uint16_t y2,
                             const uint8_t *pixel_bytes,
                             size_t len);

#ifdef __cplusplus
}
#endif

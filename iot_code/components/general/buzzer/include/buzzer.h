/**
 * @file buzzer.h
 * 
 * @brief Buzzer driver header.
 * 
 * Copyright (C) 2026 MinhNhat & BaoViet
 */

#pragma once

#include "esp_err.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef struct {
    bool enabled;
    uint32_t duration_ms;
} buzzer_pattern_step_t;

/**
 * @brief Initialize the buzzer.
 * 
 * @return ESP_OK on success, or an error code.
 */
esp_err_t buzzer_init(void);

/**
 * @brief Beep the buzzer for a specified duration.
 * 
 * @param duration_ms Duration of the beep in milliseconds.
 * 
 * @note This function is non-blocking and returns immediately.
 */
void buzzer_beep_ms(uint32_t duration_ms);

/**
 * @brief Play a buzzer pattern made of timed ON/OFF steps.
 *
 * @param steps  Pattern steps to enqueue.
 * @param count  Number of steps in @p steps.
 *
 * @note This function is non-blocking and returns immediately.
 */
void buzzer_beep_pattern(const buzzer_pattern_step_t *steps, size_t count);

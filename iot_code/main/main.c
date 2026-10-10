/**
 * @file main.c
 * 
 * @brief Main application entry point.
 * 
 * Copyright (C) 2026 MinhNhat & BaoViet
 */

#include "esp_log.h"

#include "sysload.h"

static const char *TAG = "main";

void app_main(void)
{
    ESP_LOGI(TAG, "System startup");
    sysload_init();
}

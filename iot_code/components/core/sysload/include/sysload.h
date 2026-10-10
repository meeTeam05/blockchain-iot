/**
 * @file sysload.h
 *
 * @brief System boot orchestration entrypoint.
 *
 * Copyright (C) 2026 MinhNhat & BaoViet
 */

#pragma once

#include "config.h"

/**
 * @brief Initialise core firmware services and launch runtime tasks.
 *
 * Boot sequence includes storage, networking, peripherals, provisioning,
 * MQTT/OTA startup, and sensor task creation.
 */
void sysload_init(void);

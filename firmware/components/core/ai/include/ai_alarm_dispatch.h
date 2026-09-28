#pragma once

#include "incident.h"

#include <stdint.h>

/** Queue the local alarm first, then submit lower-priority incident work. */
void ai_alarm_dispatch(uint8_t previous_level, uint8_t new_level,
                       const incident_snapshot_t *snapshot);

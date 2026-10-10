#include "ai_alarm_dispatch.h"

#include "buzzer.h"

/* Early warning: three long beeps. Limit exceeded: four very long beeps.
 * Both fit the buzzer queue depth (8 steps) and differ from relay/device-mode
 * confirmation beeps. */
static const buzzer_pattern_step_t k_early_pattern[] = {
    {.enabled = true, .duration_ms = 400},
    {.enabled = false, .duration_ms = 120},
    {.enabled = true, .duration_ms = 400},
    {.enabled = false, .duration_ms = 120},
    {.enabled = true, .duration_ms = 400},
};
static const buzzer_pattern_step_t k_exceeded_pattern[] = {
    {.enabled = true, .duration_ms = 800},
    {.enabled = false, .duration_ms = 150},
    {.enabled = true, .duration_ms = 800},
    {.enabled = false, .duration_ms = 150},
    {.enabled = true, .duration_ms = 800},
    {.enabled = false, .duration_ms = 150},
    {.enabled = true, .duration_ms = 800},
};

void ai_alarm_dispatch(uint8_t previous_level, uint8_t new_level,
                       const incident_snapshot_t *snapshot)
{
    if (snapshot == NULL || new_level <= previous_level) return;
    if (new_level == 2) {
        buzzer_beep_pattern(k_exceeded_pattern,
                            sizeof(k_exceeded_pattern) / sizeof(k_exceeded_pattern[0]));
    } else {
        buzzer_beep_pattern(k_early_pattern,
                            sizeof(k_early_pattern) / sizeof(k_early_pattern[0]));
    }
    /* incident_on... is non-blocking and cannot roll back the local alarm. */
    incident_on_gas_ews_transition(previous_level, new_level, snapshot);
}

#pragma once

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/** Start the test-only, non-echoing UART signer provisioning command task. */
esp_err_t incident_signer_provision_bench_start(void);

#ifdef __cplusplus
}
#endif

# Task 1 Replay Incident Audit

## Verdict

**REPLAY CAN TEST INCIDENT PATH WITH CONDITIONS.**

The replay input takes the same production Gas EWS, alarm-dispatch, Blockchain Incident v2, NVS, MQTT, retry, and ACK path after the input boundary. It is not a test-only incident shortcut. Replay deliberately replaces only the live call to `ai_feed_sample()` with an embedded sample decoded by `replay_sample()` and passed directly to `gas_ews_feed()`.

The currently checked-in active `firmware/sdkconfig` is **not sufficient for a signed replay incident**: replay is enabled at 60x with scenario 0, but `CONFIG_SA_INCIDENT_VERIFYING_CONTRACT` is empty and `CONFIG_NVS_ENCRYPTION` is off. With that configuration, the worker logs `incident skipped: no encrypted provisioned signer` and stops before sequence allocation, persistence, and MQTT publication. By contrast, `firmware/sdkconfig.incident.generated` enables NVS encryption and supplies a verifying contract, but has replay disabled. A full board replay needs the required settings combined and an actual signer provisioned.

Main-question answer: **CONDITIONAL**. An eligible replay-generated `SAFE -> EARLY_WARNING`, `SAFE -> EXCEEDED`, or `EARLY_WARNING -> EXCEEDED` transition creates and signs a Schema-v2 record only when all conditions below hold.

## Replay configuration

| Menu option | Exact symbol | Current `firmware/sdkconfig` |
|---|---|---|
| On-device AI | `CONFIG_SA_ENABLE_AI` | `y` |
| Blockchain Incident Schema v2 queue | `CONFIG_SA_ENABLE_BLOCKCHAIN_INCIDENT` | `y` |
| Persistent incident queue capacity | `CONFIG_SA_INCIDENT_QUEUE_CAPACITY` | `4` |
| EIP-712 verifying contract | `CONFIG_SA_INCIDENT_VERIFYING_CONTRACT` | empty (blocking) |
| AI enabled at boot | `CONFIG_SA_AI_ENABLED_AT_BOOT` | `y` |
| Replay simulated sensor data | `CONFIG_SA_AI_REPLAY` | `y` |
| Replay speed | `CONFIG_SA_AI_REPLAY_SPEED` | `60` |
| Replay scenario | `CONFIG_SA_AI_REPLAY_SCENARIO` | `0` (`co_event`) |

The encrypted signer also requires ESP-IDF's `CONFIG_NVS_ENCRYPTION=y`; it is not a Smart Air menu symbol. The active `firmware/sdkconfig` currently has it disabled.

## Replay call chain

Exact production path for each finalized 10-second Gas EWS step:

```text
sysload_init()                                      sysload.c
  -> incident_init(resolved_id)                    incident.c
  -> mqtt_register_incident_ack_cb(incident_handle_ack)
  -> mqtt_start(...)
  -> sensor_task_start(...)                        telemetry remains live
  -> ai_start(resolved_id)                         ai.c
       -> gas_ews_model_init()                     gas_ews_model.cpp
       -> ai_task()
       -> ai_replay_task()                         only when CONFIG_SA_AI_REPLAY=y
            -> replay_sample()                     ai_replay_data.h values, 5 s simulated clock
            -> gas_ews_feed()                      gas_ews.c
                 -> finalize_current_step()
                 -> process_step()
                      -> STEL/TWA/projection and rule state
                      -> update_level()
            -> xTaskNotifyGive(ai_task)
                 -> ai_handle_step()
                      -> run_model_on_new_step()
                           -> gas_ews_get_window()
                           -> gas_ews_model_infer()
                           -> gas_ews_set_model_result()
                                -> update_level()
                      -> incident_snapshot_from_status()
                      -> ai_alarm_dispatch()       ai_alarm_dispatch.c
                           -> buzzer_beep_pattern()
                           -> incident_on_gas_ews_transition()
                                -> prepare_incident_work()
                                -> xQueueSend(incident worker)
                                     -> incident_task()
                                          -> process_work()
                                               -> prepare_incident_work() again
                                               -> signer_available()
                                               -> next_sequence() + NVS commit
                                               -> hash_incident_id()
                                               -> hash_evidence()
                                               -> hash_digest() (EIP-712)
                                               -> sign_digest()
                                                    -> sign_digest_with_private_key() (secp256k1)
                                               -> make_payload()
                                               -> save_record() + NVS commit
                                               -> mqtt_publish(topic, stored payload, QoS 1, retain=false)
                                          -> incident_retry_pending()
```

The receive path is also the normal production path:

```text
MQTT_EVENT_DATA on device/{id}/incident/ack
  -> mqtt_dispatch_incident_ack()
  -> incident_handle_ack()
  -> exact incident_id + evidence_hash match
  -> erase_record() + NVS commit
```

When replay is enabled, `sensor_task` still reads and publishes real telemetry, but `ai_feed_sample()` explicitly discards that live AI sample. No Task 1 stage after `gas_ews_feed()` is bypassed.

## Conditions required

- `CONFIG_SA_ENABLE_AI=y`, `CONFIG_SA_AI_REPLAY=y`, and `CONFIG_SA_ENABLE_BLOCKCHAIN_INCIDENT=y`.
- AI runtime state must be on when the step is processed: `CONFIG_SA_AI_ENABLED_AT_BOOT=y`, or an `ai_set` command must enable it before the event. Replay still advances while AI is off, but `ai_task()` skips `ai_handle_step()`, so missed transitions are not replayed later.
- `ai_start()` and `incident_init()` must succeed; the resolved device ID must be valid and their tasks/queues must be created.
- For the golden model-dependent timing, `gas_ews_model_init()` and its self-test must succeed. QCVN and projection transitions can still occur without the model.
- The transition must be one of `0->1`, `0->2`, or `1->2`; the snapshot must not be in warm-up, its `overall_level` must equal the new level, and the triggering gas must have its raw-valid bit set at that step.
- A valid incident clock provenance must already be set: `INCIDENT_TIME_SNTP` after successful SNTP, or `INCIDENT_TIME_DS3231` after a valid RTC read/update. Merely seeding the system clock from build time does not qualify.
- The incident worker queue must accept the candidate and the persistent NVS queue must have a free slot.
- `CONFIG_NVS_ENCRYPTION=y` and a valid 32-byte signer private key must have been provisioned in encrypted NVS.
- `CONFIG_SA_INCIDENT_VERIFYING_CONTRACT` must be a valid 42-character `0x` Ethereum address so EIP-712 domain construction succeeds.
- Sequence and record NVS writes/commits, hashing, payload creation, and secp256k1 signing must succeed.
- MQTT connectivity is required for immediate broker delivery, but not for creation/signing/persistence.
- An audible local alert additionally requires the buzzer feature, initialized hardware, and queue capacity. Incident dispatch itself follows the buzzer call even if the buzzer implementation is disabled/no-op.

## Incident behavior

- **Transition:** only an upward change of the overall maximum CO/NO2 level invokes `ai_alarm_dispatch()`. Same-level heartbeats and decreases do not create incidents.
- **Local alert:** the buzzer pattern is submitted first. Early warning uses three 400 ms tones; exceeded uses four 800 ms tones. Incident failure cannot roll it back.
- **Time gate:** `incident_on_gas_ews_transition()` silently drops the incident when `time(NULL) <= 0` or no approved time source has been recorded. Therefore replay can sound the buzzer while producing no incident if valid SNTP/DS3231 provenance is unavailable.
- **Candidate gate:** `prepare_incident_work()` canonicalizes validity masks and verifies transition, warm-up, time, overall level, and raw validity of the gas that caused the level.
- **Signer absent:** the candidate reaches `process_work()`, logs `incident skipped: no encrypted provisioned signer`, and returns **before** allocating a sequence. There is no record, no MQTT publication, and the local buzzer remains unaffected.
- **Sequence/hash/sign:** with a signer, the sequence is incremented and committed before `incidentId`, evidence hash, EIP-712 digest, and secp256k1 signature are generated. A later signing failure deliberately retains the consumed sequence without reuse.
- **Persistence:** `make_payload()` creates the complete Schema-v2 JSON. `save_record()` stores that exact payload plus incident ID, evidence hash, signature, and checksum, and commits it before MQTT is called.
- **MQTT connected:** the exact stored payload is submitted to `device/{id}/incident` at QoS 1, non-retained. The NVS record remains until application ACK; MQTT PUBACK alone does not delete it.
- **MQTT disconnected / publish failure:** durable persistence has already completed. A negative `mqtt_publish()` result logs `incident queued offline`; the record remains. If the MQTT client accepts an offline enqueue and returns nonnegative, that warning is absent, but the NVS record still remains until ACK.
- **Retry:** after each worker receive and every 60-second worker timeout, `incident_retry_pending()` reloads and publishes the exact saved payload. It does not re-sign or allocate another sequence.
- **ACK:** only a valid accepted Schema-v2 ACK with the exact `incident_id` and `evidence_hash` pair erases the record and commits the erase. Rejected/malformed ACKs do not delete it.

## Snapshot source

| Field | Source during replay |
|---|---|
| temperature | Replay T sample finalized for the current 10-second step; zeroed if raw T is invalid |
| humidity | Replay RH sample finalized for the current step; zeroed if invalid/out of range |
| CO | Gas EWS current CO value derived from replay; encoded only when the current raw CO-valid bit is set, otherwise zeroed |
| NO2 | Gas EWS current NO2 value derived from replay; encoded only when the current raw NO2-valid bit is set, otherwise zeroed |
| sensor valid mask | Current step's replay raw T/RH/CO/NO2 finite flags; not live sensor flags |
| overall level | Maximum of replay-driven CO and NO2 Gas EWS levels |
| CO/NO2 levels | Replay-driven `gas_ews_status_t.level[]` after rule, projection, and model update |
| alarm source masks | Replay-driven status: bit 0 rule, bit 1 projection, bit 2 model |
| STEL/TWA/projection | Derived by production `gas_ews.c` from replay history; each value has its own derived-valid bit |
| model probabilities | Production TFLite result for the replay 20-minute window; zeroed when its probability-valid bit is absent |
| model SHA | SHA-256 of the currently embedded firmware model; all zero only if the hash API fails |
| calibration R0/revision | Current device calibration snapshot from calibration NVS, **not replay data**; zero/revision 0 when absent, or all zero on snapshot read failure |
| calibration hash | Computed in `process_work()` from the captured current R0 values and revision, including their zero/default representation |
| firmware version/hash | Current firmware constant and its hash, not replay data |
| observed_at | Real wall-clock `time(NULL)` at incident submission, not accelerated replay time |
| time_source | Current approved firmware source (`SNTP` or `DS3231`), not a replay source |
| device ID/hash | Current resolved physical-device identity, not replay data |

There is no accidental mixing of live sensor readings into replay gas/T/RH evidence. The intentionally live/current metadata is clock provenance, device identity, firmware/model identity, and calibration state.

## Scenario timing

Times below come from the existing generated `replay_summary.md` and per-step expected CSV files; they are measured from the first replay sample. Alarm source masks were reproduced from those values with the production thresholds and two-step debounce.

| Scenario | Transition | Simulated time | Gas | Source mask | Cause | At 60x after replay start | Approx. after `ai_start()` |
|---|---|---:|---|---:|---|---:|---:|
| `co_event` (0) | SAFE -> EARLY | 40:00 | CO | `4` | model | 40.0 s | 50.0 s |
| `co_event` (0) | EARLY -> EXCEEDED | 47:20 | CO | `7` | QCVN rule active; projection and model also active | 47.3 s | 57.3 s |
| `no2_event` (1) | SAFE -> EARLY | 45:10 | NO2 | `2` | projection | 45.2 s | 55.2 s |
| `no2_event` (1) | EARLY -> SAFE | 55:20 | NO2 | `0` | 125 s outage/preheat reset; no incident on decrease | 55.3 s | 65.3 s |
| `no2_event` (1) | SAFE -> EXCEEDED | 63:40 | NO2 | `1` | QCVN STEL rule | 63.7 s | 73.7 s |

The final column includes the replay task's fixed 10-second start delay, but not earlier boot time. The complete 72-minute scenario takes about 72 seconds at 60x; the complete 88-minute scenario takes about 88 seconds. More generally, 72 replay minutes / 60 = 72 wall seconds (1:12), and 88 replay minutes / 60 = 88 wall seconds (1:28).

`no2_event` therefore produces two eligible incidents, not a single `EARLY -> EXCEEDED` incident: the outage clears the early warning before the later direct `SAFE -> EXCEEDED` transition.

## Expected UART logs

The firmware has strong failure logs but few incident success logs. Absence of a warning is not proof of sequence/sign/persist/publish completion.

### A. Replay started

- `ai: AI REPLAY MODE: scenario 'co_event', 866 samples (~72 min) at x60 -- the AI ignores the real sensors`
- Ten seconds later: `ai: replay 'co_event' start: 866 samples (72 min simulated) at x60`
- Scenario 1 substitutes `no2_event`, `1062`, and `88`.

### B. Gas EWS/model result

- `gas_ews_model: gas_ews model ready: ...; self-test OK`
- `ai: gas_ews_model_init (AllocateTensors + 2-window self-test): ... us`
- `ai: first inference at ...`
- Every processed replay step: `ai: RS,<t_s>,...`

### C. Level transition

- Example: `ai: co: an_toan -> canh_bao_som (ppm=... STEL=... TWA=... proj=... p=...)`
- Later: `ai: co: canh_bao_som -> vuot_nguong (...)`
- Scenario 1 uses `no2` and also logs its temporary `canh_bao_som -> an_toan` decrease.

### D. Buzzer/local alarm

- **NO LOG CURRENTLY** on successful pattern submission or tone playback.
- Failures can log under `buzzer`, such as `buzzer queue lacks space for ... step(s)` or `buzzer queue full - dropped pattern at step ...`.

### E. Incident candidate accepted

- **NO LOG CURRENTLY.** Time/candidate-gate rejection is also silent.
- Work-queue rejection: `incident: incident worker busy; local alert unaffected`.

### F. Sequence allocated

- **NO LOG CURRENTLY** on success.
- Failure: `incident: sequence persistence failed`.

### G. Signer/signature

- **NO LOG CURRENTLY** on successful signer lookup or signature.
- Missing signer: `incident: incident skipped: no encrypted provisioned signer`.
- Invalid contract/sign failure: `incident: incident signing unavailable; sequence retained without reuse`.
- No private key or digest is logged.

### H. Persisted queue record

- **NO LOG CURRENTLY** on success.
- Full queue: `incident: incident queue full (count=...)`.
- Save/payload failure: `incident: incident durable persistence failed`.

### I. MQTT publish

- **NO INCIDENT-SPECIFIC SUCCESS LOG CURRENTLY.**
- Negative immediate result: `incident: incident queued offline`.
- General connection state is visible as `mqtt: Connected to broker` or `mqtt: Disconnected; reconnecting automatically`.

### J. ACK received/delete

- Receive log: `mqtt: RX [device/<id>/incident/ack]: <payload>`.
- **NO LOG CURRENTLY** on successful exact-match deletion.
- Invalid/rejected ACK: `mqtt: incident ACK rejected: ...`.

## Host verification performed

No board was flashed.

| Check | Result |
|---|---|
| `test_incident_transitions.py` | PASS, including transition gate, invalid time, SNTP/RTC, duplicate rejection, and local-safety ordering |
| `test_incident_persistence_retry.py` | PASS, including sequence durability/no-reuse, persist-before-publish, exact-byte offline/reboot retry, and no re-sign |
| `test_incident_queue_full.py` | PASS at configured and alternate capacity, including no overwrite/partial record, local alert unaffected, ACK frees capacity, and reboot-full behavior |
| `test_incident_signatures.py` | PASS for exact EIP-712 digest/signature vectors, deterministic low-s signatures, recovery, and negative signature cases |
| `test_incident_ack_matrix.py` | PASS for exact-pair deletion, malformed/rejected/cross-match cases, retry interaction, and delete commit failure |
| `test_incident_vectors.py` | PASS for the production Schema-v2 codec vectors |
| `test_gas_ews_host.c ... golden` | PASS for preheat/outage/debounce and all `sim_co`, `sim_no2`, and `device` golden fields with zero mismatches |

`compare_replay_log.py` was inspected but not run because it requires a captured ESP32 UART log containing `RS,` lines. This audit did not flash or monitor a board. The generated replay expected CSV files were used for the exact transition timing above.

## Limitations

- Static tracing and host shims prove source routing and deterministic logic, but do not prove FreeRTOS scheduling, encrypted NVS, hardware secp256k1 execution, actual broker delivery, or backend ACK behavior on this board. Those remain board/integration checks.
- The active replay `sdkconfig` cannot exercise signing today because NVS encryption is disabled and the verifying contract is empty; a signer cannot be accepted in plaintext NVS by design.
- Replay evidence uses accelerated simulated sensor history but real wall-clock incident time and current device calibration/identity. It is valid as bench-test evidence, not a claim that the physical environment contained those gas values at `observed_at`.
- Exact CO early-warning timing depends on successful TFLite initialization/self-test. Rule/projection safety logic remains active if the model is unavailable, but the golden model-driven transition may change.
- UART currently has no success markers for candidate acceptance, sequence allocation, signing, persistence, MQTT enqueue, or ACK deletion. NVS/payload/backend inspection is needed to prove those stages on board without adding instrumentation.

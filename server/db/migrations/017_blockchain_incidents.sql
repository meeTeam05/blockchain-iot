-- Blockchain incident intake.
-- Evidence is kept indefinitely: these tables have no retention policy and no
-- ON DELETE CASCADE from devices, so deleting a device never deletes evidence.

-- Device signing keys registered for EIP-712 incident attestations.
CREATE TABLE IF NOT EXISTS device_signers (
    id              BIGSERIAL PRIMARY KEY,
    device_id       TEXT NOT NULL,
    signer_address  TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'active',
    activated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at      TIMESTAMPTZ,
    revoke_reason   TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT device_signers_address_check CHECK (signer_address ~ '^0x[0-9a-f]{40}$'),
    CONSTRAINT device_signers_status_check CHECK (status IN ('active', 'revoked')),
    CONSTRAINT device_signers_revoked_at_check CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
    -- A revoked/rotated key is never reused. Physical factory reset preserves
    -- the Task 1 signer and does not imply revocation.
    CONSTRAINT device_signers_address_unique UNIQUE (signer_address)
);

CREATE UNIQUE INDEX IF NOT EXISTS device_signers_one_active_idx
    ON device_signers (device_id)
    WHERE status = 'active';

-- On-chain owner wallet (AirSafetyLog ownerAddress); synced by the chain indexer.
ALTER TABLE devices
    ADD COLUMN IF NOT EXISTS owner_address TEXT;

ALTER TABLE devices
    DROP CONSTRAINT IF EXISTS devices_owner_address_check;

ALTER TABLE devices
    ADD CONSTRAINT devices_owner_address_check
    CHECK (owner_address IS NULL OR owner_address ~ '^0x[0-9a-f]{40}$');

CREATE TABLE IF NOT EXISTS incidents (
    id                              BIGSERIAL PRIMARY KEY,
    device_id                       TEXT NOT NULL,

    -- IncidentEvidence v2 fields, in schema order.
    schema_version                  SMALLINT NOT NULL,
    device_id_hash                  TEXT NOT NULL,
    incident_id                     TEXT NOT NULL,
    sequence                        NUMERIC(20, 0) NOT NULL,
    observed_at                     NUMERIC(20, 0) NOT NULL,
    time_source                     SMALLINT NOT NULL,
    sensor_valid_mask               SMALLINT NOT NULL,
    detection_method                SMALLINT NOT NULL,
    temperature_c_x100              INTEGER NOT NULL,
    humidity_pct_x100               INTEGER NOT NULL,
    co_ppm_x1000                    BIGINT NOT NULL,
    no2_ppm_x1000                   BIGINT NOT NULL,
    overall_level                   SMALLINT NOT NULL,
    co_level                        SMALLINT NOT NULL,
    no2_level                       SMALLINT NOT NULL,
    co_alarm_source_mask            SMALLINT NOT NULL,
    no2_alarm_source_mask           SMALLINT NOT NULL,
    derived_valid_mask              SMALLINT NOT NULL,
    co_stel15_ppm_x1000             BIGINT NOT NULL,
    no2_stel15_ppm_x1000            BIGINT NOT NULL,
    co_twa8h_ppm_x1000              BIGINT NOT NULL,
    no2_twa8h_ppm_x1000             BIGINT NOT NULL,
    co_proj10_ppm_x1000             BIGINT NOT NULL,
    no2_proj10_ppm_x1000            BIGINT NOT NULL,
    model_probability_valid_mask    SMALLINT NOT NULL,
    co_model_probability_bps        INTEGER NOT NULL,
    no2_model_probability_bps       INTEGER NOT NULL,
    incident_kind                   SMALLINT NOT NULL,
    severity                        SMALLINT NOT NULL,
    firmware_version_hash           TEXT NOT NULL,
    model_sha256                    TEXT NOT NULL,
    calibration_revision            BIGINT NOT NULL,
    calibration_hash                TEXT NOT NULL,

    -- Transport fields and verification output.
    firmware_version                TEXT NOT NULL,
    calibration_canonical           TEXT NOT NULL,
    evidence_hash                   TEXT NOT NULL,
    eip712_digest                   TEXT NOT NULL,
    signature                       TEXT NOT NULL,
    signer_address                  TEXT NOT NULL,
    domain_name                     TEXT NOT NULL,
    domain_version                  TEXT NOT NULL,
    domain_chain_id                 NUMERIC(78, 0) NOT NULL,
    domain_verifying_contract       TEXT NOT NULL,
    raw_payload                     BYTEA NOT NULL,
    payload                         JSONB NOT NULL,
    verify_status                   TEXT NOT NULL DEFAULT 'valid',

    -- Owner lifecycle; written by the chain indexer (Task 4).
    owner_status                    TEXT NOT NULL DEFAULT 'open',
    acknowledged_at                 TIMESTAMPTZ,
    acknowledged_by                 TEXT,
    acknowledged_tx_hash            TEXT,
    resolved_at                     TIMESTAMPTZ,
    resolved_by                     TEXT,
    resolved_tx_hash                TEXT,

    observed_at_ts                  TIMESTAMPTZ NOT NULL,
    received_at                     TIMESTAMPTZ NOT NULL,
    created_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT incidents_device_incident_unique UNIQUE (device_id, incident_id),
    CONSTRAINT incidents_device_sequence_unique UNIQUE (device_id, sequence),
    CONSTRAINT incidents_bytes32_check CHECK (
        device_id_hash ~ '^0x[0-9a-f]{64}$'
        AND incident_id ~ '^0x[0-9a-f]{64}$'
        AND firmware_version_hash ~ '^0x[0-9a-f]{64}$'
        AND model_sha256 ~ '^0x[0-9a-f]{64}$'
        AND calibration_hash ~ '^0x[0-9a-f]{64}$'
        AND evidence_hash ~ '^0x[0-9a-f]{64}$'
        AND eip712_digest ~ '^0x[0-9a-f]{64}$'
    ),
    CONSTRAINT incidents_signature_check CHECK (signature ~ '^0x[0-9a-f]{130}$'),
    CONSTRAINT incidents_signer_check CHECK (signer_address ~ '^0x[0-9a-f]{40}$'),
    CONSTRAINT incidents_uint64_check CHECK (
        sequence BETWEEN 0 AND 18446744073709551615
        AND observed_at BETWEEN 0 AND 18446744073709551615
    ),
    CONSTRAINT incidents_level_check CHECK (
        schema_version = 2
        AND overall_level IN (1, 2)
        AND severity IN (1, 2)
        AND incident_kind IN (1, 2)
    ),
    CONSTRAINT incidents_verify_status_check CHECK (verify_status IN ('valid')),
    CONSTRAINT incidents_owner_status_check CHECK (owner_status IN ('open', 'acknowledged', 'resolved')),
    CONSTRAINT incidents_raw_payload_size_check CHECK (octet_length(raw_payload) <= 16384)
);

CREATE INDEX IF NOT EXISTS incidents_device_sequence_idx
    ON incidents (device_id, sequence DESC);

CREATE INDEX IF NOT EXISTS incidents_received_at_idx
    ON incidents (received_at DESC);

-- Chain submission queue. Task 3 inserts the row; the chain worker (Task 4) owns
-- every later transition. AirSafetyLog tracks exact (device, sequence) use, so rows
-- are independent and are NOT submitted FIFO-blocking per device (see migration 019).
CREATE TABLE IF NOT EXISTS blockchain_outbox (
    id                  BIGSERIAL PRIMARY KEY,
    incident_row_id     BIGINT NOT NULL REFERENCES incidents(id),
    device_id           TEXT NOT NULL,
    incident_id         TEXT NOT NULL,
    sequence            NUMERIC(20, 0) NOT NULL,
    status              TEXT NOT NULL DEFAULT 'queued',
    attempts            INTEGER NOT NULL DEFAULT 0,
    next_attempt_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_attempt_at     TIMESTAMPTZ,
    last_error          TEXT,
    tx_hash             TEXT,
    block_number        BIGINT,
    confirmations       INTEGER,
    confirmed_at        TIMESTAMPTZ,
    blocked_at          TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT blockchain_outbox_status_check CHECK (status IN ('queued', 'pending', 'confirmed', 'failed', 'blocked')),
    CONSTRAINT blockchain_outbox_attempts_check CHECK (attempts >= 0),
    CONSTRAINT blockchain_outbox_tx_hash_check CHECK (tx_hash IS NULL OR tx_hash ~ '^0x[0-9a-f]{64}$'),
    CONSTRAINT blockchain_outbox_incident_unique UNIQUE (incident_row_id),
    CONSTRAINT blockchain_outbox_device_sequence_unique UNIQUE (device_id, sequence)
);

CREATE INDEX IF NOT EXISTS blockchain_outbox_status_device_sequence_idx
    ON blockchain_outbox (status, device_id, sequence);

-- Rejected payloads that indicate tampering, key misuse or conflicting replays.
CREATE TABLE IF NOT EXISTS security_events (
    id              BIGSERIAL PRIMARY KEY,
    device_id       TEXT,
    type            TEXT NOT NULL,
    incident_id     TEXT,
    evidence_hash   TEXT,
    details         JSONB NOT NULL DEFAULT '{}'::jsonb,
    raw_payload     BYTEA,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT security_events_raw_payload_size_check CHECK (raw_payload IS NULL OR octet_length(raw_payload) <= 16384)
);

CREATE INDEX IF NOT EXISTS security_events_device_created_idx
    ON security_events (device_id, created_at DESC);

CREATE INDEX IF NOT EXISTS security_events_type_created_idx
    ON security_events (type, created_at DESC);

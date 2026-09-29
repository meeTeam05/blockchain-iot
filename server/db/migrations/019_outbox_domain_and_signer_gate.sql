-- E2E fix (E2E_FIX_PLAN.md, stages 3, 5, 6, 7).
--
-- * Outbox rows carry the EIP-712 domain and signer they were verified with, and
--   the intake decides chain eligibility up front (legacy_domain / waiting_signer /
--   stale_signer), so firmware is never left holding a record for chain reasons.
-- * device_signers gains 'pending' (registered in DB, on-chain op not yet confirmed).
-- * device_chain_ops is the single pipeline for register/rotate/revoke/set_owner.
-- * Indexer tables: checkpoint, idempotent event log, per-device chain state.

-- ---------------------------------------------------------------------------
-- blockchain_outbox
-- ---------------------------------------------------------------------------
ALTER TABLE blockchain_outbox DROP CONSTRAINT IF EXISTS blockchain_outbox_status_check;
ALTER TABLE blockchain_outbox ADD CONSTRAINT blockchain_outbox_status_check
    CHECK (status IN ('queued', 'pending', 'confirmed', 'failed', 'blocked',
                      'legacy_domain', 'waiting_signer', 'stale_signer'));

ALTER TABLE blockchain_outbox ADD COLUMN IF NOT EXISTS verifying_contract TEXT;
ALTER TABLE blockchain_outbox ADD COLUMN IF NOT EXISTS signer_address     TEXT;
ALTER TABLE blockchain_outbox ADD COLUMN IF NOT EXISTS incident_key       TEXT;
ALTER TABLE blockchain_outbox ADD COLUMN IF NOT EXISTS fail_reason        TEXT;
ALTER TABLE blockchain_outbox ADD COLUMN IF NOT EXISTS submitted_at       TIMESTAMPTZ;

ALTER TABLE blockchain_outbox DROP CONSTRAINT IF EXISTS blockchain_outbox_incident_key_check;
ALTER TABLE blockchain_outbox ADD CONSTRAINT blockchain_outbox_incident_key_check
    CHECK (incident_key IS NULL OR incident_key ~ '^0x[0-9a-f]{64}$');

UPDATE blockchain_outbox o
SET verifying_contract = i.domain_verifying_contract,
    signer_address     = i.signer_address
FROM incidents i
WHERE i.id = o.incident_row_id
  AND o.verifying_contract IS NULL;

CREATE INDEX IF NOT EXISTS blockchain_outbox_incident_key_idx
    ON blockchain_outbox (incident_key) WHERE incident_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS blockchain_outbox_device_signer_status_idx
    ON blockchain_outbox (device_id, signer_address, status);

COMMENT ON TABLE blockchain_outbox IS
    'Chain submission queue. AirSafetyLog tracks exact (device, sequence) use, so rows are independent: a failed or blocked row never blocks other sequences of the same device.';
COMMENT ON COLUMN blockchain_outbox.status IS
    'queued: ready; pending: tx sent, waiting confirmations; confirmed: on-chain; failed: permanent revert; blocked: retries exhausted; legacy_domain: signed for an old domain, kept off-chain, never sent; waiting_signer: signer not (yet) the on-chain signer; stale_signer: current domain but the key was rotated away, never sent';

-- ---------------------------------------------------------------------------
-- device_signers: 'pending' until the on-chain register/rotate op confirms
-- ---------------------------------------------------------------------------
ALTER TABLE device_signers DROP CONSTRAINT IF EXISTS device_signers_status_check;
ALTER TABLE device_signers ADD CONSTRAINT device_signers_status_check
    CHECK (status IN ('pending', 'active', 'revoked'));

CREATE UNIQUE INDEX IF NOT EXISTS device_signers_one_pending_idx
    ON device_signers (device_id)
    WHERE status = 'pending';

-- ---------------------------------------------------------------------------
-- Signer lifecycle pipeline (DB <-> chain)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS device_chain_ops (
    id                  BIGSERIAL PRIMARY KEY,
    device_id           TEXT NOT NULL,
    op                  TEXT NOT NULL,
    signer_address      TEXT,
    owner_address       TEXT,
    status              TEXT NOT NULL DEFAULT 'queued',
    tx_hash             TEXT,
    block_number        BIGINT,
    last_error          TEXT,
    attempts            INTEGER NOT NULL DEFAULT 0,
    next_attempt_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT device_chain_ops_op_check CHECK (op IN ('register', 'rotate', 'revoke', 'set_owner')),
    CONSTRAINT device_chain_ops_status_check CHECK (status IN ('queued', 'pending', 'confirmed', 'failed')),
    CONSTRAINT device_chain_ops_signer_check CHECK (signer_address IS NULL OR signer_address ~ '^0x[0-9a-f]{40}$'),
    CONSTRAINT device_chain_ops_owner_check CHECK (owner_address IS NULL OR owner_address ~ '^0x[0-9a-f]{40}$'),
    CONSTRAINT device_chain_ops_tx_hash_check CHECK (tx_hash IS NULL OR tx_hash ~ '^0x[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS device_chain_ops_pending_idx
    ON device_chain_ops (status, device_id, id);

-- ---------------------------------------------------------------------------
-- Indexer
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS chain_checkpoints (
    contract_address    TEXT PRIMARY KEY,
    last_block          BIGINT NOT NULL,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS chain_events (
    id                  BIGSERIAL PRIMARY KEY,
    contract_address    TEXT NOT NULL,
    block_number        BIGINT NOT NULL,
    block_hash          TEXT NOT NULL,
    tx_hash             TEXT NOT NULL,
    log_index           INTEGER NOT NULL,
    event_name          TEXT NOT NULL,
    args                JSONB NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chain_events_log_unique UNIQUE (contract_address, tx_hash, log_index)
);

CREATE INDEX IF NOT EXISTS chain_events_block_idx
    ON chain_events (contract_address, block_number);

CREATE TABLE IF NOT EXISTS device_chain_state (
    contract_address    TEXT NOT NULL,
    device_id_hash      TEXT NOT NULL,
    device_id           TEXT,
    signer_address      TEXT,
    owner_address       TEXT,
    active              BOOLEAN NOT NULL DEFAULT FALSE,
    last_sequence       NUMERIC(20, 0),
    updated_block       BIGINT,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (contract_address, device_id_hash)
);

CREATE INDEX IF NOT EXISTS device_chain_state_device_idx
    ON device_chain_state (device_id);

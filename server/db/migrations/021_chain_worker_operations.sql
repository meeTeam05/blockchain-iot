-- Task 4 operations: an operator-resettable retry window, a chain worker heartbeat for
-- health/metrics, and a durable alert queue for items that need a human.

-- The 10-attempt / 24-hour bound counts from this instant. NULL means "since created_at";
-- scripts/chain-ops.js requeue sets it to NOW() so an unblocked item gets a fresh window.
ALTER TABLE blockchain_outbox ADD COLUMN IF NOT EXISTS retry_window_started_at TIMESTAMPTZ;
ALTER TABLE device_chain_ops ADD COLUMN IF NOT EXISTS retry_window_started_at TIMESTAMPTZ;

-- One row per contract, upserted by the chain worker after every iteration.
CREATE TABLE IF NOT EXISTS chain_worker_status (
    contract_address        TEXT PRIMARY KEY,
    relayer_address         TEXT,
    started_at              TIMESTAMPTZ NOT NULL,
    last_tick_at            TIMESTAMPTZ NOT NULL,
    last_success_at         TIMESTAMPTZ,
    head_block              BIGINT,
    consecutive_failures    INTEGER NOT NULL DEFAULT 0,
    rpc_errors_total        BIGINT NOT NULL DEFAULT 0,
    last_error              TEXT,
    last_error_at           TIMESTAMPTZ,
    relayer_balance_wei     NUMERIC(78, 0),
    balance_checked_at      TIMESTAMPTZ,
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Raised idempotently by dedupe_key; delivered to OPS_ALERT_WEBHOOK_URL when configured
-- and kept until an operator acknowledges it.
CREATE TABLE IF NOT EXISTS chain_ops_alerts (
    id                  BIGSERIAL PRIMARY KEY,
    dedupe_key          TEXT NOT NULL,
    kind                TEXT NOT NULL,
    severity            TEXT NOT NULL,
    device_id           TEXT,
    subject_id          TEXT,
    message             TEXT NOT NULL,
    details             JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    delivered_at        TIMESTAMPTZ,
    delivery_attempts   INTEGER NOT NULL DEFAULT 0,
    delivery_error      TEXT,
    acknowledged_at     TIMESTAMPTZ,
    CONSTRAINT chain_ops_alerts_dedupe_unique UNIQUE (dedupe_key),
    CONSTRAINT chain_ops_alerts_severity_check CHECK (severity IN ('warning', 'critical'))
);

CREATE INDEX IF NOT EXISTS chain_ops_alerts_open_idx
    ON chain_ops_alerts (acknowledged_at, created_at DESC);

CREATE INDEX IF NOT EXISTS chain_ops_alerts_undelivered_idx
    ON chain_ops_alerts (id) WHERE delivered_at IS NULL;

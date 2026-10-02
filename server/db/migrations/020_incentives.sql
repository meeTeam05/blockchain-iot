-- Token incentives backend (Task5_8_plan.md, Task 7).
--
-- SafetyIncentives is the source of truth; these tables are a projection written only
-- by the chain worker (incentives indexer + keeper) so the API and dApp can list
-- rewards, penalties and overdue incidents without scanning logs.
--
-- The incentives indexer keeps its own row in chain_checkpoints, keyed by the
-- SafetyIncentives address (no schema change needed for that).

-- ---------------------------------------------------------------------------
-- Idempotent event log, same shape and unique key as chain_events.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS incentive_events (
    id                  BIGSERIAL PRIMARY KEY,
    contract            TEXT NOT NULL,
    tx_hash             TEXT NOT NULL,
    log_index           INTEGER NOT NULL,
    block_number        BIGINT NOT NULL,
    block_hash          TEXT NOT NULL,
    block_time          TIMESTAMPTZ NOT NULL,
    name                TEXT NOT NULL,
    incident_key        TEXT,
    device_id_hash      TEXT,
    -- staker / owner / keeper / funder, depending on the event.
    account             TEXT,
    -- Token amount in wei (ASAFE has 18 decimals).
    amount              NUMERIC(78, 0),
    data                JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT incentive_events_log_unique UNIQUE (contract, tx_hash, log_index),
    CONSTRAINT incentive_events_bytes32_check CHECK (
        (incident_key IS NULL OR incident_key ~ '^0x[0-9a-f]{64}$')
        AND (device_id_hash IS NULL OR device_id_hash ~ '^0x[0-9a-f]{64}$')
    ),
    CONSTRAINT incentive_events_account_check CHECK (account IS NULL OR account ~ '^0x[0-9a-f]{40}$')
);

CREATE INDEX IF NOT EXISTS incentive_events_incident_idx
    ON incentive_events (incident_key) WHERE incident_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS incentive_events_device_idx
    ON incentive_events (device_id_hash, id DESC) WHERE device_id_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS incentive_events_name_idx
    ON incentive_events (contract, name, block_time);

-- ---------------------------------------------------------------------------
-- Per-incident settlement state.
-- ---------------------------------------------------------------------------
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS reward_status TEXT NOT NULL DEFAULT 'none';
-- loggedAt + ACK_DEADLINE[severity] / + RESOLVE_DEADLINE, from pendingSettlement().
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS ack_deadline_at TIMESTAMPTZ;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS resolve_deadline_at TIMESTAMPTZ;
-- AirSafetyLog loggedAt (block time of IncidentLogged).
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS logged_at TIMESTAMPTZ;
-- NULL until checked; FALSE for incidents logged before SafetyIncentives was activated.
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS incentive_covered BOOLEAN;
-- Mirror of SafetyIncentives.settlementFlags: TIMELY_ACK=1, ACK_REWARDED=2,
-- RESOLVE_SETTLED=4, ACK_SLASHED=8, RELAY_SLASHED=16.
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS incentive_flags SMALLINT NOT NULL DEFAULT 0;

ALTER TABLE incidents DROP CONSTRAINT IF EXISTS incidents_reward_status_check;
ALTER TABLE incidents ADD CONSTRAINT incidents_reward_status_check
    CHECK (reward_status IN ('none', 'ack_rewarded', 'resolved_rewarded', 'over_cap', 'slashed', 'late_relay_slashed'));

COMMENT ON COLUMN incidents.reward_status IS
    'Most significant incentive outcome: slashed > resolved_rewarded > ack_rewarded > over_cap > late_relay_slashed > none. incentive_flags keeps every outcome (a late-relayed incident can also be ack_rewarded).';

-- Keeper scans: open incidents past their deadline, acknowledged ones still in time.
CREATE INDEX IF NOT EXISTS incidents_incentive_deadline_idx
    ON incidents (ack_deadline_at)
    WHERE incentive_covered = TRUE AND (incentive_flags & 9) = 0;
CREATE INDEX IF NOT EXISTS incidents_incentive_unchecked_idx
    ON incidents (id)
    WHERE incentive_covered IS NULL;

-- ---------------------------------------------------------------------------
-- Bonds. The operator bond is the row with device_id_hash = 0x00…00 (OPERATOR_BOND_ID).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS device_bonds (
    contract                TEXT NOT NULL,
    device_id_hash          TEXT NOT NULL,
    device_id               TEXT,
    staker                  TEXT,
    amount                  NUMERIC(78, 0) NOT NULL DEFAULT 0,
    since                   TIMESTAMPTZ,
    unstake_requested_at    TIMESTAMPTZ,
    unstake_available_at    TIMESTAMPTZ,
    updated_block           BIGINT NOT NULL,
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (contract, device_id_hash),
    CONSTRAINT device_bonds_amount_check CHECK (amount >= 0),
    CONSTRAINT device_bonds_staker_check CHECK (staker IS NULL OR staker ~ '^0x[0-9a-f]{40}$')
);

CREATE INDEX IF NOT EXISTS device_bonds_device_idx
    ON device_bonds (device_id) WHERE device_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Contract-wide snapshot (params, reward fund, operator bond) refreshed by the worker,
-- so the API never needs an RPC connection.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS incentive_state (
    contract            TEXT PRIMARY KEY,
    token               TEXT NOT NULL,
    air_safety_log      TEXT NOT NULL,
    treasury            TEXT NOT NULL,
    operator            TEXT NOT NULL,
    params              JSONB NOT NULL,
    reward_fund         NUMERIC(78, 0) NOT NULL,
    total_bonded        NUMERIC(78, 0) NOT NULL,
    operator_bond       JSONB NOT NULL,
    activated_at        TIMESTAMPTZ NOT NULL,
    current_day         BIGINT NOT NULL,
    block_number        BIGINT NOT NULL,
    block_time          TIMESTAMPTZ NOT NULL,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Keeper work log: one row per (incident, action), so an incident is never processed twice.
--   pending: tx sent, waiting for confirmations
--   done:    our tx confirmed
--   skipped: normal no-op (settled by someone else, deadline passed, not covered, no bond)
--   retry:   transient RPC error, retried after next_attempt_at (exponential backoff)
--   failed:  retries exhausted or unexpected revert
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS keeper_actions (
    id                  BIGSERIAL PRIMARY KEY,
    incident_row_id     BIGINT NOT NULL REFERENCES incidents(id),
    incident_key        TEXT NOT NULL,
    action              TEXT NOT NULL,
    status              TEXT NOT NULL,
    tx_hash             TEXT,
    block_number        BIGINT,
    attempts            INTEGER NOT NULL DEFAULT 0,
    next_attempt_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_error          TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT keeper_actions_unique UNIQUE (incident_row_id, action),
    CONSTRAINT keeper_actions_action_check CHECK (action IN ('record_ack', 'record_resolve', 'slash_missed_ack')),
    CONSTRAINT keeper_actions_status_check CHECK (status IN ('pending', 'done', 'skipped', 'retry', 'failed')),
    CONSTRAINT keeper_actions_tx_hash_check CHECK (tx_hash IS NULL OR tx_hash ~ '^0x[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS keeper_actions_status_idx
    ON keeper_actions (status, next_attempt_at);

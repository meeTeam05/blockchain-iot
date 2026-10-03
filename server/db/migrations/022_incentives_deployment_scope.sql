-- Scope the incentives keeper/indexer projection by SafetyIncentives contract (Task 7).
--
-- 020 kept settlement state on shared incidents columns (incentive_flags, reward_status,
-- incentive_covered, ack/resolve_deadline_at) and keeper_actions unique on
-- (incident_row_id, action). After a redeploy of SafetyIncentives next to the same
-- AirSafetyLog, state written for deployment A would block deployment B. Every
-- deployment now has its own rows, keyed by the lowercase contract address.
--
-- incidents.logged_at stays on incidents: it is the AirSafetyLog loggedAt, identical for
-- every incentives deployment. The 020 settlement columns on incidents are no longer
-- written or read; they are kept (not dropped) for backward compatibility.
--
-- Rerunnable: every statement is IF NOT EXISTS / ON CONFLICT DO NOTHING / guarded.

CREATE TABLE IF NOT EXISTS incident_incentives (
    contract            TEXT NOT NULL,
    incident_row_id     BIGINT NOT NULL REFERENCES incidents(id),
    -- NULL until pendingSettlement() was read; FALSE when logged before activatedAt.
    covered             BOOLEAN,
    ack_deadline_at     TIMESTAMPTZ,
    resolve_deadline_at TIMESTAMPTZ,
    -- Mirror of this deployment's SafetyIncentives.settlementFlags.
    flags               SMALLINT NOT NULL DEFAULT 0,
    reward_status       TEXT NOT NULL DEFAULT 'none',
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (contract, incident_row_id),
    CONSTRAINT incident_incentives_contract_check CHECK (contract ~ '^0x[0-9a-f]{40}$'),
    CONSTRAINT incident_incentives_reward_status_check
        CHECK (reward_status IN ('none', 'ack_rewarded', 'resolved_rewarded', 'over_cap', 'slashed', 'late_relay_slashed'))
);

CREATE INDEX IF NOT EXISTS incident_incentives_deadline_idx
    ON incident_incentives (contract, ack_deadline_at)
    WHERE covered = TRUE AND (flags & 9) = 0;

-- Backfill: one row per (indexed deployment, synced incident). Coverage and deadlines
-- follow the contract rules (loggedAt >= activatedAt; loggedAt + params); flags and
-- reward_status are rebuilt from that deployment's own events, never from the shared
-- 020 columns, so a DB that indexed several deployments is split correctly.
INSERT INTO incident_incentives (contract, incident_row_id, covered, ack_deadline_at, resolve_deadline_at, flags, reward_status)
SELECT s.contract,
       i.id,
       i.logged_at >= s.activated_at,
       CASE WHEN i.logged_at >= s.activated_at THEN
           i.logged_at + (CASE WHEN i.severity = 1 THEN (s.params->>'ack_deadline_warning')::bigint
                               ELSE (s.params->>'ack_deadline_danger')::bigint END) * INTERVAL '1 second'
       END,
       CASE WHEN i.logged_at >= s.activated_at THEN
           i.logged_at + (s.params->>'resolve_deadline')::bigint * INTERVAL '1 second'
       END,
       COALESCE(ev.flags, 0),
       COALESCE(ev.status, 'none')
FROM incentive_state s
JOIN incidents i ON i.logged_at IS NOT NULL
JOIN blockchain_outbox o ON o.incident_row_id = i.id AND o.incident_key IS NOT NULL
LEFT JOIN LATERAL (
    SELECT bit_or(CASE e.name
                      WHEN 'AckRewarded' THEN 3
                      WHEN 'ResolveRewarded' THEN 4
                      WHEN 'MissedAckSlashed' THEN 8
                      WHEN 'LateRelaySlashed' THEN 16
                      WHEN 'RewardSkipped' THEN CASE e.data->>'rule' WHEN '1' THEN 1 WHEN '2' THEN 4 ELSE 0 END
                      ELSE 0 END)::smallint AS flags,
           (ARRAY['none', 'late_relay_slashed', 'over_cap', 'ack_rewarded', 'resolved_rewarded', 'slashed'])[
               MAX(CASE e.name
                       WHEN 'LateRelaySlashed' THEN 2
                       WHEN 'AckRewarded' THEN 4
                       WHEN 'ResolveRewarded' THEN 5
                       WHEN 'MissedAckSlashed' THEN 6
                       WHEN 'RewardSkipped' THEN CASE WHEN e.data->>'rule' = '1' AND e.data->>'reason' = '0' THEN 3 ELSE 1 END
                       ELSE 1 END)
           ] AS status
    FROM incentive_events e
    WHERE e.contract = s.contract AND e.incident_key = o.incident_key
) ev ON TRUE
ON CONFLICT (contract, incident_row_id) DO NOTHING;

-- Keeper work log per deployment.
ALTER TABLE keeper_actions ADD COLUMN IF NOT EXISTS contract TEXT;

-- Existing rows can only be attributed when exactly one deployment was ever indexed.
-- Otherwise they stay NULL: the keeper never matches them and re-evaluates from chain
-- (pendingSettlement + simulate), which is safe.
UPDATE keeper_actions
SET contract = (SELECT contract FROM incentive_state)
WHERE contract IS NULL AND (SELECT COUNT(*) FROM incentive_state) = 1;

ALTER TABLE keeper_actions DROP CONSTRAINT IF EXISTS keeper_actions_unique;
ALTER TABLE keeper_actions DROP CONSTRAINT IF EXISTS keeper_actions_contract_unique;
ALTER TABLE keeper_actions ADD CONSTRAINT keeper_actions_contract_unique UNIQUE (contract, incident_row_id, action);
ALTER TABLE keeper_actions DROP CONSTRAINT IF EXISTS keeper_actions_contract_check;
ALTER TABLE keeper_actions ADD CONSTRAINT keeper_actions_contract_check
    CHECK (contract IS NULL OR contract ~ '^0x[0-9a-f]{40}$');

CREATE INDEX IF NOT EXISTS keeper_actions_contract_status_idx
    ON keeper_actions (contract, status, next_attempt_at);

COMMENT ON COLUMN incidents.reward_status IS
    'Deprecated by 022: per-deployment state lives in incident_incentives.reward_status.';
COMMENT ON COLUMN incidents.incentive_flags IS
    'Deprecated by 022: per-deployment state lives in incident_incentives.flags.';
COMMENT ON COLUMN incidents.incentive_covered IS
    'Deprecated by 022: per-deployment state lives in incident_incentives.covered.';

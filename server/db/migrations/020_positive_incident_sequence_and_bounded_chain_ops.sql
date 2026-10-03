-- Align stored incidents with the firmware allocator and AirSafetyLog: sequence 0
-- is invalid. Refuse the migration if historical rows need operator review;
-- never silently delete or rewrite signed evidence.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM incidents WHERE sequence = 0) THEN
        RAISE EXCEPTION 'incident sequence 0 exists; review those rows before migration 020';
    END IF;
END $$;

ALTER TABLE incidents ADD CONSTRAINT incidents_positive_sequence_check
    CHECK (sequence >= 1);

-- Lifecycle operations share the incident outbox retry limits but need their own
-- terminal state so exhausted operations remain available for manual review.
ALTER TABLE device_chain_ops DROP CONSTRAINT device_chain_ops_status_check;
ALTER TABLE device_chain_ops ADD CONSTRAINT device_chain_ops_status_check
    CHECK (status IN ('queued', 'pending', 'confirmed', 'failed', 'blocked'));

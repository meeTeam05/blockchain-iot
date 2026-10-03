-- Task 1 firmware signs calibration_hash but does not transmit the calibration
-- canonical string. Keep the legacy column for old rows/API compatibility while
-- allowing exact firmware wire payloads to persist without inventing data.
ALTER TABLE incidents
    ALTER COLUMN calibration_canonical DROP NOT NULL;

COMMENT ON COLUMN incidents.calibration_canonical IS
    'Optional legacy transport value. Task 1 wire payload provides only the signed calibration_hash.';

/* Host-only runner: includes production incident.c's deterministic codec. */
#define INCIDENT_HOST_TEST 1
#include "../incident.c"

#include <stdlib.h>

static void fixture(evidence_t *e, int which)
{
    memset(e, 0, sizeof(*e));
    e->schema_version = 2;
    e->time_source = 1;
    e->snapshot.sensor_valid_mask = 15;
    e->snapshot.temperature_c_x100 = 3047;
    e->snapshot.humidity_pct_x100 = 7445;
    e->snapshot.no2_ppm_x1000 = which == 1 ? 323 : 450;
    e->snapshot.overall_level = which == 1 ? 1 : 2;
    e->snapshot.co_level = which == 1 ? 1 : 2;
    e->snapshot.co_alarm_source_mask = which == 1 ? 4 : 1;
    e->snapshot.derived_valid_mask = 63;
    e->snapshot.co_stel15_ppm_x1000 = which == 1 ? 24000 : 35000;
    e->snapshot.no2_stel15_ppm_x1000 = which == 1 ? 350 : 400;
    e->snapshot.co_twa8h_ppm_x1000 = which == 1 ? 1600 : 1800;
    e->snapshot.no2_twa8h_ppm_x1000 = which == 1 ? 22 : 25;
    e->snapshot.co_proj10_ppm_x1000 = which == 1 ? 36000 : 50000;
    e->snapshot.no2_proj10_ppm_x1000 = which == 1 ? 400 : 500;
    e->snapshot.model_probability_valid_mask = which == 1 ? 3 : 0;
    e->snapshot.co_model_probability_bps = which == 1 ? 9102 : 0;
    e->snapshot.no2_model_probability_bps = which == 1 ? 39 : 0;
    e->incident_kind = which == 1 ? 1 : 2;
    e->severity = which == 1 ? 1 : 2;
    e->sequence = which == 1 ? 43 : 44;
    e->observed_at = which == 1 ? 1790394600 : 1790394700;
    e->snapshot.co_ppm_x1000 = which == 1 ? 52000 : 70000;
    e->snapshot.calibration_revision = 3;
    e->snapshot.co_r0_q10000 = 98765;
    e->snapshot.no2_r0_q10000 = 43210;
    parse_hex32("0xd1a789f1e6ad1e2b5225fb8ed78876b5ef348c2a81741e46c8fcb50c85048dcc", e->model_sha256);
    set_calibration(e);
    keccak256("aa:bb:cc:dd:ee:ff", 17, e->device_id_hash);
    hash_incident_id(e->device_id_hash, e->sequence, e->incident_id);
    keccak256("0.1.1-gas-ews", 13, e->firmware_version_hash);
}

int main(int argc, char **argv)
{
    if (argc != 2 || (argv[1][0] != '1' && argv[1][0] != '2')) return 2;
    evidence_t e;
    uint8_t evidence_hash[32], digest[32];
    char dh[67], ih[67], fh[67], ch[67], eh[67], gh[67];
    fixture(&e, argv[1][0] - '0');
    hash_evidence(&e, evidence_hash);
    if (!hash_digest(&e, evidence_hash, digest)) return 3;
    hex32(e.device_id_hash, dh); hex32(e.incident_id, ih); hex32(e.firmware_version_hash, fh);
    hex32(e.calibration_hash, ch); hex32(evidence_hash, eh); hex32(digest, gh);
    printf("%s\n%s\n%s\n%s\n%s\n%s\n", dh, ih, fh, ch, eh, gh);
    return 0;
}

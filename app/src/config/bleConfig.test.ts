import { matchesProvisioningName } from './bleConfig';

describe('matchesProvisioningName', () => {
  it('matches the current firmware prefix', () => {
    expect(matchesProvisioningName('SMART_AIR_13ED8C')).toBe(true);
  });

  it('matches the legacy prefix', () => {
    expect(matchesProvisioningName('SmartAir-ABC123')).toBe(true);
  });

  it('trims whitespace before matching', () => {
    expect(matchesProvisioningName('  SMART_AIR_13ED8C  ')).toBe(true);
  });

  it('rejects unrelated device names', () => {
    expect(matchesProvisioningName('Unknown Device')).toBe(false);
  });
});

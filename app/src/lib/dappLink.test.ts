import { buildIncidentDappLink, incidentTarget, openNotificationDestination } from './dappLink';

const incidentId = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

describe('buildIncidentDappLink', () => {
  it('uses the canonical /dapp/ deployment prefix', () => {
    expect(
      buildIncidentDappLink(
        'https://air.example.com/api',
        'dc:b4:d9:13:ed:8c',
        incidentId,
      ),
    ).toBe(
      `https://metamask.app.link/dapp/air.example.com/dapp/d/dc%3Ab4%3Ad9%3A13%3Aed%3A8c/i/${incidentId}`,
    );
  });

  it('uses the active API origin, including its port, for the direct URL', () => {
    expect(buildIncidentDappLink('https://staging.example.com:8443/api/v2', 'device-2', incidentId))
      .toBe(`https://metamask.app.link/dapp/staging.example.com:8443/dapp/d/device-2/i/${incidentId}`);
  });

  it('an incident tap opens exactly one chain action and never navigates internally', async () => {
    const openUrl = jest.fn(async () => undefined);
    const openDevice = jest.fn();
    await openNotificationDestination(
      { type: 'incident.warning', deviceId: 'device-1', payload: { incident_id: incidentId } },
      'https://air.example.com/api',
      openUrl,
      openDevice,
    );
    expect(openUrl).toHaveBeenCalledTimes(1);
    expect(openUrl).toHaveBeenCalledWith(
      `https://metamask.app.link/dapp/air.example.com/dapp/d/device-1/i/${incidentId}`,
    );
    expect(openDevice).not.toHaveBeenCalled();
  });

  it('ordinary and malformed incident notifications retain one device action', () => {
    const openUrl = jest.fn(async () => undefined);
    const openDevice = jest.fn();
    openNotificationDestination(
      { type: 'command.done', deviceId: 'device-1', payload: {} },
      'https://air.example.com/api', openUrl, openDevice,
    );
    expect(openDevice).toHaveBeenCalledTimes(1);
    expect(openUrl).not.toHaveBeenCalled();

    openNotificationDestination(
      { type: 'incident.danger', deviceId: 'device-1', payload: { incident_id: 'invalid' } },
      'https://air.example.com/api', openUrl, openDevice,
    );
    expect(openDevice).toHaveBeenCalledTimes(2);
    expect(openUrl).not.toHaveBeenCalled();
  });
});

describe('incidentTarget', () => {
  const incidentId = `0x${'cd'.repeat(32)}`;
  it('selects only incident notifications with a valid incident id', () => {
    expect(incidentTarget({ type: 'incident.danger', deviceId: 'dev-1', payload: { incident_id: incidentId } }))
      .toEqual({ deviceId: 'dev-1', incidentId });
    expect(incidentTarget({ type: 'incident.warning', deviceId: 'dev-1', payload: { incident_id: 'bad' } })).toBeNull();
    for (const type of ['device.offline', 'command.done', 'ota.failed']) {
      expect(incidentTarget({ type, deviceId: 'dev-1', payload: { incident_id: incidentId } })).toBeNull();
    }
  });
});

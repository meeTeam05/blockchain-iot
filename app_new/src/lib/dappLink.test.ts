import { buildIncidentDappLink, openIncidentDappLink } from './dappLink';

describe('buildIncidentDappLink', () => {
  it('uses the canonical /dapp/ deployment prefix', () => {
    expect(
      buildIncidentDappLink(
        'https://air.example.com/api',
        'dc:b4:d9:13:ed:8c',
        '0xincident',
      ),
    ).toBe(
      'https://metamask.app.link/dapp/air.example.com/dapp/d/dc%3Ab4%3Ad9%3A13%3Aed%3A8c/i/0xincident',
    );
  });

  it('stops the parent tile press and opens exactly one chain URL', async () => {
    const event = { stopPropagation: jest.fn() };
    const openUrl = jest.fn(async () => undefined);
    await openIncidentDappLink(
      event,
      'https://air.example.com/api',
      'device-1',
      'incident-1',
      openUrl,
    );
    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
    expect(openUrl).toHaveBeenCalledTimes(1);
    expect(openUrl).toHaveBeenCalledWith(
      'https://metamask.app.link/dapp/air.example.com/dapp/d/device-1/i/incident-1',
    );
  });
});

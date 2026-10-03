import { create } from 'axios';
import MockAdapter from 'axios-mock-adapter';
import { IncidentService } from './incidentService';
import { ApiException, NetworkException } from '../api/appException';

const INCIDENT = `0x${'ab'.repeat(32)}`;

function makeService() {
  const client = create({ baseURL: 'http://example.com' });
  const mock = new MockAdapter(client);
  return { service: new IncidentService(client), mock };
}

test('getChainInfo reads the incident detail of an encoded device id', async () => {
  const { service, mock } = makeService();
  mock.onGet(`/devices/dc%3Ab4%3Ad9%3A13%3Aed%3A8c/incidents/${INCIDENT}`).reply(200, {
    chain_status: 'confirmed', owner_status: 'open', incentive: { deadline_at: '2026-10-03T10:30:00.000Z' },
  });
  await expect(service.getChainInfo('dc:b4:d9:13:ed:8c', INCIDENT)).resolves.toEqual({
    chainStatus: 'confirmed', ownerStatus: 'open', ackDeadlineAt: new Date('2026-10-03T10:30:00.000Z'),
  });
});

test('API and network failures stay errors, never a pending status', async () => {
  const { service, mock } = makeService();
  mock.onGet(`/devices/d1/incidents/${INCIDENT}`).reply(503, { error: 'down' });
  await expect(service.getChainInfo('d1', INCIDENT)).rejects.toEqual(new ApiException(503, 'down'));
  mock.onGet(`/devices/d2/incidents/${INCIDENT}`).networkError();
  await expect(service.getChainInfo('d2', INCIDENT)).rejects.toBeInstanceOf(NetworkException);
  mock.onGet(`/devices/d3/incidents/${INCIDENT}`).reply(200, 'not json');
  await expect(service.getChainInfo('d3', INCIDENT)).rejects.toBeInstanceOf(ApiException);
});

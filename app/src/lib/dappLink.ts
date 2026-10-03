import type { NotificationItem } from '../models/notification';

/** Build the MetaMask Mobile universal link from the canonical dApp URL. */
export function buildIncidentDappLink(
  apiBaseUrl: string,
  deviceId: string,
  incidentId: string,
): string {
  const api = new URL(apiBaseUrl);
  const canonical = new URL(
    `/dapp/d/${encodeURIComponent(deviceId)}/i/${encodeURIComponent(incidentId)}`,
    api.origin,
  );
  return `https://metamask.app.link/dapp/${canonical.host}${canonical.pathname}`;
}

const INCIDENT_ID = /^0x[0-9a-fA-F]{64}$/;

/** The incident an `incident.warning` / `incident.danger` notification points to, if valid. */
export function incidentTarget(
  item: Pick<NotificationItem, 'type' | 'deviceId' | 'payload'>,
): { deviceId: string; incidentId: string } | null {
  const incidentId = item.payload.incident_id;
  if (
    (item.type === 'incident.warning' || item.type === 'incident.danger') &&
    item.deviceId &&
    typeof incidentId === 'string' &&
    INCIDENT_ID.test(incidentId)
  ) {
    return { deviceId: item.deviceId, incidentId };
  }
  return null;
}

/** A notification tap has exactly one destination: dApp or existing device route. */
export function openNotificationDestination(
  item: Pick<NotificationItem, 'type' | 'deviceId' | 'payload'>,
  apiBaseUrl: string,
  openUrl: (url: string) => Promise<unknown>,
  openDevice: () => void,
): Promise<unknown> | void {
  const target = incidentTarget(item);
  if (target) {
    return openUrl(buildIncidentDappLink(apiBaseUrl, target.deviceId, target.incidentId));
  }
  openDevice();
}

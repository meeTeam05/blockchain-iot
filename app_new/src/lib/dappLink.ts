/** Build the MetaMask Mobile universal link for the nginx-hosted Task 5 dApp. */
export function buildIncidentDappLink(
  apiBaseUrl: string,
  deviceId: string,
  incidentId: string,
): string {
  const host = new URL(apiBaseUrl).host;
  const device = encodeURIComponent(deviceId);
  const incident = encodeURIComponent(incidentId);
  return `https://metamask.app.link/dapp/${host}/dapp/d/${device}/i/${incident}`;
}

export function openIncidentDappLink(
  event: { stopPropagation(): void },
  apiBaseUrl: string,
  deviceId: string,
  incidentId: string,
  openUrl: (url: string) => Promise<unknown>,
): Promise<unknown> {
  event.stopPropagation();
  return openUrl(buildIncidentDappLink(apiBaseUrl, deviceId, incidentId));
}

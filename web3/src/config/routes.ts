// Canonical public mount of the dApp (nginx `location /dapp/`, Vite `base`).
// The router must not silently become root-relative in test/dev modes where
// BASE_URL can be '/', so the basename is fixed here.
export const ROUTER_BASENAME = '/dapp'

export function incidentRoute(deviceId: string, incidentId: string) {
  return `/d/${encodeURIComponent(deviceId)}/i/${incidentId}`
}

export function verifyRoute(deviceId: string, incidentId: string) {
  return `/verify/${encodeURIComponent(deviceId)}/${incidentId}`
}

// Shareable B4 link: the current origin (never a hardcoded host) + /dapp base.
export function buildVerifyLink(origin: string, deviceId: string, incidentId: string) {
  return new URL(`${ROUTER_BASENAME}${verifyRoute(deviceId, incidentId)}`, origin).toString()
}

// Query keys shared between queries/ota.ts and services/otaReconciliation.ts,
// split out to avoid a require cycle between those two modules.
export const otaCatalogQueryKey = (deviceId: string) => ['ota-catalog', deviceId] as const;
export const otaProgressQueryKey = (deviceId: string) => ['ota-progress', deviceId] as const;

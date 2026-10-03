import { useQuery } from '@tanstack/react-query';
import { incidentService } from '../services/incidentService';
import { IncidentChainInfo } from '../models/incident';

export const incidentChainQueryKey = (deviceId: string, incidentId: string) =>
  ['incident-chain', deviceId, incidentId] as const;

// Settled incidents stop polling; everything else follows the indexer every 30 s.
export function incidentNeedsRefresh(info: IncidentChainInfo | undefined): boolean {
  if (!info) return true;
  if (info.ownerStatus === 'resolved') return false;
  return !['failed', 'blocked', 'legacy_domain', 'stale_signer'].includes(info.chainStatus ?? '');
}

export function useIncidentChainInfo(deviceId: string, incidentId: string) {
  return useQuery({
    queryKey: incidentChainQueryKey(deviceId, incidentId),
    queryFn: () => incidentService.getChainInfo(deviceId, incidentId),
    refetchInterval: (query) => (incidentNeedsRefresh(query.state.data) ? 30_000 : false),
  });
}

import { AxiosInstance, isAxiosError } from 'axios';
import { apiClient } from '../api/client';
import { ApiException, AppException, NetworkException } from '../api/appException';
import { IncidentChainInfo, parseIncidentChainInfo } from '../models/incident';

function mapError(err: unknown): AppException {
  if (isAxiosError(err)) {
    const data = err.response?.data;
    const body = data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : null;
    const message = typeof body?.error === 'string' ? body.error : (err.message ?? 'Request failed');
    if (!err.response) return new NetworkException(message);
    return new ApiException(err.response.status, message);
  }
  if (err instanceof Error) return new ApiException(0, err.message);
  return new ApiException(0, 'Unknown error');
}

// GET /api/devices/:id/incidents/:incidentId (docs/reference/API_REFERENCE.md 8a).
export class IncidentService {
  constructor(private readonly client: AxiosInstance) {}

  async getChainInfo(deviceId: string, incidentId: string): Promise<IncidentChainInfo> {
    try {
      const res = await this.client.get(
        `/devices/${encodeURIComponent(deviceId)}/incidents/${encodeURIComponent(incidentId)}`,
      );
      return parseIncidentChainInfo(res.data);
    } catch (err) {
      throw mapError(err);
    }
  }
}

export const incidentService = new IncidentService(apiClient);

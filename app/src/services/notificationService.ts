import { AxiosInstance, isAxiosError } from 'axios';
import { apiClient } from '../api/client';
import { ApiException, AppException, NetworkException } from '../api/appException';
import { NotificationItem, parseNotificationItem } from '../models/notification';

function bodyAsMapList(data: unknown): Record<string, unknown>[] {
  if (!Array.isArray(data)) {
    throw new ApiException(0, 'Unexpected server response');
  }
  return data.map((item) => {
    if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
      return item as Record<string, unknown>;
    }
    throw new ApiException(0, 'Unexpected server response');
  });
}

function mapError(err: unknown): AppException {
  if (isAxiosError(err)) {
    const status = err.response?.status ?? 0;
    const data = err.response?.data;
    const body = data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : null;
    const message = typeof body?.error === 'string' ? body.error : (err.message ?? 'Request failed');

    if (!err.response) {
      return new NetworkException(message);
    }
    return new ApiException(status, message);
  }
  return new ApiException(0, 'Unknown error');
}

export class NotificationService {
  constructor(private readonly client: AxiosInstance) {}

  async listNotifications(options: { beforeId?: string; limit?: number } = {}): Promise<NotificationItem[]> {
    try {
      const res = await this.client.get('/notifications', {
        params: {
          limit: options.limit ?? 50,
          ...(options.beforeId ? { before_id: options.beforeId } : {}),
        },
      });
      return bodyAsMapList(res.data).map(parseNotificationItem);
    } catch (err) {
      throw mapError(err);
    }
  }
}

export const notificationService = new NotificationService(apiClient);

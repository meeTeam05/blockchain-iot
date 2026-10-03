import { AxiosInstance, isAxiosError } from 'axios';
import { apiClient } from '../api/client';
import { ApiException, AppException } from '../api/appException';
import { Home, parseHome, Room, parseRoom } from '../models/home';

function bodyAsMap(data: unknown): Record<string, unknown> {
  if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
    return data as Record<string, unknown>;
  }
  throw new ApiException(0, 'Unexpected server response');
}

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
  if (err instanceof AppException) return err;
  if (isAxiosError(err)) {
    const status = err.response?.status;
    const body = err.response?.data;
    const msg =
      body !== null && typeof body === 'object' && typeof (body as Record<string, unknown>).error === 'string'
        ? ((body as Record<string, unknown>).error as string)
        : null;
    return new ApiException(status ?? 0, msg ?? 'Unknown error');
  }
  return new ApiException(0, 'Unknown error');
}

export class HomeService {
  constructor(private readonly client: AxiosInstance) {}

  async getHomes(): Promise<Home[]> {
    try {
      const res = await this.client.get('/homes');
      return bodyAsMapList(res.data).map(parseHome);
    } catch (err) {
      throw mapError(err);
    }
  }

  async createHome(name: string, timezone = 'Asia/Ho_Chi_Minh'): Promise<Home> {
    try {
      const res = await this.client.post('/homes', { name, timezone });
      return parseHome(bodyAsMap(res.data));
    } catch (err) {
      throw mapError(err);
    }
  }

  async updateHome(id: string, options: { name?: string } = {}): Promise<Home> {
    try {
      const res = await this.client.put(`/homes/${id}`, {
        ...(options.name !== undefined ? { name: options.name } : {}),
      });
      return parseHome(bodyAsMap(res.data));
    } catch (err) {
      throw mapError(err);
    }
  }

  async deleteHome(id: string): Promise<void> {
    try {
      await this.client.delete(`/homes/${id}`);
    } catch (err) {
      throw mapError(err);
    }
  }

  async getRooms(homeId: string): Promise<Room[]> {
    try {
      const res = await this.client.get(`/homes/${homeId}/rooms`);
      return bodyAsMapList(res.data).map(parseRoom);
    } catch (err) {
      throw mapError(err);
    }
  }

  async createRoom(homeId: string, name: string): Promise<Room> {
    try {
      const res = await this.client.post(`/homes/${homeId}/rooms`, { name });
      return parseRoom(bodyAsMap(res.data));
    } catch (err) {
      throw mapError(err);
    }
  }

  async updateRoom(roomId: string, options: { name?: string } = {}): Promise<Room> {
    try {
      const res = await this.client.put(`/rooms/${roomId}`, {
        ...(options.name !== undefined ? { name: options.name } : {}),
      });
      return parseRoom(bodyAsMap(res.data));
    } catch (err) {
      throw mapError(err);
    }
  }

  async deleteRoom(roomId: string): Promise<void> {
    try {
      await this.client.delete(`/rooms/${roomId}`);
    } catch (err) {
      throw mapError(err);
    }
  }

  async inviteMember(homeId: string, email: string, role = 'member'): Promise<void> {
    try {
      await this.client.post(`/homes/${homeId}/invite`, { email, role });
    } catch (err) {
      throw mapError(err);
    }
  }
}

export const homeService = new HomeService(apiClient);

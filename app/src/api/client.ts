import { create } from 'axios';
import { Env } from '../config/env';
import { SecureStorage } from '../storage/secureStorage';
import { attachAuthInterceptor } from './authInterceptor';

export const secureStorage = new SecureStorage();

// axios has one overall request timeout, unlike Dio's separate
// connect/send/receive timeouts — 10s covers the same intent.
export const apiClient = create({
  baseURL: Env.apiBaseUri.toString(),
  timeout: 10_000,
  headers: { 'Content-Type': 'application/json' },
});

attachAuthInterceptor(apiClient, secureStorage);

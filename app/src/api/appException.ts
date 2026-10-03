export abstract class AppException extends Error {}

/** No connectivity or request timed out. */
export class NetworkException extends AppException {
  constructor(message = 'Network error; check your connection') {
    super(message);
  }
}

/** API returned an error response (4xx / 5xx). */
export class ApiException extends AppException {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

/** 401 that could not be recovered by token refresh. */
export class AuthException extends AppException {
  constructor(message = 'Session expired; please log in again') {
    super(message);
  }
}

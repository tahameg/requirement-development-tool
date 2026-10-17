import type { ApiErrorCode } from '../shared/collab/types.js';

export const API_ERROR_HTTP_STATUS: Record<ApiErrorCode, number> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INTERNAL_ERROR: 500,
};

export class CollabServiceError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;

  constructor(code: ApiErrorCode, message: string) {
    super(message);
    this.name = 'CollabServiceError';
    this.code = code;
    this.status = API_ERROR_HTTP_STATUS[code];
  }
}

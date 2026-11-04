// One error shape for the whole API (D6): { error: { code, message, details? } }.

import { PortalError } from '../portal/client.js';

export class ApiError extends Error {
  constructor(status, code, message, { details, headers } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.headers = headers;
  }
}

// Seconds a client should wait when the portal is unavailable and no cached copy exists.
const DEFAULT_RETRY_AFTER_SECONDS = 30;

// Portal failure kind -> what our client sees (D6: gateway codes, only when no cache could answer).
function fromPortalError(err) {
  switch (err.kind) {
    case 'not_found':
      return new ApiError(404, 'not_found', 'The meter portal has no data for this resource.');
    case 'rate_limited':
    case 'auth_failed': {
      const seconds = err.retryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS;
      return new ApiError(503, 'upstream_unavailable', 'The meter portal is temporarily unavailable. Retry later.', {
        headers: { 'Retry-After': String(seconds) },
      });
    }
    case 'timeout':
      return new ApiError(504, 'upstream_timeout', 'The meter portal did not respond in time.');
    default: // unreachable, bad_response
      return new ApiError(502, 'upstream_error', 'The meter portal returned an unexpected response.');
  }
}

export function toApiError(err) {
  if (err instanceof ApiError) return err;
  if (err instanceof PortalError) return fromPortalError(err);
  // Errors Express itself raises for a bad request (e.g. a malformed %-encoding in the URL).
  if (Number.isInteger(err?.status) && err.status >= 400 && err.status < 500) {
    return new ApiError(400, 'validation_error', 'Malformed request.');
  }
  return new ApiError(500, 'internal_error', 'Something went wrong.');
}

// Any request no route matched.
export function notFoundHandler(req, _res, next) {
  next(new ApiError(404, 'not_found', `No route for ${req.method} ${req.path}.`));
}

// Express recognises error middleware by its four parameters, so "next" must stay even though it is unused.
export function errorHandler(err, req, res, _next) {
  const apiError = toApiError(err);
  if (apiError.status >= 500) {
    // Log what went wrong for us; the client only sees the safe message. Portal errors never carry secrets.
    console.error(`${req.method} ${req.originalUrl} -> ${apiError.status}:`, err instanceof PortalError ? `[${err.kind}] ${err.message}` : err);
  }
  if (apiError.headers) res.set(apiError.headers);
  const body = { code: apiError.code, message: apiError.message };
  if (apiError.details) body.details = apiError.details;
  res.status(apiError.status).json({ error: body });
}

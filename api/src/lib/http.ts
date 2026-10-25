// Errors that become a JSON response with one stable shape: { error: { code, message, details? } }.
// Messages are written for the person using the app: what happened and what to do.

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, code = "bad_request", details?: unknown) => new HttpError(400, code, message, details);
export const unauthorized = (message = "Sign in to continue", code = "unauthorized") => new HttpError(401, code, message);
export const forbidden = (message = "You don't have access to this", code = "forbidden") => new HttpError(403, code, message);
export const notFound = (message = "Not found") => new HttpError(404, "not_found", message);
export const conflict = (message: string, code = "conflict", details?: unknown) => new HttpError(409, code, message, details);
export const locked = (message: string, details?: unknown) => new HttpError(423, "locked", message, details);
export const tooMany = (message = "Too many attempts. Wait a minute and try again.") => new HttpError(429, "rate_limited", message);
export const unavailable = (message: string, code = "unavailable") => new HttpError(503, code, message);

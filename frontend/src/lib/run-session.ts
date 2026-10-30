export const RUN_SESSION_HEADER = "X-Session-Id";

export function isRunSessionId(value: unknown): value is string {
  return typeof value === "string" && value.length === 36 && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

/**
 * Require a canonical UUID v4 on every history/advisor request before any body,
 * cache, provider, or database work. Normalize hex case into one ownership/quota
 * key. Missing, combined, and malformed headers never select legacy NULL rows.
 */
export function readRunSession(request: Request): string {
  const sessionId = request.headers.get(RUN_SESSION_HEADER);
  if (!isRunSessionId(sessionId)) {
    throw new Error("X-Session-Id is required and must be a canonical UUID v4.");
  }
  return sessionId.toLowerCase();
}

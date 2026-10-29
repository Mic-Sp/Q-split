export const RUN_SESSION_HEADER = "X-Session-Id";

export function isRunSessionId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

/**
 * Read the optional opaque session token shared by history and advisor requests.
 * Missing headers select only legacy NULL rows, never all sessions. Reject invalid
 * or combined headers so malformed tokens cannot silently fall back to that bucket.
 */
export function readRunSession(request: Request): string | null {
  const sessionId = request.headers.get(RUN_SESSION_HEADER);
  if (sessionId !== null && !isRunSessionId(sessionId)) {
    throw new Error("X-Session-Id must contain 1–128 letters, digits, underscores, or hyphens.");
  }
  return sessionId;
}

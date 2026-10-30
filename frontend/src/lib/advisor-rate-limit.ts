import "server-only";
import { isIP } from "node:net";

export const ADVISOR_RATE_WINDOW_MS = 60_000;
export const ADVISOR_SESSION_LIMIT = 5;
export const ADVISOR_IP_LIMIT = 8;
const MAX_TRACKED_KEYS = 10_000;

type RateLimitDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

/**
 * Atomic, process-local session/IP sliding windows for outbound provider attempts.
 * Rejections never debit either bucket. Expired timestamps are pruned on access
 * and an unref'd sweep removes idle keys. A hard cap rejects new keys rather than
 * evicting active quotas, keeping memory bounded under high-cardinality traffic.
 */
export class AdvisorRateLimiter {
  private readonly buckets = new Map<string, number[]>();
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(private readonly now = () => performance.now(), private readonly maxKeys = MAX_TRACKED_KEYS) {
    this.timer = setInterval(() => this.cleanup(), ADVISOR_RATE_WINDOW_MS);
    this.timer.unref();
  }

  get size() { return this.buckets.size; }

  private prune(key: string, now: number) {
    const timestamps = (this.buckets.get(key) ?? []).filter(time => time > now - ADVISOR_RATE_WINDOW_MS);
    if (timestamps.length) this.buckets.set(key, timestamps);
    else this.buckets.delete(key);
    return timestamps;
  }

  cleanup(now = this.now()) {
    for (const key of this.buckets.keys()) this.prune(key, now);
  }

  /** Check both windows synchronously; call immediately before fetch, with no intervening await. */
  consume(sessionId: string | null, clientIp: string | null): RateLimitDecision {
    const now = this.now();
    const quotas = [
      { key: `session:${sessionId ?? "<missing>"}`, limit: ADVISOR_SESSION_LIMIT },
      { key: `ip:${clientIp ?? "<unknown>"}`, limit: ADVISOR_IP_LIMIT },
    ].map(quota => ({ ...quota, timestamps: this.prune(quota.key, now) }));
    let retryAfterMs = 0;
    for (const { timestamps, limit } of quotas) {
      if (timestamps.length >= limit) retryAfterMs = Math.max(retryAfterMs, timestamps[0] + ADVISOR_RATE_WINDOW_MS - now);
    }
    if (retryAfterMs > 0) return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) };

    const newKeys = quotas.filter(quota => !quota.timestamps.length).length;
    if (this.buckets.size + newKeys > this.maxKeys) {
      this.cleanup(now);
      if (this.buckets.size + newKeys > this.maxKeys) return { allowed: false, retryAfterSeconds: ADVISOR_RATE_WINDOW_MS / 1000 };
    }
    for (const { key, timestamps } of quotas) this.buckets.set(key, [...timestamps, now]);
    return { allowed: true };
  }

  clear() { this.buckets.clear(); }
  dispose() { clearInterval(this.timer); this.clear(); }
}

/**
 * Only Vercel's platform-controlled headers are trusted on Vercel deployments.
 * Never trust arbitrary X-Forwarded-For/Forwarded chains or a client-supplied
 * platform marker. Missing/invalid provenance uses the shared unknown-IP quota.
 */
export function readTrustedClientIp(headers: Headers): string | null {
  if (process.env.VERCEL !== "1") return null;
  const value = (headers.get("x-vercel-forwarded-for") ?? headers.get("x-real-ip"))?.trim();
  if (!value || value.includes("%") || !isIP(value)) return null;
  if (isIP(value) === 4) return value;
  // URL canonicalization folds IPv6 case/zero-compression variants into one key.
  const canonical = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(canonical);
  if (!mapped) return canonical;
  const high = parseInt(mapped[1], 16), low = parseInt(mapped[2], 16);
  return `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
}

// Retain warm-process quotas across development module reloads and both API aliases.
const processState = globalThis as unknown as { qSplitAdvisorRateLimiter?: AdvisorRateLimiter };
export const advisorRateLimiter = processState.qSplitAdvisorRateLimiter ??= new AdvisorRateLimiter();

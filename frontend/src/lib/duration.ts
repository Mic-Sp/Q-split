const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const rawNumber = new Intl.NumberFormat("en-US", { maximumFractionDigits: 20 });
const valid = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/**
 * Format a finite, nonnegative millisecond value for compact UI readouts.
 *
 * Unit selection uses the unrounded input: ms below 1s, seconds below 1m,
 * minutes/seconds below 1h, hours/minutes through exactly 24h, then days/hours.
 * Composite units floor completed units rather than rounding into the next range.
 * @param milliseconds Raw telemetry value; strings and invalid numbers are not coerced.
 * @returns A display string, or an em dash for missing/invalid data. Never use it in exports.
 */
export function formatDuration(milliseconds: unknown): string {
  if (!valid(milliseconds)) return "—";
  if (milliseconds < SECOND) return `${milliseconds.toFixed(2)} ms`;
  if (milliseconds < MINUTE) return `${(milliseconds / SECOND).toFixed(2)} s`;
  if (milliseconds < HOUR) return `${Math.floor(milliseconds / MINUTE)}m ${Math.floor(milliseconds / SECOND) % 60}s`;
  if (milliseconds <= DAY) return `${Math.floor(milliseconds / HOUR)}h ${Math.floor(milliseconds / MINUTE) % 60}m`;
  return `${Math.floor(milliseconds / DAY)}d ${Math.floor(milliseconds / HOUR) % 24}h`;
}

/**
 * Render an unshortened, localized millisecond hover readout.
 * @returns The numeric source value with an ms suffix, or an em dash for invalid data.
 * Keep raw numbers in CSV/JSON; this helper is presentation-only.
 */
export function formatRawMilliseconds(milliseconds: unknown): string {
  return valid(milliseconds) ? `${rawNumber.format(milliseconds)} ms` : "—";
}

/**
 * Format a signed latency change while preserving tiny nonzero differences.
 * Decreases retain a minus sign; magnitudes below 0.005 ms display <0.01 ms
 * instead of being mistaken for no change. Nonfinite inputs return an em dash.
 */
export function formatDurationDelta(milliseconds: number): string {
  if (!Number.isFinite(milliseconds)) return "—";
  const magnitude = Math.abs(milliseconds);
  const sign = milliseconds > 0 ? "+" : milliseconds < 0 ? "−" : "";
  // Keep real changes visible when two decimal places would round them to zero.
  return sign + (magnitude > 0 && magnitude < 0.005 ? "<0.01 ms" : formatDuration(magnitude));
}

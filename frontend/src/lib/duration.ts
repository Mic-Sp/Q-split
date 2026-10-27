const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const rawNumber = new Intl.NumberFormat("en-US", { maximumFractionDigits: 20 });
const valid = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/** Display units follow the unrounded duration; composite units keep completed seconds/minutes/hours. */
export function formatDuration(milliseconds: unknown): string {
  if (!valid(milliseconds)) return "—";
  if (milliseconds < SECOND) return `${milliseconds.toFixed(2)} ms`;
  if (milliseconds < MINUTE) return `${(milliseconds / SECOND).toFixed(2)} s`;
  if (milliseconds < HOUR) return `${Math.floor(milliseconds / MINUTE)}m ${Math.floor(milliseconds / SECOND) % 60}s`;
  if (milliseconds <= DAY) return `${Math.floor(milliseconds / HOUR)}h ${Math.floor(milliseconds / MINUTE) % 60}m`;
  return `${Math.floor(milliseconds / DAY)}d ${Math.floor(milliseconds / HOUR) % 24}h`;
}

/** Exact, unshortened source value for hover readouts. Never use display strings in exports. */
export function formatRawMilliseconds(milliseconds: unknown): string {
  return valid(milliseconds) ? `${rawNumber.format(milliseconds)} ms` : "—";
}

export function formatDurationDelta(milliseconds: number): string {
  if (!Number.isFinite(milliseconds)) return "—";
  const magnitude = Math.abs(milliseconds);
  const sign = milliseconds > 0 ? "+" : milliseconds < 0 ? "−" : "";
  // Keep real changes visible when two decimal places would round them to zero.
  return sign + (magnitude > 0 && magnitude < 0.005 ? "<0.01 ms" : formatDuration(magnitude));
}

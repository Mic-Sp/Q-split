import "server-only";
import { API_BASE_URL } from "./config";

/** Resolve the runtime engine URL for both simulation and startup health probes. */
export function engineUrl(): string {
  return (process.env.SIMULATION_API_URL?.trim() || API_BASE_URL).replace(/\/+$/, "");
}

/** Keep engine credentials on the server; never copy them from browser input. */
export function engineHeaders(): Record<string, string> {
  const secret = process.env.ENGINE_SECRET?.trim();
  return secret ? { "X-Engine-Secret": secret } : {};
}

/** Best-effort pre-warm with a bounded wait; an offline engine does not fail Next startup. */
export async function prewarmEngine(): Promise<boolean> {
  try {
    const response = await fetch(`${engineUrl()}/`, {
      cache: "no-store", signal: AbortSignal.timeout(3_000),
    });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

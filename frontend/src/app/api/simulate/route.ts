import { API_BASE_URL } from "@/lib/config";
import { parseSimulationRequest } from "@/lib/workloads";
import { parseTelemetry } from "@/lib/telemetry";

/**
 * Validate cockpit controls and proxy one uncached simulation to FastAPI.
 * Use the server URL override before the legacy public fallback, combine caller
 * cancellation with an 85-second deadline, and reject malformed/mismatched telemetry.
 * @returns JSON telemetry, HTTP 400/413 for invalid input, or 502 for lookup/schema failure.
 */
export async function POST(request: Request) {
  const headers = { "Cache-Control": "no-store" };
  let input;
  try {
    const text = await request.text();
    if (text.length > 4096) return Response.json({ detail: "Simulation request is too large." }, { status: 413, headers });
    input = parseSimulationRequest(JSON.parse(text));
  } catch {
    return Response.json({ detail: "Provide a valid workload, scale, hardware profile, capacity, and routing." }, { status: 400, headers });
  }
  try {
    const backend = (process.env.SIMULATION_API_URL?.trim() || API_BASE_URL).replace(/\/+$/, "");
    const response = await fetch(`${backend}/api/simulate`, { method: "POST", cache: "no-store",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(85_000)]) });
    const body = await response.json();
    if (!response.ok) return Response.json({ detail: typeof body?.detail === "string" ? body.detail : "The engine rejected this simulation." }, { status: response.status, headers });
    const telemetry = parseTelemetry(body);
    if (telemetry.workload_id !== input.workload_id) throw new Error("Workload mismatch.");
    return Response.json(telemetry, { headers });
  } catch {
    return Response.json({ detail: "Cannot reach the simulation engine or validate its response. Retry when the engine is available." }, { status: 502, headers });
  }
}

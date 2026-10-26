import { API_BASE_URL } from "@/lib/config";
import type { HybridTelemetryResponse, RoutingConfig, SimulationRequest } from "@/types/telemetry";

export const DEFAULT_ROUTING: RoutingConfig = {
  stage_1_node: "CPU", stage_2_node: "QPU", stage_3_node: "CPU",
};

export const PIPELINE = [
  { key: "stage_1_classical_pre", routingKey: "stage_1_node", label: "Classical preprocessing" },
  { key: "stage_2_quantum_kernel", routingKey: "stage_2_node", label: "Quantum kernel" },
  { key: "stage_3_classical_post", routingKey: "stage_3_node", label: "Classical postprocessing" },
] as const;

export function formatValue(value: unknown): string {
  if (value === undefined) return "—";
  if (typeof value === "number") return new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 }).format(value);
  return typeof value === "string" ? value : JSON.stringify(value) ?? "—";
}

export function totalLatency(data: HybridTelemetryResponse): number {
  return Object.values(data.stages).reduce((sum, stage) => sum + stage.latency_ms, 0);
}

export interface MetricDelta { label: string; before: string; after: string }
export interface Snapshot { request: SimulationRequest; data: HybridTelemetryResponse }
export interface Transition { id: number; before: Snapshot; after: Snapshot; changes: MetricDelta[] }

export function describeChanges(before: Snapshot, after: Snapshot): MetricDelta[] {
  const changes: MetricDelta[] = [];
  const add = (label: string, from: unknown, to: unknown) => {
    if (JSON.stringify(from) !== JSON.stringify(to)) changes.push({ label, before: formatValue(from), after: formatValue(to) });
  };
  add("Workload", before.data.workload_name, after.data.workload_name);
  add("Scale", before.data.scale_label, after.data.scale_label);
  add("Hardware", before.request.hardware_profile, after.request.hardware_profile);
  add("Execution mode", before.data.execution_mode, after.data.execution_mode);
  add("Primary bottleneck", before.data.primary_bottleneck, after.data.primary_bottleneck);
  add("Total latency (ms)", totalLatency(before.data), totalLatency(after.data));
  for (const { key, label } of PIPELINE) {
    const previous = before.data.stages[key];
    const current = after.data.stages[key];
    add(`${label} · node`, previous?.node, current?.node);
    add(`${label} · status`, previous?.status, current?.status);
    add(`${label} · latency (ms)`, previous?.latency_ms, current?.latency_ms);
    const keys = new Set([...Object.keys(previous?.metrics ?? {}), ...Object.keys(current?.metrics ?? {})]);
    for (const metric of keys) add(`${label} · ${metric.replaceAll("_", " ")}`, previous?.metrics[metric], current?.metrics[metric]);
  }
  return changes;
}

export function parseTelemetry(value: unknown): HybridTelemetryResponse {
  if (!value || typeof value !== "object") throw new Error("The engine returned an invalid telemetry response.");
  const data = value as HybridTelemetryResponse;
  if (![data.workload_id, data.workload_name, data.scale_label, data.primary_bottleneck].every((v) => typeof v === "string") ||
      !["LIVE_QISKIT_AER", "NISQ_ANALYTICAL_PROFILER"].includes(data.execution_mode) ||
      !data.stages || typeof data.stages !== "object" || Array.isArray(data.stages)) {
    throw new Error("The engine returned an unexpected telemetry schema.");
  }
  for (const { key } of PIPELINE) {
    const stage = data.stages[key];
    if (!stage) throw new Error(`The engine returned invalid telemetry for ${key}.`);
  }
  for (const [key, stage] of Object.entries(data.stages)) {
    if (!stage || !["CPU", "GPU", "QPU"].includes(stage.node) || typeof stage.name !== "string" || typeof stage.output_summary !== "string" ||
        typeof stage.latency_ms !== "number" || !Number.isFinite(stage.latency_ms) ||
        !["OPTIMAL", "WARNING", "CRITICAL_BOTTLENECK"].includes(stage.status) ||
        !stage.metrics || typeof stage.metrics !== "object" || Array.isArray(stage.metrics)) {
      throw new Error(`The engine returned invalid telemetry for ${key}.`);
    }
  }
  return data;
}

export async function simulate(request: SimulationRequest, signal: AbortSignal): Promise<HybridTelemetryResponse> {
  const response = await fetch(`${API_BASE_URL}/api/simulate`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request), signal,
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = body && typeof body === "object" && "detail" in body ? body.detail : null;
    throw new Error(typeof detail === "string" ? `${detail} (HTTP ${response.status})` : `Simulation failed (HTTP ${response.status}). Please try again.`);
  }
  const data = parseTelemetry(body);
  // Older deployments may silently ignore unknown request fields. Do not show
  // their fixed-route response as a successful custom routing simulation.
  for (const { key, routingKey } of PIPELINE) {
    const expected = request.routing?.[routingKey] ?? DEFAULT_ROUTING[routingKey];
    if (data.stages[key].node !== expected) {
      throw new Error("The engine did not honor the selected stage routing. Use an updated backend and retry.");
    }
  }
  return data;
}

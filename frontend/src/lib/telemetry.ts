import { formatDuration, formatRawMilliseconds } from "@/lib/duration";
import { pipelineTiming } from "@/lib/kpi-metrics";
import { HARDWARE_PROFILES, hardwareLabel } from "@/lib/hardware-profiles";
import type { HardwareProfile, HybridTelemetryResponse, RoutingConfig, SimulationRequest, WorkloadId } from "@/types/telemetry";
import { workloadThresholds } from "@/lib/workloads";

export const DEFAULT_ROUTING: RoutingConfig = {
  stage_1_node: "CPU", stage_2_node: "QPU", stage_3_node: "CPU",
};
export const DEFAULT_AVAILABLE_QUBITS = 133;

export const qubitThresholds = workloadThresholds;

/**
 * Resolve profile-click defaults: native reference count or the active ideal tier ceiling.
 * Call only for explicit profile selection; snapshot restoration must preserve its saved capacity.
 */
export function hardwareDefaultQubits(profile: HardwareProfile, scale: number, workload: WorkloadId = "shors_crypto"): number {
  return HARDWARE_PROFILES[profile].referenceQubits ?? qubitThresholds(scale, workload).ceiling;
}

export const PIPELINE = [
  { key: "stage_1_classical_pre", routingKey: "stage_1_node", label: "Classical preprocessing" },
  { key: "stage_2_quantum_kernel", routingKey: "stage_2_node", label: "Quantum kernel" },
  { key: "stage_3_classical_post", routingKey: "stage_3_node", label: "Classical postprocessing" },
] as const;

/**
 * Render generic metric values for display, keeping numeric/BigInt formatting out of raw exports.
 */
export function formatValue(value: unknown): string {
  if (value === undefined) return "—";
  if (typeof value === "number" || typeof value === "bigint") return new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 }).format(value);
  return typeof value === "string" ? value : JSON.stringify(value) ?? "—";
}

/**
 * Sum the stage latency fields for the legacy persisted summary.
 * This excludes separately reported QPU preparation/readout. Use pipelineTiming
 * for cockpit, benchmark, and CSV wall-clock totals including exclusive QPU I/O.
 */
export function totalLatency(data: HybridTelemetryResponse): number {
  return Object.values(data.stages).reduce((sum, stage) => sum + stage.latency_ms, 0);
}

export interface MetricDelta { label: string; before: string; after: string; beforeRaw?: string; afterRaw?: string }
export interface Snapshot { id: string; completedAt: string; request: SimulationRequest; data: HybridTelemetryResponse }
export interface Transition { id: number; before: Snapshot; after: Snapshot; changes: MetricDelta[] }

/**
 * Compare immutable completed-run snapshots before applying display formatting.
 * The union of metric keys includes added/removed fields; raw comparisons retain
 * changes hidden by rounded readouts. Duration deltas include unshortened hover
 * values, and total latency uses full wall-clock accounting rather than stage sums.
 */
export function describeChanges(before: Snapshot, after: Snapshot): MetricDelta[] {
  const changes: MetricDelta[] = [];
  const add = (label: string, from: unknown, to: unknown, duration = false) => {
    if (JSON.stringify(from) !== JSON.stringify(to)) changes.push({ label,
      before: duration ? formatDuration(from) : formatValue(from), after: duration ? formatDuration(to) : formatValue(to),
      ...(duration ? { beforeRaw: formatRawMilliseconds(from), afterRaw: formatRawMilliseconds(to) } : {}),
    });
  };
  add("Workload", before.data.workload_name, after.data.workload_name);
  add("Scale", before.data.scale_label, after.data.scale_label);
  add("Hardware", hardwareLabel(before.request.hardware_profile), hardwareLabel(after.request.hardware_profile));
  add("Available QPU qubits", before.request.available_qubits, after.request.available_qubits);
  add("Execution mode", before.data.execution_mode, after.data.execution_mode);
  add("Primary bottleneck", before.data.primary_bottleneck, after.data.primary_bottleneck);
  add("Total latency", pipelineTiming(before.data).totalMs, pipelineTiming(after.data).totalMs, true);
  for (const { key, label } of PIPELINE) {
    const previous = before.data.stages[key];
    const current = after.data.stages[key];
    add(`${label} · node`, previous?.node, current?.node);
    add(`${label} · status`, previous?.status, current?.status);
    add(`${label} · latency`, previous?.latency_ms, current?.latency_ms, true);
    const keys = new Set([...Object.keys(previous?.metrics ?? {}), ...Object.keys(current?.metrics ?? {})]);
    for (const metric of keys) add(`${label} · ${metric.replace(/_ms$/, "").replaceAll("_", " ")}`, previous?.metrics[metric], current?.metrics[metric], metric.endsWith("_ms"));
  }
  return changes;
}

/**
 * Check the engine's structural response contract while retaining workload-specific metrics.
 * Requires all stage keys, known nodes/statuses, finite times, and metric objects;
 * it does not prune diagnostics or replace the advisor's stricter trust boundary.
 * @throws Error For missing stages or malformed telemetry.
 */
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

/**
 * Submit one captured configuration through the same-origin simulation proxy.
 * Validate the response and verify echoed workload, stage placement, and QPU kernel
 * capacity so older backends cannot silently present fixed routing as custom work.
 * @param signal Caller-owned cancellation/deadline signal.
 * @throws Error For HTTP, schema, or requested-control conformance failures.
 */
export async function simulate(request: SimulationRequest, signal: AbortSignal): Promise<HybridTelemetryResponse> {
  const response = await fetch("/api/simulate", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request), signal,
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = body && typeof body === "object" && "detail" in body ? body.detail : null;
    throw new Error(typeof detail === "string" ? `${detail} (HTTP ${response.status})` : `Simulation failed (HTTP ${response.status}). Please try again.`);
  }
  const data = parseTelemetry(body);
  if (data.workload_id !== request.workload_id) throw new Error("The engine did not honor the selected workload. Use an updated backend and retry.");
  // Older deployments may silently ignore unknown request fields. Do not show
  // their fixed-route response as a successful custom routing simulation.
  for (const { key, routingKey } of PIPELINE) {
    const expected = request.routing?.[routingKey] ?? DEFAULT_ROUTING[routingKey];
    if (data.stages[key].node !== expected) {
      throw new Error("The engine did not honor the selected stage routing. Use an updated backend and retry.");
    }
    if (expected === "QPU" && key === "stage_2_quantum_kernel" && request.available_qubits !== undefined &&
        data.stages[key].metrics.available_qubits !== request.available_qubits) {
      throw new Error("The engine did not honor the selected QPU capacity. Use an updated backend and retry.");
    }
  }
  return data;
}

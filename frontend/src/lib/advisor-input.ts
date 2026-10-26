import "server-only";
import { DEFAULT_AVAILABLE_QUBITS, DEFAULT_ROUTING, PIPELINE, totalLatency } from "@/lib/telemetry";
import type { AdvisorRequest } from "@/types/advisor";
import type { CompletedRun } from "@/types/run-history";
import type { HybridTelemetryResponse, RoutingConfig, SimulationRequest, StageTelemetry } from "@/types/telemetry";

export const ADVISOR_BODY_LIMIT = 65_536;
const MAX_QUBITS = 2_147_483_647; // Matches FastAPI's positive int32 capacity contract.
const SCALES = [15, 21, 35, 512, 2048];
const TIERS = ["Space-Optimized Sequential", "Windowed Parallel", "Carry-Lookahead Parallel",
  "Blocked · insufficient capacity", "Blocked · upstream stage unavailable", "Unavailable · unsupported QPU route"];
const DEPTHS = ["O(n^3)", "O(n^2 log n)", "O(n log^2 n)", "Not executed"];
const BOTTLENECKS = ["NONE", "INSUFFICIENT QPU QUBIT CAPACITY", "UNSUPPORTED QPU ROUTING",
  "CPU STATEVECTOR MEMORY LIMIT", "GPU STATEVECTOR MEMORY LIMIT", "CPU STATEVECTOR EMULATION OVERHEAD",
  "GPU STATEVECTOR EMULATION OVERHEAD", "GPU LAUNCH/TRANSFER OVERHEAD", "NISQ TWO-QUBIT GATE NOISE",
  "CATASTROPHIC QPU DECOHERENCE", "CLASSICAL SIMULATION RAM WALL"];

function invalid(): never { throw new Error("Invalid advisor request."); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function clean(value: unknown, maxLength = 100): string {
  if (typeof value !== "string" || value.length > maxLength) invalid();
  return value.normalize("NFKC").replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, "").trim();
}

function choice<T extends string>(value: unknown, allowed: readonly T[]): T {
  const token = clean(value);
  if (!allowed.includes(token as T)) invalid();
  return token as T;
}

function number(value: unknown, minimum: number, maximum: number, integer = false): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum ||
      (integer && !Number.isSafeInteger(value))) invalid();
  return value;
}

// Only fixed-size primitive fields survive. Never copy arbitrary metric objects,
// measurement strings, descriptions, prompt text, or saved advisor output.
function metrics(value: unknown): StageTelemetry["metrics"] {
  const source = object(value);
  const result: StageTelemetry["metrics"] = {};
  const numeric = [
    ["qubits_required", 1, MAX_QUBITS, true], ["available_qubits", 1, MAX_QUBITS, true],
    ["qubits_allocated", 0, MAX_QUBITS, true], ["minimum_qubits_required", 1, MAX_QUBITS, true],
    ["idle_qubits", 0, MAX_QUBITS, true], ["circuit_depth", 0, Number.MAX_SAFE_INTEGER, true],
    ["coherence_survival_pct", 0, 100, false], ["io_state_prep_ms", 0, Number.MAX_SAFE_INTEGER, false],
    ["launch_transfer_overhead_ms", 0, Number.MAX_SAFE_INTEGER, false], ["compute_latency_factor", 0, Number.MAX_SAFE_INTEGER, false],
    ["statevector_memory_budget_gib", 1, Number.MAX_SAFE_INTEGER, false],
  ] as const;
  for (const [key, min, max, integer] of numeric) {
    if (Object.hasOwn(source, key)) result[key] = number(source[key], min, max, integer);
  }
  for (const key of ["routing_supported", "execution_feasible", "parallel_speedup_ceiling_reached"]) {
    if (Object.hasOwn(source, key)) {
      if (typeof source[key] !== "boolean") invalid();
      result[key] = source[key];
    }
  }
  if (Object.hasOwn(source, "parallelization_tier")) result.parallelization_tier = choice(source.parallelization_tier, TIERS);
  if (Object.hasOwn(source, "depth_complexity")) result.depth_complexity = choice(source.depth_complexity, DEPTHS);
  return result;
}

function validateRun(value: unknown): CompletedRun {
  const run = object(value);
  const id = clean(run.id, 50).toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) invalid();
  const completedAt = clean(run.completedAt, 50);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(completedAt) || !Number.isFinite(Date.parse(completedAt))) invalid();
  const config = object(run.request);
  const routing: RoutingConfig = { ...DEFAULT_ROUTING };
  if (config.routing != null) {
    const source = object(config.routing);
    if (Object.keys(source).some((key) => !Object.hasOwn(DEFAULT_ROUTING, key))) invalid();
    for (const key of Object.keys(DEFAULT_ROUTING) as (keyof RoutingConfig)[]) {
      if (Object.hasOwn(source, key)) routing[key] = choice(source[key], ["CPU", "GPU", "QPU"]);
    }
  }
  const scale = number(config.scale_param, 15, 2048, true);
  if (!SCALES.includes(scale)) invalid();
  const request: SimulationRequest = {
    workload_id: choice(config.workload_id, ["shors_crypto", "quantum_mips"]),
    scale_param: scale,
    hardware_profile: choice(config.hardware_profile, ["ibm_heron_nisq", "ideal_sim"]),
    available_qubits: config.available_qubits === undefined ? DEFAULT_AVAILABLE_QUBITS : number(config.available_qubits, 1, MAX_QUBITS, true),
    routing,
  };
  const source = object(run.telemetry);
  if (choice(source.workload_id, ["shors_crypto", "quantum_mips"]) !== request.workload_id) invalid();
  const stages = object(source.stages);
  if (Object.keys(stages).length !== PIPELINE.length || PIPELINE.some(({ key }) => !Object.hasOwn(stages, key))) invalid();
  const normalized: Record<string, StageTelemetry> = {};
  for (const { key, routingKey, label } of PIPELINE) {
    const stage = object(stages[key]);
    const node = choice(stage.node, ["CPU", "GPU", "QPU"]);
    if (node !== routing[routingKey]) invalid();
    for (const field of ["name", "output_summary"]) if (stage[field] !== undefined && typeof stage[field] !== "string") invalid();
    const numeric = metrics(stage.metrics);
    if (node === "QPU" && numeric.available_qubits !== undefined && numeric.available_qubits !== request.available_qubits) invalid();
    const available = numeric.available_qubits ?? request.available_qubits;
    for (const field of ["qubits_allocated", "idle_qubits"]) {
      if (typeof numeric[field] === "number" && numeric[field] > (available as number)) invalid();
    }
    normalized[key] = { name: label, node,
      latency_ms: number(stage.latency_ms, 0, Number.MAX_SAFE_INTEGER),
      status: choice(stage.status, ["OPTIMAL", "WARNING", "CRITICAL_BOTTLENECK"]),
      output_summary: "", metrics: numeric };
  }
  for (const field of ["workload_name", "scale_label"]) if (source[field] !== undefined && typeof source[field] !== "string") invalid();
  // Dynamic explanations are deliberately discarded; only a recognized fixed
  // reason reaches the model or the deterministic fallback.
  const reason = clean(source.primary_bottleneck, ADVISOR_BODY_LIMIT);
  const bottleneck = BOTTLENECKS.find((prefix) => reason === prefix || reason.startsWith(`${prefix} (`)) ?? "UNCLASSIFIED BOTTLENECK";
  const n = scale === 512 || scale === 2048 ? scale : Math.ceil(Math.log2(scale));
  const telemetry: HybridTelemetryResponse = {
    workload_id: request.workload_id,
    workload_name: request.workload_id === "shors_crypto" ? "Shor's Factoring Pipeline" : "Quantum-MIPS AI",
    scale_label: scale >= 512 ? `RSA-${scale}` : `N = ${scale} (${n}-bit Composite Integer)`,
    execution_mode: choice(source.execution_mode, ["LIVE_QISKIT_AER", "NISQ_ANALYTICAL_PROFILER"]),
    primary_bottleneck: bottleneck, stages: normalized,
  };
  if (totalLatency(telemetry) > Number.MAX_SAFE_INTEGER) invalid();
  return { id, completedAt, request, telemetry };
}

export function validateAdvisorRequest(value: unknown): AdvisorRequest {
  const input = object(value);
  return { current: validateRun(input.current), ...(input.previous === undefined ? {} : { previous: validateRun(input.previous) }) };
}

export function advisorDigest(run: CompletedRun) {
  // Safe even when called independently of the route's pre-flight parser.
  run = validateRun(run);
  return { request: run.request, telemetry: {
    execution_mode: run.telemetry.execution_mode,
    primary_bottleneck: run.telemetry.primary_bottleneck,
    total_latency_ms: totalLatency(run.telemetry),
    stages: Object.fromEntries(PIPELINE.map(({ key }) => {
      const stage = run.telemetry.stages[key];
      return [key, { node: stage.node, status: stage.status, latency_ms: stage.latency_ms, metrics: stage.metrics }];
    })),
  } };
}

export class AdvisorPayloadTooLarge extends Error {}

export async function readAdvisorRequest(request: Request): Promise<AdvisorRequest> {
  const length = request.headers.get("content-length");
  if (length !== null) {
    if (!/^\d+$/.test(length)) invalid();
    if (Number(length) > ADVISOR_BODY_LIMIT) throw new AdvisorPayloadTooLarge();
  }
  if (!request.body) invalid();
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const parts: string[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > ADVISOR_BODY_LIMIT) {
        throw new AdvisorPayloadTooLarge();
      }
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  return validateAdvisorRequest(JSON.parse(parts.join("")));
}

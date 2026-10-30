import "server-only";
import { DEFAULT_AVAILABLE_QUBITS, DEFAULT_ROUTING, PIPELINE, totalLatency } from "@/lib/telemetry";
import type { AdvisorRequest } from "@/types/advisor";
import type { CompletedRun } from "@/types/run-history";
import type { HybridTelemetryResponse, RoutingConfig, SimulationRequest, StageTelemetry } from "@/types/telemetry";
import { HARDWARE_PROFILE_IDS } from "@/types/telemetry";
import { HARDWARE_PROFILES } from "@/lib/hardware-profiles";
import { WORKLOADS, validWorkloadScale, workloadScaleLabel } from "@/lib/workloads";
import { pipelineTiming } from "@/lib/kpi-metrics";

export const ADVISOR_BODY_LIMIT = 65_536;
export const ADVISOR_TEXT_LIMIT = 100;
// Covers supported RSA/slow trapped-ion projections without admitting years of latency.
export const ADVISOR_MAX_LATENCY_MS = 30 * 24 * 60 * 60 * 1000;
export const ADVISOR_MAX_CIRCUIT_DEPTH = 100_000_000_000;
const MAX_QUBITS = 2_147_483_647; // Matches FastAPI's positive int32 capacity contract.
const TIERS = ["Sequential Minimum", "Multi-Oracle Ceiling", "Blocked · statevector memory", "Space-Optimized Sequential", "Windowed Parallel", "Carry-Lookahead Parallel",
  "Blocked · insufficient capacity", "Blocked · upstream stage unavailable", "Unavailable · unsupported QPU route"];
const DEPTHS = ["O(n^3)", "O(n^2 log n)", "O(n log^2 n)", "Not executed"];
const BOTTLENECKS = ["NONE", "INSUFFICIENT QPU QUBIT CAPACITY", "UNSUPPORTED QPU ROUTING",
  "CPU STATEVECTOR MEMORY LIMIT", "GPU STATEVECTOR MEMORY LIMIT", "CPU STATEVECTOR EMULATION OVERHEAD",
  "GPU STATEVECTOR EMULATION OVERHEAD", "GPU LAUNCH/TRANSFER OVERHEAD", "NISQ TWO-QUBIT GATE NOISE",
  "CATASTROPHIC QPU DECOHERENCE", "QPU COHERENCE BUDGET DEGRADED", "CLASSICAL SIMULATION RAM WALL"];

function invalid(): never { throw new Error("Invalid advisor request."); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

/**
 * Bound and normalize a string while removing control and invisible direction-changing characters.
 */
function clean(value: unknown, maxLength = ADVISOR_TEXT_LIMIT): string {
  if (typeof value !== "string" || value.length > maxLength) invalid();
  const normalized = value.normalize("NFKC").replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, "").trim();
  if (normalized.length > maxLength) invalid();
  return normalized;
}

/** Bound untrusted explanatory text before fixed-vocabulary classification; never forward it verbatim. */
export function sanitizeAdvisorText(value: unknown): string {
  if (typeof value !== "string") invalid();
  return value.normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, " ")
    .replace(/<\|[^>]{0,100}\|>|\[\/?INST\]|<<\/?SYS>>/gi, "")
    .replace(/\b(?:SYSTEM|ASSISTANT|USER|DEVELOPER|TOOL)\s*:/gi, "")
    .replace(/[<>{}\[\]`]/g, "")
    .replace(/\s+/g, " ").trim().slice(0, ADVISOR_TEXT_LIMIT);
}

/**
 * Accept only a bounded normalized enum token; arbitrary explanatory text never becomes a model fact.
 */
function choice<T extends string>(value: unknown, allowed: readonly T[]): T {
  const token = clean(value);
  if (!allowed.includes(token as T)) invalid();
  return token as T;
}

/**
 * Coerce only complete, bounded JSON-style decimal strings. Reject booleans,
 * arrays, whitespace, hex, partial numbers, non-finite values, and unsafe integers.
 */
function number(value: unknown, minimum: number, maximum: number, integer = false): number {
  if (typeof value === "string") {
    if (value.length > 32 || value.trim() !== value || !/^(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)) invalid();
    value = Number(value);
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum ||
      (integer && !Number.isSafeInteger(value))) invalid();
  return value;
}

// Only fixed-size primitive fields survive. Never copy arbitrary metric objects,
// measurement strings, descriptions, prompt text, or saved advisor output.
/**
 * Rebuild an allowlisted, bounded primitive metric digest from untrusted telemetry.
 * Drop nested dictionaries, measurement text, and unknown fields rather than
 * forwarding possible instructions. A blocked MIPS depth multiplier may be null
 * and is omitted, not coerced to a misleading numeric factor.
 */
function metrics(value: unknown): StageTelemetry["metrics"] {
  const source = object(value);
  const result: StageTelemetry["metrics"] = {};
  const numeric = [
    ["index_bits", 1, 31, true], ["candidate_count", 1, 1048576, true], ["grover_iterations", 0, 10000, true],
    ["statevector_qubits", 0, MAX_QUBITS, true], ["planned_qubits", 0, MAX_QUBITS, true],
    ["compute_latency_ms", 0, ADVISOR_MAX_LATENCY_MS, false], ["depth_multiplier", 0, 1, false],
    ["measured_peak_probability", 0, 1, false], ["aer_runtime_ms", 0, ADVISOR_MAX_LATENCY_MS, false],
    ["qubits_required", 1, MAX_QUBITS, true], ["available_qubits", 1, MAX_QUBITS, true],
    ["qubits_allocated", 0, MAX_QUBITS, true], ["minimum_qubits_required", 1, MAX_QUBITS, true],
    ["idle_qubits", 0, MAX_QUBITS, true], ["circuit_depth", 0, ADVISOR_MAX_CIRCUIT_DEPTH, true],
    ["coherence_survival_pct", 0, 100, false], ["io_state_prep_ms", 0, 60_000, false],
    ["launch_transfer_overhead_ms", 0, 60_000, false], ["compute_latency_factor", 0, 1000, false],
    ["statevector_memory_budget_gib", 1, 65_536, false],
    ["reference_circuit_depth", 0, ADVISOR_MAX_CIRCUIT_DEPTH, true], ["reference_qubits", 1, MAX_QUBITS, true],
    ["routing_depth_multiplier", 0, 1, false], ["gate_time_multiplier", 0, 180, false],
    ["coherence_decay_scale", 1, 1_000_000_000, false], ["io_readout_ms", 0, 60_000, false],
  ] as const;
  for (const [key, min, max, integer] of numeric) {
    if (Object.hasOwn(source, key) && !(key === "depth_multiplier" && source[key] === null)) result[key] = number(source[key], min, max, integer);
  }
  for (const key of ["routing_supported", "execution_feasible", "parallel_speedup_ceiling_reached", "aer_executed", "retrieval_reliable"]) {
    if (Object.hasOwn(source, key)) {
      if (typeof source[key] !== "boolean") invalid();
      result[key] = source[key];
    }
  }
  if (Object.hasOwn(source, "parallelization_tier")) result.parallelization_tier = choice(source.parallelization_tier, TIERS);
  if (Object.hasOwn(source, "depth_complexity")) result.depth_complexity = choice(source.depth_complexity, DEPTHS);
  if (Object.hasOwn(source, "hardware_architecture")) result.hardware_architecture = choice(source.hardware_architecture, HARDWARE_PROFILE_IDS);
  if (Object.hasOwn(source, "connectivity_topology")) result.connectivity_topology = choice(source.connectivity_topology, ["Heavy-Hex", "2D Square Grid", "All-to-All Ion Trap", "Noise-free reference"]);
  return result;
}

/**
 * Validate identity/configuration and rebuild trusted workload/architecture context.
 * Stage display text and dynamic bottleneck explanations are discarded; labels and
 * recognized reason prefixes are reconstructed. QPU allocation is capacity-bounded,
 * while classical emulation may legitimately use its own larger minimum register.
 * @throws Error For malformed metrics, configuration, or telemetry disagreement.
 */
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
  const workload = choice(config.workload_id, ["shors_crypto", "quantum_mips"]);
  const scale = number(config.scale_param, 1, 1048576, true);
  if (!validWorkloadScale(workload, scale)) invalid();
  const request: SimulationRequest = {
    workload_id: workload,
    scale_param: scale,
    hardware_profile: choice(config.hardware_profile, HARDWARE_PROFILE_IDS),
    available_qubits: config.available_qubits === undefined ? DEFAULT_AVAILABLE_QUBITS : number(config.available_qubits, 1, MAX_QUBITS, true),
    routing,
  };
  // Derive trusted labels/architecture from validated selectors; never trust caller-supplied explanatory prose.
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
    if (node === "QPU" && numeric.hardware_architecture !== undefined && numeric.hardware_architecture !== request.hardware_profile) invalid();
    if (node === "QPU") {
      const architecture = HARDWARE_PROFILES[request.hardware_profile];
      for (const [key, expected] of Object.entries({ connectivity_topology: architecture.topology,
        reference_qubits: architecture.referenceQubits, routing_depth_multiplier: architecture.depthMultiplier,
        gate_time_multiplier: architecture.gateTimeMultiplier, coherence_decay_scale: architecture.decayScale })) {
        if (numeric[key] !== undefined && numeric[key] !== expected) invalid();
      }
    }
    if (node === "QPU" && numeric.available_qubits !== undefined && numeric.available_qubits !== request.available_qubits) invalid();
    const available = numeric.available_qubits ?? request.available_qubits;
    // Physical capacity bounds QPU allocation, not CPU/GPU RAM-backed emulation of a minimum register.
    for (const field of ["qubits_allocated", "idle_qubits"]) {
      if (typeof numeric[field] === "number" && node === "QPU" && numeric[field] > (available as number)) invalid();
    }
    if (node === "QPU" && typeof numeric.qubits_allocated === "number" && typeof numeric.idle_qubits === "number" &&
        numeric.qubits_allocated + numeric.idle_qubits > (available as number)) invalid();
    normalized[key] = { name: WORKLOADS[workload].stages[PIPELINE.findIndex(stage => stage.key === key)] ?? label, node,
      latency_ms: number(stage.latency_ms, 0, ADVISOR_MAX_LATENCY_MS),
      status: choice(stage.status, ["OPTIMAL", "WARNING", "CRITICAL_BOTTLENECK"]),
      output_summary: "", metrics: numeric };
  }
  for (const field of ["workload_name", "scale_label"]) if (source[field] !== undefined && typeof source[field] !== "string") invalid();
  // Dynamic explanations are deliberately discarded; only a recognized fixed
  // reason reaches the model or the deterministic fallback.
  const reason = sanitizeAdvisorText(source.primary_bottleneck);
  const bottleneck = BOTTLENECKS.find((prefix) => reason === prefix || reason.startsWith(`${prefix} (`) || reason.startsWith(`${prefix}:`)) ?? "UNCLASSIFIED BOTTLENECK";
  const telemetry: HybridTelemetryResponse = {
    workload_id: request.workload_id,
    workload_name: WORKLOADS[workload].label,
    scale_label: workloadScaleLabel(scale, workload),
    execution_mode: choice(source.execution_mode, ["LIVE_QISKIT_AER", "NISQ_ANALYTICAL_PROFILER"]),
    primary_bottleneck: bottleneck, stages: normalized,
  };
  if (totalLatency(telemetry) > ADVISOR_MAX_LATENCY_MS || pipelineTiming(telemetry).totalMs > ADVISOR_MAX_LATENCY_MS) invalid();
  return { id, completedAt, request, telemetry };
}

/**
 * Validate current/optional previous completed runs before cache or provider work.
 * Reject cross-workload comparisons at the server boundary, independently of the
 * UI's session scoping. Return pruned runs, not the original input objects.
 */
export function validateAdvisorRequest(value: unknown): AdvisorRequest {
  const input = object(value);
  const current = validateRun(input.current);
  const previous = input.previous === undefined ? undefined : validateRun(input.previous);
  if (previous && previous.request.workload_id !== current.request.workload_id) invalid();
  return { current, ...(previous ? { previous } : {}) };
}

/**
 * Produce a small trusted AI/cache digest, even when called outside the route parser.
 * Revalidate the run, attach registry-owned architecture constants, and compute
 * wall-clock total with QPU I/O. Never include arbitrary stage prose or saved AI text.
 */
export function advisorDigest(run: CompletedRun) {
  // Safe even when called independently of the route's pre-flight parser.
  run = validateRun(run);
  const { label, topology, referenceQubits, depthMultiplier, gateTimeMultiplier, prepMs, decayScale } = HARDWARE_PROFILES[run.request.hardware_profile];
  const architecture = { label, topology, referenceQubits, depthMultiplier, gateTimeMultiplier, prepMs, decayScale };
  return { request: run.request, architecture, telemetry: {
    execution_mode: run.telemetry.execution_mode,
    primary_bottleneck: run.telemetry.primary_bottleneck,
    total_latency_ms: pipelineTiming(run.telemetry).totalMs,
    stages: Object.fromEntries(PIPELINE.map(({ key }) => {
      const stage = run.telemetry.stages[key];
      return [key, { node: stage.node, status: stage.status, latency_ms: stage.latency_ms, metrics: stage.metrics }];
    })),
  } };
}

/**
 * Distinguish byte-limit violations (HTTP 413) from ordinary invalid requests (HTTP 400).
 */
export class AdvisorPayloadTooLarge extends Error {}

/**
 * Read bounded UTF-8 JSON incrementally before validating the advisor contract.
 * Check both advertised length and actual bytes so missing/chunked/multibyte bodies
 * cannot evade the 64 KiB ceiling. Streaming decoding preserves split code points;
 * cancel/release the reader on failures without invoking a provider or database.
 * @throws AdvisorPayloadTooLarge For an advertised or actual oversized payload.
 * @throws Error For malformed UTF-8, JSON, or completed-run schema.
 */
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

import type { Prisma, SimulationRun } from "@/generated/prisma/client";
import { DEFAULT_ROUTING, parseTelemetry, PIPELINE, totalLatency } from "@/lib/telemetry";
import type { CompletedRun, SavedSimulationRun } from "@/types/run-history";
import type { SimulationRequest, StageStatus } from "@/types/telemetry";
import { parseAdvisorInsight } from "@/lib/advisor";
import { validWorkloadScale } from "@/lib/workloads";
import { isHardwareProfile } from "@/lib/hardware-profiles";

function invalid(message: string): never {
  throw new Error(message);
}

/**
 * Validate an optional nonnegative safe integer; keep absent summary metrics null rather than zero.
 */
function optionalInteger(value: unknown, label: string, max: number): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) invalid(`Invalid ${label}.`);
  return value;
}

/**
 * Validate a completed run and derive the immutable Prisma create payload.
 * Cross-check workload, route, and QPU capacity against telemetry before persistence.
 * Store full JSON beside summaries, convert safe circuit depths to BigInt, and bind
 * optional advisor output to the same run UUID. Snapshot metadata is changed elsewhere.
 * @throws Error For malformed IDs, configuration/telemetry mismatches, or invalid metrics.
 */
export function createRunRecord(value: unknown): Prisma.SimulationRunCreateInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("A completed simulation object is required.");
  const run = value as CompletedRun;
  if (typeof run.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(run.id)) invalid("A valid run UUID is required.");
  if (typeof run.completedAt !== "string" || !Number.isFinite(Date.parse(run.completedAt))) invalid("A valid completion timestamp is required.");
  const request = run.request;
  if (!request || !validWorkloadScale(request.workload_id, request.scale_param) ||
      !isHardwareProfile(request.hardware_profile) ||
      !Number.isSafeInteger(request.scale_param) || request.scale_param < 1 || request.scale_param > 2_147_483_647) invalid("Invalid simulation configuration.");
  if (request.routing != null && (typeof request.routing !== "object" || Array.isArray(request.routing) ||
      Object.keys(request.routing).some((key) => !Object.prototype.hasOwnProperty.call(DEFAULT_ROUTING, key)) ||
      Object.values(request.routing).some((node) => !["CPU", "GPU", "QPU"].includes(node)))) invalid("Invalid node routing.");
  if (request.available_qubits !== undefined && (!Number.isSafeInteger(request.available_qubits) ||
      request.available_qubits < 1 || request.available_qubits > 2_147_483_647)) invalid("Invalid available qubits.");
  const routing = { ...DEFAULT_ROUTING, ...request.routing };
  const telemetry = parseTelemetry(run.telemetry);
  if (telemetry.workload_id !== request.workload_id) invalid("Workload metadata does not match telemetry.");
  for (const { key, routingKey } of PIPELINE) {
    if (telemetry.stages[key].node !== routing[routingKey]) invalid("Node routing does not match telemetry.");
    if (key === "stage_2_quantum_kernel" && telemetry.stages[key].node === "QPU" && request.available_qubits !== undefined &&
        telemetry.stages[key].metrics.available_qubits !== request.available_qubits) invalid("QPU capacity does not match telemetry.");
  }
  const stages = Object.values(telemetry.stages);
  if (stages.some((stage) => stage.latency_ms < 0)) invalid("Latency cannot be negative.");
  // Preserve the legacy stage-sum summary; benchmark wall-clock math reads full telemetry for QPU I/O.
  const latency = totalLatency(telemetry);
  if (!Number.isFinite(latency)) invalid("Invalid total latency.");
  const quantum = telemetry.stages.stage_2_quantum_kernel.metrics;
  const qubits = optionalInteger(quantum.qubits_required, "qubit count", 2_147_483_647);
  const depth = optionalInteger(quantum.circuit_depth, "circuit depth", Number.MAX_SAFE_INTEGER);
  const coherence = quantum.coherence_survival_pct ?? null;
  if (coherence !== null && (typeof coherence !== "number" || !Number.isFinite(coherence) || coherence < 0 || coherence > 100)) invalid("Invalid coherence percentage.");
  const bottleneckStatus: StageStatus = stages.some((stage) => stage.status === "CRITICAL_BOTTLENECK")
    ? "CRITICAL_BOTTLENECK" : stages.some((stage) => stage.status === "WARNING") || !telemetry.primary_bottleneck.startsWith("NONE")
      ? "WARNING" : "OPTIMAL";
  return {
    id: run.id, completedAt: new Date(run.completedAt),
    workloadId: request.workload_id, workloadName: telemetry.workload_name,
    scaleParam: request.scale_param, scaleLabel: telemetry.scale_label,
    hardwareProfile: request.hardware_profile,
    stage1Node: routing.stage_1_node, stage2Node: routing.stage_2_node, stage3Node: routing.stage_3_node,
    executionMode: telemetry.execution_mode, totalLatencyMs: latency,
    bottleneckStatus, primaryBottleneck: telemetry.primary_bottleneck,
    qubitsRequired: qubits, circuitDepth: depth === null ? null : BigInt(depth),
    coherenceSurvivalPct: coherence as number | null,
    requestPayload: { workload_id: request.workload_id, scale_param: request.scale_param, hardware_profile: request.hardware_profile, routing,
      ...(request.available_qubits === undefined ? {} : { available_qubits: request.available_qubits }),
    } as Prisma.InputJsonValue,
    telemetry: telemetry as unknown as Prisma.InputJsonValue,
    ...(run.advisorInsight === undefined ? {} : { advisorInsight: parseAdvisorInsight(run.advisorInsight, run.id) as unknown as Prisma.InputJsonValue }),
  };
}

/**
 * Convert Prisma Date/BigInt values to the public JSON history contract.
 * Keep full request/telemetry JSON and optional legacy advisor metrics; snapshot
 * fields missing from historical rows receive compatible null/false defaults.
 */
export function serializeRun(run: SimulationRun): SavedSimulationRun {
  return {
    id: run.id, completedAt: run.completedAt.toISOString(), createdAt: run.createdAt.toISOString(),
    workloadId: run.workloadId, workloadName: run.workloadName,
    scaleParam: run.scaleParam, scaleLabel: run.scaleLabel, hardwareProfile: run.hardwareProfile,
    stage1Node: run.stage1Node, stage2Node: run.stage2Node, stage3Node: run.stage3Node,
    executionMode: run.executionMode, totalLatencyMs: run.totalLatencyMs,
    bottleneckStatus: run.bottleneckStatus, primaryBottleneck: run.primaryBottleneck,
    qubitsRequired: run.qubitsRequired, circuitDepth: run.circuitDepth?.toString() ?? null,
    coherenceSurvivalPct: run.coherenceSurvivalPct,
    request: run.requestPayload as unknown as SimulationRequest,
    telemetry: run.telemetry as unknown as SavedSimulationRun["telemetry"],
    advisorInsight: run.advisorInsight ? parseAdvisorInsight(run.advisorInsight, run.id) : null,
    snapshotName: run.snapshotName ?? null, isSnapshot: run.isSnapshot ?? false,
    snapshotUpdatedAt: run.snapshotUpdatedAt?.toISOString() ?? null,
  };
}

import { formatValue, PIPELINE, qubitThresholds } from "@/lib/telemetry";
import { architectureTradeOff, hardwareLabel } from "@/lib/hardware-profiles";
import { pipelineTiming } from "@/lib/kpi-metrics";
import { formatDuration, formatDurationDelta } from "@/lib/duration";
import type { CompletedRun } from "@/types/run-history";
import type { AdvisorInsight, AdvisorSections, FallbackReason } from "@/types/advisor";
import { parseAdvisorTelemetry, parseAdvisorUsage, zeroUsage } from "@/lib/advisor-telemetry";

export function parseAdvisorSections(value: unknown): AdvisorSections {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid advisor diagnostic.");
  const result = value as AdvisorSections;
  const fields = [result.routingDiagnosis, result.spaceTimeTradeOff, result.optimizationRecommendation];
  if (fields.some((field) => typeof field !== "string" || !field.trim() || field.length > 2000)) throw new Error("Invalid advisor sections.");
  return { routingDiagnosis: result.routingDiagnosis.trim(), spaceTimeTradeOff: result.spaceTimeTradeOff.trim(), optimizationRecommendation: result.optimizationRecommendation.trim() };
}

export function parseAdvisorInsight(value: unknown, runId: string): AdvisorInsight {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid advisor insight.");
  const insight = value as AdvisorInsight;
  if (insight.runId !== runId || !["gemini", "cached", "fallback"].includes(insight.source) ||
      typeof insight.generatedAt !== "string" || !Number.isFinite(Date.parse(insight.generatedAt)) ||
      (insight.previousRunId !== null && (typeof insight.previousRunId !== "string" || !/^[0-9a-f-]{36}$/i.test(insight.previousRunId))) ||
      (insight.model !== null && (typeof insight.model !== "string" || !/^[a-zA-Z0-9._-]{1,100}$/.test(insight.model))) ||
      (insight.notice !== null && (typeof insight.notice !== "string" || insight.notice.length > 500)) ||
      (insight.fallbackReason !== null && !["missing_key", "rate_limited", "timeout", "provider_error", "invalid_response", "network_error"].includes(insight.fallbackReason)) ||
      (["gemini", "cached"].includes(insight.source) && (!insight.model || insight.fallbackReason !== null)) ||
      (insight.cacheKey !== undefined && (typeof insight.cacheKey !== "string" || !/^[a-f0-9]{64}$/.test(insight.cacheKey))) ||
      (insight.source === "fallback" && !insight.fallbackReason)) throw new Error("Invalid advisor metadata.");
  const usage = insight.usage === undefined ? undefined : parseAdvisorUsage(insight.usage);
  if (insight.source === "fallback" && usage && usage.totalTokens !== 0) throw new Error("Invalid fallback usage.");
  const telemetry = insight.telemetry === undefined ? undefined : parseAdvisorTelemetry(insight.telemetry, insight.source, usage);
  return { runId, previousRunId: insight.previousRunId, source: insight.source, model: insight.model,
    generatedAt: insight.generatedAt, fallbackReason: insight.fallbackReason, notice: insight.notice,
    sections: parseAdvisorSections(insight.sections), ...(insight.cacheKey === undefined ? {} : { cacheKey: insight.cacheKey }),
    ...(usage ? { usage } : {}), ...(telemetry ? { telemetry } : {}) };
}

const notices: Record<FallbackReason, string> = {
  missing_key: "Gemini is not configured. Add GEMINI_API_KEY on the server. Showing a deterministic local diagnostic.",
  rate_limited: "Gemini is rate-limited. Showing a deterministic local diagnostic; retry analysis later.",
  timeout: "Gemini took too long to respond. Showing a deterministic local diagnostic.",
  provider_error: "Gemini is temporarily unavailable or its configuration was rejected. Showing a deterministic local diagnostic.",
  invalid_response: "Gemini returned a diagnostic that did not pass validation. Showing a deterministic local diagnostic.",
  network_error: "The AI advisor could not be reached. Showing a deterministic local diagnostic.",
};

export function deterministicInsight(current: CompletedRun, previous: CompletedRun | undefined, reason: FallbackReason): AdvisorInsight {
  const { request, telemetry } = current;
  const stages = PIPELINE.map(({ key }) => telemetry.stages[key]);
  const quantum = stages[1];
  const m = quantum.metrics;
  const thresholds = qubitThresholds(request.scale_param);
  const available = request.available_qubits ?? m.available_qubits;
  const unsupported = stages.some((stage, index) => index !== 1 && stage.node === "QPU");
  const memoryBlocked = quantum.node !== "QPU" && m.execution_feasible === false;
  const capacityBlocked = stages.some((stage) => stage.node === "QPU" && typeof available === "number" && available < thresholds.minimum);
  const route = stages.map((stage) => stage.node).join(" → ");
  const problems = stages.filter((stage) => stage.status !== "OPTIMAL").map((stage) => `${stage.name}: ${stage.status}`).join("; ");
  let recommendation: string;
  if (unsupported) recommendation = "Move classical preprocessing and postprocessing to CPU; this profiler has no QPU implementation for those routines. Keep QPU placement for period finding, then rerun to remove unsupported-route starvation.";
  else if (capacityBlocked) recommendation = `Increase available QPU capacity to at least ${formatValue(thresholds.minimum)} qubits. Try ${formatValue(thresholds.windowed)} for Windowed Parallel or ${formatValue(thresholds.ceiling)} for the Carry-Lookahead ceiling, then rerun with the same scale to compare depth and coherence.`;
  else if (memoryBlocked) recommendation = `Route the quantum kernel to QPU with at least ${formatValue(thresholds.minimum)} available qubits; CPU/GPU statevector RAM grows exponentially. If capacity is unavailable, reduce the target scale. More QPU capacity does not enlarge CPU/GPU RAM.`;
  else if (quantum.node === "QPU" && typeof available === "number" && available < thresholds.ceiling) recommendation = `Try ${formatValue(available < thresholds.windowed ? thresholds.windowed : thresholds.ceiling)} available qubits to enter the next parallelization tier. Keep CPU preprocessing/postprocessing fixed and compare circuit depth, latency, and coherence survival.`;
  else if (quantum.node === "QPU" && request.hardware_profile === "ionq_forte_trapped_ion") recommendation = "Compare Google Weber (2D Grid) or IBM Heron at the same capacity and routing to isolate the 180× trapped-ion gate-time penalty. All-to-all SWAP savings and long coherence do not guarantee lower wall-clock time. Use Ideal Noise-Free to isolate noise; idle qubits past the ceiling do not help.";
  else if (quantum.node === "QPU" && request.hardware_profile !== "ideal_sim") recommendation = "Capacity is at the parallel speedup ceiling. Compare the Ideal Noise-Free profile to isolate decoherence, or reduce scale for NISQ survival. Extra idle qubits cannot reduce depth further; the ideal profile is a projection, not error-corrected hardware.";
  else if (stages.some((stage, index) => index !== 1 && stage.node === "GPU")) recommendation = "Try CPU placement for the short classical pre/post routines: modeled GPU launch/transfer overhead can dominate these kernels. Compare total latency with the same scale and quantum routing.";
  else recommendation = "Compare CPU → QPU → CPU with classical kernel emulation at the same scale. Keep capacity at the carry-lookahead ceiling when using QPU; extra qubits provide no further modeled speedup. Compare total pipeline latency, not only QPU time.";
  const delta = previous
    ? ` Previous ${previous.telemetry.scale_label}: total ${formatDuration(pipelineTiming(previous.telemetry).totalMs)} → ${formatDuration(pipelineTiming(telemetry).totalMs)} (Δ ${formatDurationDelta(pipelineTiming(telemetry).totalMs - pipelineTiming(previous.telemetry).totalMs)}).${previous.request.hardware_profile !== request.hardware_profile ? ` Hardware changed from ${hardwareLabel(previous.request.hardware_profile)} to ${hardwareLabel(request.hardware_profile)}.` : ""}${previous.request.scale_param !== request.scale_param ? " Scale also changed; this is not an isolated hardware-speedup comparison." : ""}` : "";
  const spaceTime = quantum.node === "QPU"
    ? `Minimum ${formatValue(thresholds.minimum)} qubits (2n + 3; N = 15 uses 8). Allocated / available: ${formatValue(m.qubits_allocated)} / ${formatValue(available)}. Tier: ${formatValue(m.parallelization_tier)}; depth ${formatValue(m.circuit_depth)} (${formatValue(m.depth_complexity)}), QPU latency ${formatDuration(quantum.latency_ms)}, coherence ${formatValue(m.coherence_survival_pct)}%. Sequential / Windowed / Carry-Lookahead use minimum / 3n / ceil(5.5n) qubits. Capacity above ${formatValue(thresholds.ceiling)} stays idle. ${architectureTradeOff(request.hardware_profile)}`
    : `The quantum kernel is emulated on ${quantum.node}; QPU capacity and ancilla tiers do not change this classical statevector path. Baseline width ${formatValue(m.qubits_required)} qubits; depth ${formatValue(m.circuit_depth)}; kernel latency ${formatDuration(quantum.latency_ms)}. Its relevant limit is CPU/GPU statevector memory, not physical QPU coherence; the selected architecture does not change CPU/GPU execution.`;
  return { runId: current.id, previousRunId: previous?.id ?? null, source: "fallback", model: null,
    usage: zeroUsage(),
    generatedAt: new Date().toISOString(), fallbackReason: reason, notice: notices[reason], sections: {
      routingDiagnosis: `${telemetry.scale_label}, ${request.hardware_profile}: ${route}. Primary bottleneck: ${telemetry.primary_bottleneck}. ${unsupported ? "Classical host routines cannot execute on QPU. " : ""}${memoryBlocked ? "Statevector memory grows as 16 × 2^q bytes. " : ""}${stages.some((stage) => stage.node === "GPU") ? "GPU timings include illustrative launch/transfer overhead, not measured PCIe throughput. " : ""}${problems || "All stages report optimal status."}${delta}`,
      spaceTimeTradeOff: spaceTime.trim(),
      optimizationRecommendation: recommendation,
    } };
}

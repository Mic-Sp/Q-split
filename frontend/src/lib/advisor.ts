import { mipsRoutingContext, preferredMipsHost } from "@/lib/workloads";
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
  previous = previous?.request.workload_id === current.request.workload_id ? previous : undefined;
  const { request, telemetry } = current;
  const stages = PIPELINE.map(({ key }) => telemetry.stages[key]);
  const quantum = stages[1];
  const m = quantum.metrics;
  const mips = request.workload_id === "quantum_mips";
  const thresholds = qubitThresholds(request.scale_param, request.workload_id);
  const available = request.available_qubits ?? m.available_qubits;
  const unsupported = stages.some((stage, index) => index !== 1 && stage.node === "QPU");
  const memoryBlocked = quantum.node !== "QPU" && m.execution_feasible === false;
  const capacityBlocked = stages.some((stage) => stage.node === "QPU" && typeof available === "number" && available < thresholds.minimum);
  const route = stages.map((stage) => stage.node).join(" → ");
  const problems = stages.filter((stage) => stage.status !== "OPTIMAL").map((stage) => `${stage.name}: ${stage.status}`).join("; ");
  let recommendation: string;
  if (mips) recommendation = mipsRecommendation(current, thresholds, unsupported, capacityBlocked, memoryBlocked);
  else if (unsupported) recommendation = "Move classical preprocessing and postprocessing to CPU; this profiler has no QPU implementation for those routines. Keep QPU placement for period finding, then rerun to remove unsupported-route starvation.";
  else if (capacityBlocked) recommendation = `Increase available QPU capacity to at least ${formatValue(thresholds.minimum)} qubits. Try ${formatValue(thresholds.windowed)} for Windowed Parallel or ${formatValue(thresholds.ceiling)} for the Carry-Lookahead ceiling, then rerun with the same scale to compare depth and coherence.`;
  else if (memoryBlocked) recommendation = `Route the quantum kernel to QPU with at least ${formatValue(thresholds.minimum)} available qubits; CPU/GPU statevector RAM grows exponentially. If capacity is unavailable, reduce the target scale. More QPU capacity does not enlarge CPU/GPU RAM.`;
  else if (quantum.node === "QPU" && typeof available === "number" && available < thresholds.ceiling) recommendation = `Try ${formatValue(available < thresholds.windowed ? thresholds.windowed : thresholds.ceiling)} available qubits to enter the next parallelization tier. Keep CPU preprocessing/postprocessing fixed and compare circuit depth, latency, and coherence survival.`;
  else if (quantum.node === "QPU" && request.hardware_profile === "ionq_forte_trapped_ion") recommendation = "Compare Google Weber (2D Grid) or IBM Heron at the same capacity and routing to isolate the 180× trapped-ion gate-time penalty. All-to-all SWAP savings and long coherence do not guarantee lower wall-clock time. Use Ideal Noise-Free to isolate noise; idle qubits past the ceiling do not help.";
  else if (quantum.node === "QPU" && request.hardware_profile !== "ideal_sim") recommendation = "Capacity is at the parallel speedup ceiling. Compare the Ideal Noise-Free profile to isolate decoherence, or reduce scale for NISQ survival. Extra idle qubits cannot reduce depth further; the ideal profile is a projection, not error-corrected hardware.";
  else if (stages.some((stage, index) => index !== 1 && stage.node === "GPU")) recommendation = "Try CPU placement for the short classical pre/post routines: modeled GPU launch/transfer overhead can dominate these kernels. Compare total latency with the same scale and quantum routing.";
  else recommendation = "Compare CPU → QPU → CPU with classical kernel emulation at the same scale. Keep capacity at the carry-lookahead ceiling when using QPU; extra qubits provide no further modeled speedup. Compare total pipeline latency, not only QPU time.";
  const delta = previous
    ? ` Previous ${previous.telemetry.scale_label}: total ${formatDuration(pipelineTiming(previous.telemetry).totalMs)} → ${formatDuration(pipelineTiming(telemetry).totalMs)} (Δ ${formatDurationDelta(pipelineTiming(telemetry).totalMs - pipelineTiming(previous.telemetry).totalMs)}).${previous.request.hardware_profile !== request.hardware_profile ? ` Hardware changed from ${hardwareLabel(previous.request.hardware_profile)} to ${hardwareLabel(request.hardware_profile)}.` : ""}${previous.request.workload_id !== request.workload_id ? " Workload changed; cross-workload timings are not an isolated speedup comparison." : previous.request.scale_param !== request.scale_param ? " Scale also changed; this is not an isolated hardware-speedup comparison." : ""}` : "";
  const spaceTime = mips ? mipsSpaceTime(current, thresholds) : quantum.node === "QPU"
    ? `Minimum ${formatValue(thresholds.minimum)} qubits (2n + 3; N = 15 uses 8). Allocated / available: ${formatValue(m.qubits_allocated)} / ${formatValue(available)}. Tier: ${formatValue(m.parallelization_tier)}; depth ${formatValue(m.circuit_depth)} (${formatValue(m.depth_complexity)}), QPU latency ${formatDuration(quantum.latency_ms)}, coherence ${formatValue(m.coherence_survival_pct)}%. Sequential / Windowed / Carry-Lookahead use minimum / 3n / ceil(5.5n) qubits. Capacity above ${formatValue(thresholds.ceiling)} stays idle. ${architectureTradeOff(request.hardware_profile)}`
    : `The quantum kernel is emulated on ${quantum.node}; QPU capacity and ancilla tiers do not change this classical statevector path. Baseline width ${formatValue(m.qubits_required)} qubits; depth ${formatValue(m.circuit_depth)}; kernel latency ${formatDuration(quantum.latency_ms)}. Its relevant limit is CPU/GPU statevector memory, not physical QPU coherence; the selected architecture does not change CPU/GPU execution.`;
  return { runId: current.id, previousRunId: previous?.id ?? null, source: "fallback", model: null,
    usage: zeroUsage(),
    generatedAt: new Date().toISOString(), fallbackReason: reason, notice: notices[reason], sections: {
      routingDiagnosis: `${mips ? mipsRoutingContext(request.scale_param) + " " : ""}${telemetry.scale_label}, ${request.hardware_profile}: ${route}. Primary bottleneck: ${telemetry.primary_bottleneck}. ${unsupported ? "Classical host routines cannot execute on QPU. " : ""}${memoryBlocked ? "Statevector memory grows as 16 × 2^q bytes. " : ""}${stages.some((stage) => stage.node === "GPU") ? "GPU timings include illustrative launch/transfer overhead, not measured PCIe throughput. " : ""}${problems || "All stages report optimal status."}${delta}`,
      spaceTimeTradeOff: spaceTime.trim(),
      optimizationRecommendation: recommendation,
    } };
}

function mipsRecommendation(current: CompletedRun, thresholds: ReturnType<typeof qubitThresholds>, unsupported: boolean, capacityBlocked: boolean, memoryBlocked: boolean) {
  const { request, telemetry } = current;
  const kernel = telemetry.stages.stage_2_quantum_kernel;
  const host = preferredMipsHost(request.scale_param);
  const route = `${host} → QPU → ${host}`;
  if (unsupported) return `Move LSH pruning and FP16 reranking to ${host}; those classical routines have no QPU implementation. Use ${route}, then reassess quantum capacity and coherence.`;
  if (capacityBlocked) return `Increase available QPU capacity to at least ${formatValue(thresholds.minimum)} (k + 4) qubits; try ${formatValue(thresholds.windowed)} for Windowed or ${formatValue(thresholds.ceiling)} for Multi-Oracle. Keep host stages on ${host} and compare coherence before claiming viable retrieval.`;
  if (memoryBlocked) return `Route Stage 02 to QPU with at least ${formatValue(thresholds.minimum)} qubits, or choose Sequential/reduce scale to fit CPU/GPU RAM. Quantum-MIPS emulation uses the selected ancilla tier: 16 × 2^allocated_qubits bytes, within 16 GiB CPU / 8 GiB GPU. Prefer ${host} host stages.`;
  if (telemetry.stages.stage_1_classical_pre.node !== host || telemetry.stages.stage_3_classical_post.node !== host) return `Try ${route}: ${request.scale_param === 64 ? "CPU avoids each 0.30 ms GPU PCIe penalty on tiny LSH/FP16 batches" : "GPU uses 0.12× LSH and 0.10× FP16 compute time, amortizing each 0.30 ms transfer"}. Keep scale, hardware and capacity fixed to compare total latency; verify QPU coherence separately.`;
  if (kernel.node !== "QPU") return `Compare ${route} against the current deterministic classical emulation at the same scale. QPU requires at least ${formatValue(thresholds.minimum)} qubits and a viable coherence budget; this marked-state model does not establish practical LLM retrieval advantage.`;
  const available = request.available_qubits ?? kernel.metrics.available_qubits;
  if (typeof available === "number" && available < thresholds.ceiling) return `Try ${formatValue(available < thresholds.windowed ? thresholds.windowed : thresholds.ceiling)} available qubits for the next tier; Multi-Oracle at ${formatValue(thresholds.ceiling)} reduces sequential depth to 0.20×. Keep ${route} and compare coherence: O(√M) Grover iterations can still exhaust NISQ budgets.`;
  if (request.hardware_profile === "ionq_forte_trapped_ion") return "Compare a superconducting profile at the same Multi-Oracle capacity and routing to isolate the trapped-ion 180× gate latency penalty. Long coherence and all-to-all connectivity do not guarantee lower total latency; extra qubits above the ceiling stay idle.";
  return `Keep ${route}. At the Multi-Oracle ceiling, extra qubits are idle; reduce M or compare IonQ Forte's longer coherence window against its 180× gate-time penalty. Ideal Noise-Free isolates modeled noise and does not represent physical error correction. O(√M) iterations still grow with scale.`;
}

function mipsSpaceTime(current: CompletedRun, thresholds: ReturnType<typeof qubitThresholds>) {
  const { request, telemetry } = current;
  const kernel = telemetry.stages.stage_2_quantum_kernel, m = kernel.metrics;
  const prefix = `k = ceil(log2 M) = ${Math.ceil(Math.log2(request.scale_param))}. Sequential k+4 / Windowed 2k+8 / Multi-Oracle 4k+16 require ${thresholds.minimum} / ${thresholds.windowed} / ${thresholds.ceiling} qubits; depth factors 1.00× / 0.40× / 0.20×. Tier: ${formatValue(m.parallelization_tier)}; allocated ${formatValue(m.qubits_allocated)}, depth ${formatValue(m.circuit_depth)}. `;
  if (kernel.node !== "QPU") return prefix + `Classical ${kernel.node} emulation keeps 100% deterministic coherence and uses the selected tier's register RAM (16 × 2^q bytes), within 16 GiB CPU / 8 GiB GPU. Physical QPU capacity and topology do not limit this path, but selecting more ancillas increases statevector RAM.`;
  return prefix + `O(√M) Grover iterations rapidly erode NISQ coherence at large vector scales; Multi-Oracle depth reduction or long-coherence hardware can improve survival without guaranteeing viability. Modeled coherence ${formatValue(m.coherence_survival_pct)}%; gate latency ${formatDuration(kernel.latency_ms)}. Capacity above ${thresholds.ceiling} is idle. ${architectureTradeOff(request.hardware_profile)} ${m.aer_executed === true ? "M = 64 Sequential executes a noise-free marked-state Aer reference; measured peak probability and CPU simulator time are separate from hardware projections." : "Analytical marked-candidate projection; no vector loading or adaptive maximum-finding oracle was executed."}`;
}

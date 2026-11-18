import { mipsRoutingContext, preferredMipsHost } from "@/lib/workloads";
import { formatValue, PIPELINE, qubitThresholds } from "@/lib/telemetry";
import { customBaselineLabel } from "@/lib/custom-profile";
import { architectureTradeOff, hardwareLabel } from "@/lib/hardware-profiles";
import { pipelineTiming } from "@/lib/kpi-metrics";
import { formatDuration, formatDurationDelta } from "@/lib/duration";
import type { CompletedRun } from "@/types/run-history";
import type { AdvisorInsight, AdvisorSections, FallbackReason } from "@/types/advisor";
import { parseAdvisorTelemetry, parseAdvisorUsage, zeroUsage } from "@/lib/advisor-telemetry";
import { sameModelVersion } from "@/lib/model-version";
import { inverseDesignRecommendation } from "@/lib/inverse-design";
import { GQE_MODE_LABELS, GQE_SURVIVAL_SCOPE, parseGqeParameters } from "@/lib/gqe";
import { parseSkqdParameters, formatBytes } from "@/lib/skqd";

/**
 * Read persisted/local diagnostic sections with legacy-compatible length bounds.
 * Live provider output additionally passes validateGeneratedSections; accepting old
 * history here must not silently weaken the current generation/cache policy.
 */
export function parseAdvisorSections(value: unknown): AdvisorSections {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid advisor diagnostic.");
  const result = value as AdvisorSections;
  const fields = [result.routingDiagnosis, result.spaceTimeTradeOff, result.optimizationRecommendation];
  if (fields.some((field) => typeof field !== "string" || !field.trim() || field.length > 2000)) throw new Error("Invalid advisor sections.");
  return { routingDiagnosis: result.routingDiagnosis.trim(), spaceTimeTradeOff: result.spaceTimeTradeOff.trim(), optimizationRecommendation: result.optimizationRecommendation.trim() };
}

/**
 * Bind saved insight metadata to its run and validate provenance/accounting fields.
 * Allow absent usage/lookup fields for older history; require source/model/fallback
 * metadata to agree and keep original usage distinct from current lookup telemetry.
 */
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

/**
 * Explain completed telemetry using executable local workload/architecture rules.
 * Discard a foreign-workload previous run, prioritize blockers over tuning, and
 * produce zero-provider-usage fallback sections. The same recommendation grounds
 * live AI prompts, so provider and offline paths share supported control choices.
 */
export function deterministicInsight(current: CompletedRun, previous: CompletedRun | undefined, reason: FallbackReason): AdvisorInsight {
  previous = previous?.request.workload_id === current.request.workload_id && sameModelVersion(previous.telemetry, current.telemetry) ? previous : undefined;
  if (current.request.workload_id === "gqe") return gqeInsight(current, previous, reason);
  if (current.request.workload_id === "skqd") return skqdInsight(current, previous, reason);
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
  else if (quantum.node === "QPU" && request.hardware_profile === "ftqc_surface_code") recommendation = "Keep capacity at the parallelization ceiling. Compare IBM Heron at the same scale, capacity and routing to isolate logical error suppression against the 27 µs lattice-surgery gate penalty; compare native classical latency before claiming speedup. Reduce scale to lower logical operation error and gate latency.";
  else if (quantum.node === "QPU" && request.hardware_profile !== "ideal_sim") recommendation = "Capacity is at the parallel speedup ceiling. Compare the Ideal Noise-Free profile to isolate decoherence, or reduce scale for NISQ survival. Extra idle qubits cannot reduce depth further; the ideal profile is a projection, not error-corrected hardware.";
  else if (stages.some((stage, index) => index !== 1 && stage.node === "GPU")) recommendation = "Try CPU placement for the short classical pre/post routines: modeled GPU launch/transfer overhead can dominate these kernels. Compare total latency with the same scale and quantum routing.";
  else recommendation = "Compare CPU → QPU → CPU with classical kernel emulation at the same scale. Keep capacity at the carry-lookahead ceiling when using QPU; extra qubits provide no further modeled speedup. Compare total pipeline latency, not only QPU time.";
  if (m.resource_model_version === 1 || m.resource_model_version === 2) recommendation = recommendation.replaceAll("180×", "modeled");
  if (!unsupported && !capacityBlocked && !memoryBlocked) recommendation = inverseDesignRecommendation(current) ?? recommendation;
  const delta = previous
    ? ` Previous ${previous.telemetry.scale_label}: total ${formatDuration(pipelineTiming(previous.telemetry).totalMs)} → ${formatDuration(pipelineTiming(telemetry).totalMs)} (Δ ${formatDurationDelta(pipelineTiming(telemetry).totalMs - pipelineTiming(previous.telemetry).totalMs)}).${previous.request.hardware_profile !== request.hardware_profile ? ` Hardware changed from ${hardwareLabel(previous.request.hardware_profile, previous.request.custom_profile)} to ${hardwareLabel(request.hardware_profile, request.custom_profile)}.` : ""}${previous.request.workload_id !== request.workload_id ? " Workload changed; cross-workload timings are not an isolated speedup comparison." : previous.request.scale_param !== request.scale_param ? " Scale also changed; this is not an isolated hardware-speedup comparison." : ""}` : "";
  const spaceTime = mips ? mipsSpaceTime(current, thresholds) : quantum.node === "QPU"
    ? `Minimum ${formatValue(thresholds.minimum)} qubits (2n + 3; N = 15 uses 8). Allocated / available: ${formatValue(m.qubits_allocated)} / ${formatValue(available)}. Tier: ${formatValue(m.parallelization_tier)}; depth ${formatValue(m.circuit_depth)} (${formatValue(m.depth_complexity)}), QPU latency ${formatDuration(quantum.latency_ms)}, coherence ${formatValue(m.coherence_survival_pct)}%. Sequential / Windowed / Carry-Lookahead use minimum / 3n / ceil(5.5n) qubits. Capacity above ${formatValue(thresholds.ceiling)} stays idle. ${architectureTradeOff(request.hardware_profile, m.resource_model_version)}`
    : `The quantum kernel is emulated on ${quantum.node}; QPU capacity and ancilla tiers do not change this classical statevector path. Baseline width ${formatValue(m.qubits_required)} qubits; depth ${formatValue(m.circuit_depth)}; kernel latency ${formatDuration(quantum.latency_ms)}. Its relevant limit is CPU/GPU statevector memory, not physical QPU coherence; the selected architecture does not change CPU/GPU execution.`;
  return { runId: current.id, previousRunId: previous?.id ?? null, source: "fallback", model: null,
    usage: zeroUsage(),
    generatedAt: new Date().toISOString(), fallbackReason: reason, notice: notices[reason], sections: {
      routingDiagnosis: `${mips ? mipsRoutingContext(request.scale_param) + " " : ""}${telemetry.scale_label}, ${request.hardware_profile}: ${route}. Primary bottleneck: ${telemetry.primary_bottleneck}. ${unsupported ? "Classical host routines cannot execute on QPU. " : ""}${memoryBlocked ? "Statevector memory grows as 16 × 2^q bytes. " : ""}${stages.some((stage) => stage.node === "GPU") ? "GPU timings include illustrative launch/transfer overhead, not measured PCIe throughput. " : ""}${problems || "All stages report optimal status."}${delta}`,
      spaceTimeTradeOff: (request.custom_profile ? `Custom profile: ${request.custom_profile.name}. Baseline: ${customBaselineLabel(request.custom_profile)}. User-defined assumptions. ` : "") +
        (request.custom_profile?.surface_code ? `Surface code d=${request.custom_profile.surface_code.code_distance_d}, cycle ${request.custom_profile.surface_code.syndrome_cycle_ns} ns, physical error ${request.custom_profile.surface_code.physical_2q_error}, threshold ${request.custom_profile.surface_code.threshold_error}, ${request.custom_profile.surface_code.physical_qubits_per_logical} physical qubits per logical patch. Operation errors are reference-calibrated model proxies. ` : "") + spaceTime.trim(),
      optimizationRecommendation: recommendation,
    } };
}

function skqdInsight(current: CompletedRun, previous: CompletedRun | undefined, reason: FallbackReason): AdvisorInsight {
  const { request, telemetry } = current, params = parseSkqdParameters(request.skqd);
  const stages = PIPELINE.map(({ key }) => telemetry.stages[key]), kernel = stages[1], post = stages[2];
  const unsupported = stages.some((stage, index) => index !== 1 && stage.node === "QPU");
  const capacity = request.available_qubits ?? kernel.metrics.available_qubits;
  const ratio = post.metrics.classical_to_quantum_latency_ratio;
  const survival = kernel.metrics.coherence_survival_pct;
  let recommendation: string;
  if (unsupported) recommendation = "Move Hamiltonian preparation and subspace diagonalization to CPU or GPU; keep the sampling family on QPU.";
  else if (kernel.node === "QPU" && typeof capacity === "number" && capacity < request.scale_param) recommendation = `Increase available capacity to ${request.scale_param} qubits. SKQD uses this fixed register width; extra capacity does not shorten Krylov circuits.`;
  else if (kernel.metrics.execution_feasible === false) recommendation = `Route Stage 2 to QPU with at least ${request.scale_param} qubits, or choose the 22-qubit preset. Sequential statevector reuse does not remove exponential RAM requirements.`;
  else if (kernel.node === "QPU" && typeof survival === "number" && survival < 70) recommendation = params.trotter_steps > 1
    ? `Reduce Trotter steps per power from ${params.trotter_steps} to ${params.trotter_steps - 1}, keep other controls fixed, and compare the family mean and deepest-member survival. This changes the evolution approximation.`
    : "Compare the Ideal Noise-Free profile with the same family to isolate noise. Extra register capacity does not reduce depth; fewer Krylov powers changes the sampled subspace.";
  else if (typeof ratio === "number" && ratio >= 1) recommendation = params.retained_subspace_dimension > 100
    ? `Reduce requested R from ${params.retained_subspace_dimension} to ${Math.max(100, Math.floor(params.retained_subspace_dimension / 2))}; compare effective R, sparse memory and Stage 3 runtime. A smaller basis changes the reconstruction approximation.`
    : "Compare CPU and GPU routing for Stage 3 at the same effective retained basis size, including the GPU launch cost.";
  else recommendation = params.shots_per_state > 1000
    ? `Reduce shots per Krylov state from ${params.shots_per_state} to ${Math.max(1000, Math.floor(params.shots_per_state / 2))}; compare family sampling latency and expected surviving samples. Fewer samples can reduce basis recovery.`
    : "Compare hardware profiles at the same family settings and fixed register capacity. Extra qubits do not shorten this family.";
  const route = stages.map(stage => stage.node).join(" → ");
  const change = previous ? ` Previous total ${formatDuration(pipelineTiming(previous.telemetry).totalMs)}; current ${formatDuration(pipelineTiming(telemetry).totalMs)}. Routing ${PIPELINE.every(({ routingKey }) => (previous.request.routing?.[routingKey] ?? (routingKey === "stage_2_node" ? "QPU" : "CPU")) === (request.routing?.[routingKey] ?? (routingKey === "stage_2_node" ? "QPU" : "CPU"))) ? "unchanged" : "changed"}; compare captured family settings before attributing a speedup.` : "";
  return { runId: current.id, previousRunId: previous?.id ?? null, source: "fallback", model: null,
    generatedAt: new Date().toISOString(), fallbackReason: reason, notice: notices[reason], usage: zeroUsage(), sections: {
      routingDiagnosis: `SKQD ${request.scale_param} qubits: ${route}. ${telemetry.primary_bottleneck}. Stage 3 / QPU family latency: ${typeof ratio === "number" ? ratio.toPrecision(4) + "×" : "unavailable"}.${change}`,
      spaceTimeTradeOff: `Fixed ${request.scale_param}-qubit register; d=${params.krylov_dimension}, m=${params.trotter_steps}, ${params.shots_per_state} shots/state. Family shot-weighted mean survival: ${formatValue(survival)}%; CPU/GPU emulation uses the deterministic baseline. Effective R=${formatValue(post.metrics.retained_subspace_dimension)}, sparse matrix plus six complex128 solver vectors: ${formatBytes(post.metrics.subspace_peak_memory_bytes)}. Thirty Lanczos/Davidson iterations are an analytical cost assumption; no eigenvalue is computed.`,
      optimizationRecommendation: recommendation,
    } };
}

/**
 * Choose the next MIPS experiment in blocker-first order.
 * Resolve unsupported hosts, capacity, and selected-tier RAM before recommending
 * CPU/GPU crossover, extra ancillas, or architecture/coherence comparisons.
 */
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
  const gatePenalty = kernel.metrics.resource_model_version === 1 || kernel.metrics.resource_model_version === 2 ? "modeled" : "180×";
  if (request.hardware_profile === "ftqc_surface_code") return `Keep ${route} and the Multi-Oracle ceiling. Compare IBM Heron with the same scale, capacity and routing to isolate logical error suppression versus 27 µs lattice-surgery gates; compare native classical latency separately. Reduce M to lower logical operation error and gate latency. Extra logical qubits above the ceiling stay idle.`;
  if (request.hardware_profile === "ionq_forte_trapped_ion") return `Compare a superconducting profile at the same Multi-Oracle capacity and routing to isolate the trapped-ion ${gatePenalty} gate latency penalty. Long coherence and all-to-all connectivity do not guarantee lower total latency; extra qubits above the ceiling stay idle.`;
  return `Keep ${route}. At the Multi-Oracle ceiling, extra qubits are idle; reduce M or compare IonQ Forte's longer coherence window against its ${gatePenalty} gate-time penalty. Ideal Noise-Free isolates modeled noise and does not represent physical error correction. O(√M) iterations still grow with scale.`;
}

/**
 * Explain index-width tiers and distinguish classical RAM limits from projected QPU coherence and live Aer evidence.
 */
function mipsSpaceTime(current: CompletedRun, thresholds: ReturnType<typeof qubitThresholds>) {
  const { request, telemetry } = current;
  const kernel = telemetry.stages.stage_2_quantum_kernel, m = kernel.metrics;
  const prefix = `k = ceil(log2 M) = ${Math.ceil(Math.log2(request.scale_param))}. Sequential k+4 / Windowed 2k+8 / Multi-Oracle 4k+16 require ${thresholds.minimum} / ${thresholds.windowed} / ${thresholds.ceiling} qubits; depth factors 1.00× / 0.40× / 0.20×. Tier: ${formatValue(m.parallelization_tier)}; allocated ${formatValue(m.qubits_allocated)}, depth ${formatValue(m.circuit_depth)}. `;
  if (kernel.node !== "QPU") return prefix + `Classical ${kernel.node} emulation keeps 100% deterministic coherence and uses the selected tier's register RAM (16 × 2^q bytes), within 16 GiB CPU / 8 GiB GPU. Physical QPU capacity and topology do not limit this path, but selecting more ancillas increases statevector RAM.`;
  return prefix + `O(√M) Grover iterations rapidly erode NISQ coherence at large vector scales; Multi-Oracle depth reduction or long-coherence hardware can improve survival without guaranteeing viability. Modeled coherence ${formatValue(m.coherence_survival_pct)}%; gate latency ${formatDuration(kernel.latency_ms)}. Capacity above ${thresholds.ceiling} is idle. ${architectureTradeOff(request.hardware_profile, m.resource_model_version)} ${m.aer_executed === true ? "M = 64 Sequential executes a noise-free marked-state Aer reference; measured peak probability and CPU simulator time are separate from hardware projections." : "Analytical marked-candidate projection; no vector loading or adaptive maximum-finding oracle was executed."}`;
}

function gqeInsight(current: CompletedRun, previous: CompletedRun | undefined, reason: FallbackReason): AdvisorInsight {
  const { request, telemetry } = current, p = parseGqeParameters(request.scale_param, request.gqe);
  const stages = PIPELINE.map(({ key }) => telemetry.stages[key]), [first, kernel, post] = stages;
  const ratio = post.metrics.ai_to_qpu_latency_ratio, survival = kernel.metrics.coherence_survival_pct;
  let recommendation: string;
  if (first.node === "QPU" || post.node === "QPU") recommendation = "Move operator pool/generation and replay/training stages to CPU or GPU. These host categories have no QPU implementation; the serial loop is blocked.";
  else if (kernel.node === "QPU" && (request.available_qubits ?? 0) < request.scale_param) recommendation = `Use at least ${request.scale_param} QPU qubits. This is a fixed register; spare qubits do not shorten token circuits.`;
  else if (kernel.metrics.execution_feasible === false) recommendation = "Resolve the reported preflight blocker before comparing latency. No serial epochs executed; memory figures remain requirements.";
  else if (kernel.node === "QPU" && typeof survival === "number" && survival < 70) recommendation = p.sequence_length > 4
    ? `Reduce token sequence length from ${p.sequence_length} to ${Math.max(4, p.sequence_length - 4)} and compare representative per-shot survival. This changes circuit expressivity; it does not guarantee chemical accuracy.`
    : "Compare the Ideal Noise-Free profile to isolate noise. More epochs do not repair per-shot survival; spare capacity does not reduce depth.";
  else if (first.node !== post.node) recommendation = "Compare placing Stage 1 and Stage 3 on the same GPU against the captured split. Include cross-device synchronization and coexisting memory; compare total loop latency with all GQE controls fixed.";
  else if (typeof ratio === "number" && ratio >= 1) recommendation = first.node === "CPU"
    ? "Compare GPU generation and training with the same molecule, mode and controls, including launch overhead and coexisting AI memory. No utilization percentage is measured."
    : `Compare ${Math.max(1, p.gradient_steps_per_epoch - 1)} gradient steps per epoch against ${p.gradient_steps_per_epoch}. A smaller training budget changes optimization; compare runtime without claiming convergence.`;
  else recommendation = `Compare ${Math.max(100, Math.floor(p.shots_per_group / 2))} shots per group against ${p.shots_per_group}, keeping epochs, generated circuits and groups fixed. Less sampling changes energy-estimation precision; no energy is computed here.`;
  const inverse = kernel.metrics.execution_feasible !== false ? inverseDesignRecommendation(current) : null;
  const historical = p.training_mode === "pretrained_finetune" ? "Checkpoint loading is active; historical offline pretraining is excluded from active latency." : "Online from-scratch training includes initialization and active gradient steps; no pretrained checkpoint is assumed.";
  const change = previous ? ` Previous mode ${parseGqeParameters(previous.request.scale_param, previous.request.gqe).training_mode}; current ${p.training_mode}. Previous total ${formatDuration(pipelineTiming(previous.telemetry).totalMs)}; current ${formatDuration(pipelineTiming(telemetry).totalMs)}. Compare captured molecule, mode and epoch settings before attributing speedup.` : "";
  return { runId: current.id, previousRunId: previous?.id ?? null, source: "fallback", model: null, usage: zeroUsage(), generatedAt: new Date().toISOString(), fallbackReason: reason, notice: notices[reason], sections: {
    routingDiagnosis: `GQE / GPT-QE ${request.scale_param} qubits · ${GQE_MODE_LABELS[p.training_mode]}: ${stages.map(stage => stage.node).join(" → ")}. ${telemetry.primary_bottleneck}. AI / QPU evaluation latency: ${typeof ratio === "number" ? ratio.toPrecision(4) + "×" : "unavailable"}. ${historical}${change}`,
    spaceTimeTradeOff: `Setup → [Generate → Evaluate → Update/Train] × ${p.epochs} epochs; ${p.circuits_per_epoch} circuits/epoch × ${p.pauli_measurement_groups} groups × ${p.shots_per_group} shots. One QPU batch launch per epoch. Fixed ${request.scale_param}-qubit register; ${p.sequence_length} tokens; representative survival ${formatValue(survival)}%. ${GQE_SURVIVAL_SCOPE} Classical emulation reuses one pre-measurement state across groups, with 16 × 2^q bytes per statevector. Coexisting AI peak: ${Object.entries(first.metrics.ai_memory?.coexisting_device_peak_memory_bytes ?? {}).map(([device, bytes]) => `${device} ${formatBytes(bytes)}`).join(", ")}. Analytical cost assumptions; no chemical energy or training convergence is simulated.`,
    optimizationRecommendation: inverse ? inverse + " " + GQE_SURVIVAL_SCOPE : recommendation,
  } };
}

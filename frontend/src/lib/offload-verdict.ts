import { pipelineLatencyBuckets } from "@/lib/kpi-metrics";
import { DEFAULT_AVAILABLE_QUBITS, formatValue, PIPELINE, qubitThresholds } from "@/lib/telemetry";
import { formatDuration } from "@/lib/duration";
import type { HybridTelemetryResponse, SimulationRequest } from "@/types/telemetry";

export interface OffloadVerdict {
  title: string;
  status: "optimal" | "warning" | "blocked";
  message: string;
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
export const SIGNIFICANT_OFFLOAD_SPEEDUP = 2;

export function offloadVerdict(data: HybridTelemetryResponse, request: SimulationRequest): OffloadVerdict {
  const kernel = data.stages.stage_2_quantum_kernel;
  const minimum = qubitThresholds(request.scale_param).minimum;
  for (const stage of Object.values(data.stages)) {
    if (stage.node !== "QPU") continue;
    const required = finite(stage.metrics.minimum_qubits_required) ? stage.metrics.minimum_qubits_required : minimum;
    const available = finite(stage.metrics.available_qubits) ? stage.metrics.available_qubits : request.available_qubits ?? DEFAULT_AVAILABLE_QUBITS;
    if (available < required) return { title: "Capacity Blocked", status: "blocked",
      message: `The target register requires ${formatValue(required)} usable qubits; ${formatValue(available)} are available, leaving an exact ${formatValue(required - available)}-qubit deficit. Increase QPU capacity or reduce scale before offloading.` };
  }
  const unsupported = PIPELINE.find(({ key }) => data.stages[key].node === "QPU" && data.stages[key].metrics.routing_supported === false);
  if (unsupported) return { title: "Routing Blocked", status: "blocked",
    message: `${unsupported.label} has no QPU implementation in this simulator. Move classical host stages to CPU or GPU before evaluating quantum offload.` };

  const memoryBudget = kernel.metrics.statevector_memory_budget_gib;
  const width = finite(kernel.metrics.qubits_required) ? kernel.metrics.qubits_required : minimum;
  if (kernel.node !== "QPU" && finite(memoryBudget) && memoryBudget > 0 && width > Math.log2(memoryBudget) + 26) {
    return { title: "Classical Memory Wall", status: "blocked",
      message: `${kernel.node} statevector emulation needs 2^${formatValue(width + 4)} bytes, exceeding its ${formatValue(memoryBudget)} GiB RAM budget. QPU routing is mandatory for this scale within the simulator, with at least ${formatValue(minimum)} usable qubits; reduce scale if capacity is unavailable.` };
  }
  if (Object.values(data.stages).some(stage => stage.metrics.execution_feasible === false)) return {
    title: "Execution Blocked", status: "blocked", message: "A blocked prerequisite prevents this pipeline from executing. Resolve the routing or resource limit before comparing offload latency.",
  };

  const survival = kernel.metrics.coherence_survival_pct;
  if (kernel.node === "QPU" && finite(survival) && survival < 35) return { title: "Decoherence Wall", status: "blocked",
    message: `At ${formatValue(survival)}% modeled coherence survival, quantum offloading is non-viable on physical NISQ hardware without logical error correction in this model. Reduce circuit depth or scale; the ideal noise-free profile is a comparison model, not physical error correction.` };

  const timing = pipelineLatencyBuckets(data);
  const raw = kernel.metrics.classical_cpu_baseline;
  const baseline = raw && typeof raw === "object" ? raw as Record<string, unknown> : null;
  const cpuTotal = baseline?.feasible === true && finite(baseline.total_ms) && baseline.total_ms > 0 ? baseline.total_ms : null;
  const cpuKernel = baseline?.feasible === true && finite(baseline.kernel_ms) && baseline.kernel_ms > 0 ? baseline.kernel_ms : null;
  if (timing.totalMs > 0 && timing.overheadMs / timing.totalMs > 0.4) {
    const cpuComparison = cpuTotal !== null && cpuTotal < timing.totalMs
      ? `CPU execution remains faster (${formatDuration(cpuTotal)} versus ${formatDuration(timing.totalMs)}) because offload I/O penalties erase the compute gain.`
      : "CPU placement for short host routines avoids launch/transfer penalties; compare end-to-end CPU timing before expanding offload.";
    return { title: "Interconnect Dominated", status: "warning",
      message: `Bus, transfer, and state-preparation overhead consumes ${(timing.overheadMs / timing.totalMs * 100).toFixed(1)}% of modeled wall-clock time. ${cpuComparison}` };
  }
  if (kernel.node === "QPU" && finite(survival) && survival >= 70 && kernel.latency_ms > 0 && cpuTotal !== null && cpuKernel !== null &&
      cpuTotal / timing.totalMs >= SIGNIFICANT_OFFLOAD_SPEEDUP && cpuKernel / kernel.latency_ms >= SIGNIFICANT_OFFLOAD_SPEEDUP) {
    return { title: "Quantum Advantage Window", status: "optimal",
      message: `${formatValue(survival)}% coherence and ${formatValue(cpuTotal / timing.totalMs)}× modeled pipeline speedup over the all-CPU statevector baseline confirm a viable quantum offload window${request.hardware_profile === "ideal_sim" ? " in the ideal noise-free projection" : " within this simulator"}. The comparison includes interconnect overhead and is an illustrative estimate.` };
  }
  if (kernel.node !== "QPU") return { title: "Classical Baseline", status: "optimal",
    message: `${kernel.node} statevector emulation retains the 100% deterministic classical coherence baseline. Compare a QPU-routed run at the same scale to evaluate offload benefits.` };
  if (finite(survival) && survival >= 35 && survival < 70) return { title: "Coherence Degraded", status: "warning",
    message: `${formatValue(survival)}% coherence survival leaves a degraded quantum offload budget. Increase capacity toward the parallelization ceiling to reduce depth, or reduce scale.` };
  if (baseline?.feasible === false && timing.quantumMs > 0 && finite(survival) && survival >= 70) return {
    title: "Quantum Offload Candidate", status: "warning",
    message: `The QPU register fits with ${formatValue(survival)}% modeled coherence, while the all-CPU statevector baseline exceeds its ${formatValue(baseline.memory_budget_gib)} GiB RAM budget. ${request.hardware_profile === "ideal_sim" ? "This is an ideal noise-free candidate; physical NISQ viability still requires a noise-aware run." : "Quantum routing is a capacity-feasible candidate, but this run cannot quantify speedup against an executable all-CPU baseline."}`,
  };
  return { title: "Offload Comparison Needed", status: "warning",
    message: "The current run does not establish a nominal-coherence offload window with at least 2× modeled CPU speedup. Compare a feasible CPU baseline and QPU run at the same scale before committing to offload." };
}

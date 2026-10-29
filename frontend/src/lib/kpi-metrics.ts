import type { HybridTelemetryResponse } from "@/types/telemetry";

const milliseconds = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

/**
 * Decompose modeled wall-clock latency into classical, quantum, and I/O buckets.
 * Skip infeasible/unsupported work. GPU latency already includes launch cost, so
 * subtract it from compute once; QPU latency is gates only, so add reported prep
 * and readout separately. Missing/invalid costs contribute zero, not NaN.
 */
export function pipelineLatencyBuckets(data: HybridTelemetryResponse) {
  let classicalMs = 0;
  let quantumMs = 0;
  let overheadMs = 0;
  for (const stage of Object.values(data.stages)) {
    if (stage.metrics.execution_feasible === false || stage.metrics.routing_supported === false ||
        (stage.latency_ms <= 0 && stage.metrics.execution_feasible !== true)) continue;
    const latency = milliseconds(stage.latency_ms);
    if (stage.node === "GPU") {
      // GPU kernel emulation uses io_state_prep_ms for the same overhead that
      // classical GPU routines expose as launch_transfer_overhead_ms.
      const overhead = Math.min(latency, milliseconds(stage.metrics.launch_transfer_overhead_ms ?? stage.metrics.io_state_prep_ms));
      classicalMs += latency - overhead;
      overheadMs += overhead;
    } else {
      if (stage.node === "QPU") {
        quantumMs += latency;
        // QPU latency is gate execution; I/O is reported separately. Readout
        // contributes only when supplied; do not invent an unmodeled duration.
        overheadMs += milliseconds(stage.metrics.io_state_prep_ms) + milliseconds(stage.metrics.io_readout_ms);
      } else {
        classicalMs += latency;
      }
    }
  }
  return { classicalMs, quantumMs, overheadMs, totalMs: classicalMs + quantumMs + overheadMs };
}

/**
 * Combine active classical/QPU compute and separately accounted overhead into a wall-clock total.
 */
export function pipelineTiming(data: HybridTelemetryResponse) {
  const { classicalMs, quantumMs, overheadMs, totalMs } = pipelineLatencyBuckets(data);
  return { computeMs: classicalMs + quantumMs, overheadMs, totalMs };
}

export type CoherenceBudgetStatus = "NOMINAL" | "DEGRADED" | "EXCEEDED";

/**
 * Classify the KPI budget independently of backend stage severity.
 * CPU/GPU emulation uses the 100% deterministic baseline. Any blocked QPU route
 * overrides survival; otherwise thresholds are NOMINAL >=70, DEGRADED >=35,
 * and EXCEEDED below 35. Unknown QPU survival remains undefined rather than zero.
 */
export function coherenceBudget(data: HybridTelemetryResponse): { survival: number | undefined; classical: boolean; status: CoherenceBudgetStatus | null } {
  const kernel = data.stages.stage_2_quantum_kernel;
  const classical = kernel.node === "CPU" || kernel.node === "GPU";
  const raw = kernel.metrics.coherence_survival_pct;
  const survival = classical ? 100 : typeof raw === "number" && Number.isFinite(raw) && raw >= 0 && raw <= 100 ? raw : undefined;
  // A noise-free profile cannot make an unavailable register or unsupported QPU host route nominal.
  const qpuBlocked = Object.values(data.stages).some(stage => stage.node === "QPU" && (
    stage.metrics.execution_feasible === false || stage.metrics.routing_supported === false ||
    stage.metrics.qubits_allocated === 0 ||
    (typeof stage.metrics.available_qubits === "number" && typeof stage.metrics.minimum_qubits_required === "number" &&
      stage.metrics.available_qubits < stage.metrics.minimum_qubits_required)
  ));
  return { classical, survival, status: qpuBlocked ? "EXCEEDED" : survival === undefined ? null : survival >= 70 ? "NOMINAL" : survival >= 35 ? "DEGRADED" : "EXCEEDED" };
}

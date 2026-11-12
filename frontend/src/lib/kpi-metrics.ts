import type { HybridTelemetryResponse, StageTelemetry } from "@/types/telemetry";

const milliseconds = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

/**
 * Decompose modeled wall-clock latency into classical, quantum, and I/O buckets.
 * Skip infeasible/unsupported work. GPU latency already includes launch cost, so
 * subtract it from compute once. Current QPU batches include launch and measurement/
 * reset/repetition pacing; coherent l-coupler stalls are already in gate_execution_ms.
 * Split the explicit breakdown without adding I/O or link time again. Legacy gate-only
 * latency retains its separately reported prep/readout accounting.
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
        const m = stage.metrics;
        const inclusive = m.qpu_io_included_in_latency === true || data.resource_model_version === 2 ||
          m.resource_model_version === 2 || [m.launch_overhead_ms, m.measurement_reset_ms, m.gate_execution_ms].every(value => typeof value === "number");
        if (inclusive) {
          const overhead = Math.min(latency, milliseconds(m.launch_overhead_ms) + milliseconds(m.measurement_reset_ms));
          // Valid complete breakdowns sum to latency; retain the reported total if a legacy breakdown is partial.
          const gates = typeof m.gate_execution_ms === "number" && Number.isFinite(m.gate_execution_ms) && m.gate_execution_ms >= 0
            ? Math.min(latency - overhead, m.gate_execution_ms) : latency - overhead;
          quantumMs += gates;
          overheadMs += latency - gates;
        } else {
          quantumMs += latency;
          overheadMs += milliseconds(m.io_state_prep_ms) + milliseconds(m.io_readout_ms);
        }
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

/** Format a percentage for display without rounding small nonzero values to zero. */
export function formatSurvivalPercent(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) return "—";
  const formatted = value > 0 && value < 0.001 ? value.toExponential(2)
    : new Intl.NumberFormat("en-US", { maximumSignificantDigits: 3 }).format(value);
  // Keep a displayed value from crossing the classification thresholds.
  return (value < 35 && Number(formatted) >= 35) || (value < 70 && Number(formatted) >= 70)
    ? String(value) : formatted;
}

/** Compact probability-range annotation for existing QPU survival displays only. */
export function coherenceRangeLabel(stage?: StageTelemetry): string | null {
  if (!stage || stage.node !== "QPU" || stage.metrics.execution_feasible === false ||
      stage.metrics.routing_supported === false || stage.metrics.qubits_allocated === 0) return null;
  const best = stage.metrics.coherence_survival_best;
  const worst = stage.metrics.coherence_survival_worst;
  const valid = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
  if (!valid(best) || !valid(worst) || worst > best) return null;
  const percent = (probability: number) => formatSurvivalPercent(100 * probability) + "%";
  return `Best / worst case: ${percent(best)} / ${percent(worst)}`;
}

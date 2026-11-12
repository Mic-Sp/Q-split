import { coherenceBudget, formatSurvivalPercent, pipelineTiming } from "@/lib/kpi-metrics";
import { DEFAULT_AVAILABLE_QUBITS } from "@/lib/telemetry";
import { formatDuration, formatDurationDelta, formatRawMilliseconds } from "@/lib/duration";
import type { SavedSimulationRun } from "@/types/run-history";
import { modelVersionLabel, resourceModelVersion, sameModelVersion } from "@/lib/model-version";

export const MAX_COMPARISON_RUNS = 3;
const number = new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 });
const finite = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
const signed = (value: number) => `${value > 0 ? "+" : ""}${value !== 0 && Math.abs(value) < 0.001
  ? value.toExponential(2) : number.format(Object.is(value, -0) ? 0 : value)}`;

/**
 * Normalize a saved row into the same wall-clock/coherence metrics used by KPIs.
 * Missing values stay null, blocked work contributes no executed cost, and circuit
 * depth uses its persisted decimal string to preserve PostgreSQL BIGINT precision.
 */
export function benchmarkMetrics(run: SavedSimulationRun) {
  const kernel = run.telemetry.stages.stage_2_quantum_kernel;
  const metrics = kernel.metrics;
  const coherence = coherenceBudget(run.telemetry);
  return {
    ...pipelineTiming(run.telemetry),
    availableQubits: finite(metrics.available_qubits) ?? run.request.available_qubits ?? DEFAULT_AVAILABLE_QUBITS,
    allocatedQubits: kernel.node === "QPU" ? finite(metrics.qubits_allocated) : null,
    parallelTier: kernel.node === "QPU" ? typeof metrics.parallelization_tier === "string" ? metrics.parallelization_tier : null : "Classical emulation",
    // Use the persisted decimal string, preserving BIGINT precision.
    circuitDepth: run.circuitDepth ?? (Number.isSafeInteger(metrics.circuit_depth) ? String(metrics.circuit_depth) : null),
    coherenceSurvival: coherence.survival ?? null,
    coherenceStatus: coherence.status,
    modulesUsed: finite(metrics.modules_used),
    transfersPerShot: finite(metrics.transfers_per_shot),
    transferRounds: finite(metrics.scheduled_transfer_rounds),
    linkExecutionMs: finite(metrics.link_execution_ms),
    transferFidelity: finite(metrics.selected_transfer_fidelity),
    transferDurationNs: finite(metrics.transfer_duration_ns),
    fidelityScenario: typeof metrics.fidelity_scenario === "string" ? metrics.fidelity_scenario : null,
    modulePlacement: typeof metrics.module_placement === "string" ? metrics.module_placement : null,
    interconnectModelVersion: finite(metrics.interconnect_model_version),
  };
}

/**
 * Match selected UUIDs to currently available rows in selection order.
 * Deduplicate, drop deleted/foreign IDs absent from the supplied pool, and cap at
 * three. The first retained selection is the comparison reference, not the newest row.
 */
export function selectedBenchmarkRuns(runs: SavedSimulationRun[], ids: string[]) {
  const byId = new Map(runs.map(run => [run.id, run]));
  return [...new Set(ids)].flatMap(id => byId.has(id) ? [byId.get(id)!] : []).slice(0, MAX_COMPARISON_RUNS);
}

/**
 * Toggle one valid UUID after pruning stale selections; reject a fourth distinct row without disturbing order.
 */
export function toggleBenchmarkSelection(runs: SavedSimulationRun[], ids: string[], id: string) {
  const selected = selectedBenchmarkRuns(runs, ids).map(run => run.id);
  if (selected.includes(id)) return selected.filter(value => value !== id);
  return selected.length < MAX_COMPARISON_RUNS && runs.some(run => run.id === id) ? [...selected, id] : selected;
}

/**
 * Export selected rows across the current workload's filters, or exactly the visible rows.
 * The caller must supply a workload-scoped pool; an empty selection does not imply
 * exporting all cached history or other workloads.
 */
export function benchmarkExportRuns(runs: SavedSimulationRun[], visible: SavedSimulationRun[], ids: string[]) {
  const selected = selectedBenchmarkRuns(runs, ids);
  return selected.length ? selected : visible;
}

export interface ComparisonMetric {
  label: string;
  value: string;
  delta: string | null;
  changed: boolean;
  raw?: string;
  rawDelta?: string;
}

/**
 * Build aligned comparison columns relative to the first selected benchmark.
 * Each column emits the same metric order for matrix row matching. Durations keep
 * raw hover values, coherence differences are percentage points, categorical cells
 * track equality, and BigInt subtraction preserves large circuit-depth deltas.
 * Missing metrics suppress numeric deltas rather than fabricating zero baselines.
 */
export function benchmarkComparison(runs: SavedSimulationRun[]) {
  const chosen = runs.slice(0, MAX_COMPARISON_RUNS);
  if (!chosen.length) return [];
  const reference = benchmarkMetrics(chosen[0]);
  const showLinks = chosen.some(run => benchmarkMetrics(run).modulesUsed !== null);
  return chosen.map((run, index) => {
    const metrics = benchmarkMetrics(run);
    const compatible = sameModelVersion(chosen[0].telemetry, run.telemetry);
    const numeric = (label: string, value: number | null, baseline: number | null, unit: string, deltaUnit = unit): ComparisonMetric => ({
      label, value: value === null ? "Not reported" : `${unit === "%" ? formatSurvivalPercent(value) : number.format(value)} ${unit}`,
      delta: index === 0 || value === null || baseline === null ? null : `${signed(value - baseline)} ${deltaUnit} vs reference`,
      changed: index > 0 && value !== baseline,
    });
    const categorical = (label: string, value: string, baseline: string): ComparisonMetric => ({
      label, value, delta: index === 0 ? null : value === baseline ? "Same as reference" : "Changed from reference", changed: index > 0 && value !== baseline,
    });
    const duration = (label: string, value: number, baseline: number): ComparisonMetric => ({
      label, value: formatDuration(value), raw: formatRawMilliseconds(value),
      delta: index === 0 ? null : `${formatDurationDelta(value - baseline)} vs reference`,
      rawDelta: index === 0 ? undefined : `${value > baseline ? "+" : value < baseline ? "−" : ""}${formatRawMilliseconds(Math.abs(value - baseline))}`,
      changed: index > 0 && value !== baseline,
    });
    // Subtract decimal-string depths as BigInt before formatting; Number could lose low-order bits.
    const depth = metrics.circuitDepth === null ? null : BigInt(metrics.circuitDepth);
    const baselineDepth = reference.circuitDepth === null ? null : BigInt(reference.circuitDepth);
    const coherence = numeric("Coherence survival", metrics.coherenceSurvival, reference.coherenceSurvival, "%", "pp");
    // Survival deltas are percentage points; the independent budget classification can also change.
    coherence.value += metrics.coherenceStatus ? ` · ${metrics.coherenceStatus}` : "";
    coherence.changed ||= index > 0 && metrics.coherenceStatus !== reference.coherenceStatus;
    const rows: ComparisonMetric[] = [
        duration("Total latency", metrics.totalMs, reference.totalMs),
        duration("Pure compute", metrics.computeMs, reference.computeMs),
        duration("Interconnect overhead", metrics.overheadMs, reference.overheadMs),
        numeric("Allocated QPU qubits", metrics.allocatedQubits, reference.allocatedQubits, "qubits"),
        numeric("Available QPU qubits", metrics.availableQubits, reference.availableQubits, "qubits"),
        categorical("Parallel tier", metrics.parallelTier ?? "Not reported", reference.parallelTier ?? "Not reported"),
        { label: "Circuit depth", value: depth === null ? "Not reported" : `${number.format(depth)} gates`,
          delta: index === 0 || depth === null || baselineDepth === null ? null : `${depth > baselineDepth ? "+" : ""}${number.format(depth - baselineDepth)} gates vs reference`, changed: index > 0 && depth !== baselineDepth },
        coherence,
        categorical("Bottleneck status", `${run.bottleneckStatus} · ${run.primaryBottleneck}`, `${chosen[0].bottleneckStatus} · ${chosen[0].primaryBottleneck}`),
      ];
    if (showLinks) rows.push(
      numeric("Modules used", metrics.modulesUsed, reference.modulesUsed, "modules"),
      numeric("State transfers / shot", metrics.transfersPerShot, reference.transfersPerShot, "transfers"),
      numeric("Transfer rounds / shot", metrics.transferRounds, reference.transferRounds, "rounds"),
      numeric("l-coupler execution (included)", metrics.linkExecutionMs, reference.linkExecutionMs, "ms"),
      numeric("State transfer fidelity", metrics.transferFidelity, reference.transferFidelity, "probability"),
      numeric("Assumed transfer duration", metrics.transferDurationNs, reference.transferDurationNs, "ns/round"),
      categorical("Fidelity scenario", metrics.fidelityScenario ?? "Not reported", reference.fidelityScenario ?? "Not reported"),
      categorical("Module placement", metrics.modulePlacement ?? "Not reported", reference.modulePlacement ?? "Not reported"),
    );
    return {
      run, compatible, modelVersion: modelVersionLabel(resourceModelVersion(run.telemetry)),
      metrics: compatible ? rows : rows.map(row => ({ ...row, delta: null, rawDelta: undefined, changed: false })),
    };
  });
}

import { coherenceBudget, pipelineTiming } from "@/lib/kpi-metrics";
import { DEFAULT_AVAILABLE_QUBITS } from "@/lib/telemetry";
import { formatDuration, formatDurationDelta, formatRawMilliseconds } from "@/lib/duration";
import type { SavedSimulationRun } from "@/types/run-history";

export const MAX_COMPARISON_RUNS = 3;
const number = new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 });
const finite = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
const signed = (value: number) => `${value > 0 ? "+" : ""}${number.format(Object.is(value, -0) ? 0 : value)}`;

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
  };
}

export function selectedBenchmarkRuns(runs: SavedSimulationRun[], ids: string[]) {
  const byId = new Map(runs.map(run => [run.id, run]));
  return [...new Set(ids)].flatMap(id => byId.has(id) ? [byId.get(id)!] : []).slice(0, MAX_COMPARISON_RUNS);
}

export function toggleBenchmarkSelection(runs: SavedSimulationRun[], ids: string[], id: string) {
  const selected = selectedBenchmarkRuns(runs, ids).map(run => run.id);
  if (selected.includes(id)) return selected.filter(value => value !== id);
  return selected.length < MAX_COMPARISON_RUNS && runs.some(run => run.id === id) ? [...selected, id] : selected;
}

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

export function benchmarkComparison(runs: SavedSimulationRun[]) {
  const chosen = runs.slice(0, MAX_COMPARISON_RUNS);
  if (!chosen.length) return [];
  const reference = benchmarkMetrics(chosen[0]);
  return chosen.map((run, index) => {
    const metrics = benchmarkMetrics(run);
    const numeric = (label: string, value: number | null, baseline: number | null, unit: string, deltaUnit = unit): ComparisonMetric => ({
      label, value: value === null ? "Not reported" : `${number.format(value)} ${unit}`,
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
    const depth = metrics.circuitDepth === null ? null : BigInt(metrics.circuitDepth);
    const baselineDepth = reference.circuitDepth === null ? null : BigInt(reference.circuitDepth);
    const coherence = numeric("Coherence survival", metrics.coherenceSurvival, reference.coherenceSurvival, "%", "pp");
    coherence.value += metrics.coherenceStatus ? ` · ${metrics.coherenceStatus}` : "";
    coherence.changed ||= index > 0 && metrics.coherenceStatus !== reference.coherenceStatus;
    return {
      run,
      metrics: [
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
      ],
    };
  });
}

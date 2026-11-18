import type { StageMetrics, StageTelemetry } from "@/types/telemetry";
import { formatDuration } from "@/lib/duration";
import { formatSurvivalPercent } from "@/lib/kpi-metrics";
import { formatBytes } from "@/lib/skqd";

const percent = (value: number | undefined) => value === undefined ? "—" : `${formatSurvivalPercent(value * 100)}%`;
const scalar = (value: unknown) => typeof value === "number" ? value.toLocaleString("en-US", { maximumSignificantDigits: 6 }) : "—";
const shotDuration = (value: number | undefined) => value !== undefined && value > 0 && value < 1
  ? `${scalar(value * 1000)} µs` : formatDuration(value);

export function SkqdFamilyDiagnostics({ metrics, tableOnly = false }: { metrics: StageMetrics; tableOnly?: boolean }) {
  const family = metrics.family_survival ?? metrics.qpu_sampling_comparison?.family_survival;
  const members = metrics.krylov_members;
  if (!members?.length && !family) return <p className="text-xs text-slate-600 dark:text-slate-400">Family execution unavailable because a prerequisite was blocked.</p>;
  return <div className="min-w-0 space-y-3">
    {!tableOnly && <>
      <p className="text-[11px] text-slate-600 dark:text-slate-400">{metrics.qpu_sampling_comparison?.comparison_only ? "QPU comparison projection · selected route uses classical emulation" : "One family launch · independent shot batches for each power"}</p>
      <dl className="grid grid-cols-2 gap-2 text-[11px] lg:grid-cols-4">
        {[["Shot-weighted mean", percent(family?.point)], ["T1 best / T2 worst", `${percent(family?.best)} / ${percent(family?.worst)}`],
          ["Deepest-member survival", percent(family?.deepest_member.point)], ["Expected surviving samples", scalar(family?.expected_surviving_samples)]].map(([label, value]) => <div key={label} className="rounded border border-violet-500/20 bg-violet-500/5 p-2"><dt className="text-slate-600 dark:text-slate-400">{label}</dt><dd className="mt-1 break-words font-mono text-violet-800 dark:text-violet-200">{value}</dd></div>)}
      </dl>
      <p className="text-[10px] text-slate-600 dark:text-slate-400">The family mean governs coherence status. Survival is a no-error proxy; the T1/T2 range describes model sensitivity.</p>
    </>}
    {members?.length ? <div role="region" aria-label="Krylov power diagnostics" tabIndex={0} className="max-h-96 min-w-0 overflow-auto rounded border border-slate-300 focus-visible:outline-2 focus-visible:outline-cyan-600 dark:border-slate-700">
      <table className="w-full min-w-[990px] text-left font-mono text-[10px] tabular-nums">
        <caption className="sr-only">Per-power logical and native resources, inclusive shot duration, and QPU survival</caption>
        <thead className="sticky top-0 bg-slate-100 text-slate-700 dark:bg-slate-900 dark:text-slate-200"><tr>{["Power k", "Shots", "Logical depth", "Native depth", "1Q gates", "Logical 2Q", "Native 2Q", "Shot duration", "Point", "Best T1", "Worst T2", "Log survival"].map(label => <th key={label} scope="col" className="whitespace-nowrap p-2 font-semibold">{label}</th>)}</tr></thead>
        <tbody>{members.slice(0, 15).map(member => {
          const physical = member.metrics ?? member.qpu_comparison_metrics;
          const duration = physical?.execution_feasible !== false && typeof physical?.latency_ms === "number" ? physical.latency_ms / member.shots : undefined;
          return <tr key={member.power_index} className="border-t border-slate-200 text-slate-800 dark:border-slate-800 dark:text-slate-200">
            <th scope="row" className="p-2 text-violet-800 dark:text-violet-200">{member.power_index}</th>
            {[scalar(member.shots), scalar(member.circuit_spec.depth), scalar(physical?.circuit_depth), scalar(member.circuit_spec.n_1q), scalar(member.circuit_spec.n_2q), scalar(physical?.n_2q), shotDuration(duration), percent(physical?.coherence_survival), percent(physical?.coherence_survival_best), percent(physical?.coherence_survival_worst), scalar(physical?.coherence_log_survival)].map((value, index) => <td key={index} className="whitespace-nowrap p-2">{value}</td>)}
          </tr>;
        })}</tbody>
      </table>
    </div> : null}
  </div>;
}

export function SkqdClassicalDiagnostics({ stage }: { stage: StageTelemetry }) {
  const metrics = stage.metrics, ratio = metrics.classical_to_quantum_latency_ratio;
  return <section aria-label="SKQD classical subspace diagnostics" className="mb-2 min-w-0 space-y-2 rounded border border-cyan-600/20 bg-cyan-600/5 p-2 text-[11px]">
    <p className="font-semibold text-cyan-900 dark:text-cyan-100">{metrics.bottleneck_regime === "classical-diagonalization-bound" ? "Classical diagonalization bound" : metrics.bottleneck_regime === "quantum-sampling-bound" ? "QPU sampling bound" : "Crossover unavailable"}</p>
    <p className="text-slate-600 dark:text-slate-400">Stage 3 / QPU sampling: <strong className="font-mono">{typeof ratio === "number" ? `${scalar(ratio)}×` : "—"}</strong>{metrics.execution_feasible === false ? " · execution blocked" : ""}</p>
    <dl className="grid grid-cols-2 gap-2">
      {[["Effective basis R", scalar(metrics.retained_subspace_dimension)], ["Subspace peak memory", formatBytes(metrics.subspace_peak_memory_bytes)],
        ["Matrix values + indices", formatBytes(typeof metrics.projected_matrix_value_bytes === "number" && typeof metrics.projected_matrix_index_bytes === "number" ? metrics.projected_matrix_value_bytes + metrics.projected_matrix_index_bytes : undefined)],
        ["Six solver vectors", formatBytes(metrics.solver_workspace_bytes)], ["Configuration recovery", formatDuration(metrics.recovery_compute_ms)],
        ["Sparse projection", formatDuration(metrics.projection_compute_ms)], ["Lanczos / Davidson", formatDuration(metrics.eigensolver_compute_ms)], ["Stage 3 total", formatDuration(stage.latency_ms)]].map(([label, value]) => <div key={label}><dt className="text-slate-600 dark:text-slate-400">{label}</dt><dd className="mt-0.5 break-words font-mono text-slate-900 dark:text-slate-100">{value}</dd></div>)}
    </dl>
    <p className="text-[10px] leading-4 text-slate-600 dark:text-slate-400">30 iterations · complex128 · estimated matrix/workspace memory. Raw sample buffers are excluded; host memory feasibility and utilization are not modeled.</p>
  </section>;
}

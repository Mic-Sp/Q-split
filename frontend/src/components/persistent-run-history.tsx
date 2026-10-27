"use client";

import { ChevronDown, CircleAlert, Database, LoaderCircle, RefreshCw } from "lucide-react";
import { formatValue } from "@/lib/telemetry";
import type { usePersistentRuns } from "@/hooks/use-persistent-runs";
import type { StageStatus } from "@/types/telemetry";
import { AdvisorDiagnostic } from "@/components/advisor-diagnostic";
import { AdvisorSourceBadge } from "@/components/advisor-source-badge";

const statusColors: Record<StageStatus, string> = {
  OPTIMAL: "border-emerald-400/25 bg-emerald-400/10 text-emerald-300",
  WARNING: "border-amber-400/25 bg-amber-400/10 text-amber-300",
  CRITICAL_BOTTLENECK: "border-rose-400/25 bg-rose-400/10 text-rose-300",
};
const statusLabels = { OPTIMAL: "Optimal", WARNING: "Warning", CRITICAL_BOTTLENECK: "Critical bottleneck" };
const timeFormatter = new Intl.DateTimeFormat("en-US", {
  year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  timeZone: "America/Chicago", timeZoneName: "short",
});

export function PersistentRunHistory({ history }: { history: ReturnType<typeof usePersistentRuns> }) {
  return (
    <section aria-label="Persistent Run History" className="mt-8 overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/35">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 px-5 py-5 sm:px-6">
        <div className="flex items-center gap-3"><Database size={19} className="text-cyan-400" /><div><h2 className="text-sm font-semibold">Persistent Run History</h2><p className="mt-1 text-xs leading-5 text-slate-500">Most recent 20 database runs · times shown in Central time</p></div></div>
        <button type="button" disabled={history.refreshing} onClick={() => { void history.refresh(); }} className="inline-flex items-center gap-2 rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-300 hover:border-cyan-400/50 disabled:opacity-50"><RefreshCw size={13} className={history.refreshing ? "animate-spin" : ""} />Refresh history</button>
      </div>
      <div aria-live="polite" className="space-y-4 px-5 py-5 sm:px-6">
        {history.message && <div className="flex items-start gap-3 rounded-lg border border-amber-400/20 bg-amber-400/5 p-4 text-xs leading-6 text-amber-200"><CircleAlert size={16} className="mt-1 shrink-0" /><p className="min-w-0 [overflow-wrap:anywhere]">{history.message}</p></div>}
        {history.savingCount > 0 && <p className="flex items-center gap-2 text-xs text-cyan-300"><LoaderCircle size={13} className="animate-spin" />Saving {history.savingCount} {history.savingCount === 1 ? "run" : "runs"} in the background…</p>}
        {history.pendingCount > history.savingCount && <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-800 p-3"><p className="max-w-2xl text-xs leading-6 text-slate-400">{history.pendingCount} {history.pendingCount === 1 ? "run is" : "runs are"} awaiting save in this tab. Unsaved runs are lost if you close or reload the page.</p><button type="button" onClick={history.retryPending} className="shrink-0 rounded-md border border-cyan-400/30 px-3 py-2 text-xs text-cyan-200">Retry saving</button></div>}
        {history.availability === "loading" && <p className="flex items-center gap-2 py-4 text-xs text-slate-400"><LoaderCircle size={14} className="animate-spin" />Loading saved runs…</p>}
        {history.availability === "ready" && history.runs.length === 0 && <p className="py-6 text-center text-sm text-slate-400">No saved runs yet. Completed simulations will appear here automatically.</p>}
      </div>
      {history.runs.length > 0 && <div className="space-y-3 px-5 pb-5 sm:px-6">{history.runs.map((run) => <details key={run.id} data-testid="saved-run" className="group rounded-xl border border-slate-800 bg-slate-950/40">
        <summary className="flex list-none flex-wrap items-center gap-4 p-4 sm:p-5">
          <div className="min-w-0 flex-1 basis-48"><p className="truncate text-sm font-medium text-slate-200" title={run.workloadName}>{run.workloadName}</p><time dateTime={run.completedAt} className="mt-1 block text-xs text-slate-500">{timeFormatter.format(new Date(run.completedAt))}</time></div>
          <div className="min-w-0 flex-1 basis-44"><p className="truncate text-xs text-slate-300" title={run.scaleLabel}>{run.scaleLabel}</p><p className="mt-1 text-[10px] text-slate-500">{run.hardwareProfile === "ideal_sim" ? "Ideal Noise-Free" : "IBM Heron NISQ"} · {run.stage1Node} → {run.stage2Node} → {run.stage3Node}</p></div>
          <p className="font-mono text-sm text-cyan-200">{formatValue(run.totalLatencyMs)}<span className="ml-1 text-[10px] text-slate-500">ms</span></p>
          <span className={["rounded-md border px-2 py-1 text-[10px] font-semibold", statusColors[run.bottleneckStatus]].join(" ")}>{statusLabels[run.bottleneckStatus]}</span><ChevronDown size={15} className="shrink-0 text-slate-500 transition-transform group-open:rotate-180" />
        </summary>
        <div className="space-y-4 border-t border-slate-800 p-4 sm:p-5">
          <p className="text-xs leading-6 text-slate-300 [overflow-wrap:anywhere]">{run.primaryBottleneck}</p>
          {run.advisorInsight && <div className="space-y-3" aria-label="Saved advisor insight">
            <div className="flex flex-wrap items-center gap-2"><p className="text-xs font-semibold text-cyan-300">AI Telemetry Advisor · {run.advisorInsight.source !== "fallback" ? run.advisorInsight.model : "Local deterministic diagnostic"}</p><AdvisorSourceBadge source={run.advisorInsight.source === "fallback" ? "fallback" : "cached"} /></div>
            {run.advisorInsight.notice && <p className="text-xs leading-5 text-amber-200">{run.advisorInsight.notice}</p>}
            <AdvisorDiagnostic insight={run.advisorInsight} />
          </div>}
          {run.request.available_qubits !== undefined && <p className="text-xs leading-6 text-cyan-200 [overflow-wrap:anywhere]">
            QPU capacity: {formatValue(run.request.available_qubits)} qubits
            {run.stage2Node === "QPU" && <> · Allocated / Available: {formatValue(run.telemetry.stages.stage_2_quantum_kernel.metrics.qubits_allocated)} / {formatValue(run.request.available_qubits)} · {formatValue(run.telemetry.stages.stage_2_quantum_kernel.metrics.parallelization_tier)}</>}
          </p>}
          <dl className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">{[
            ["Logical qubits", formatValue(run.qubitsRequired ?? undefined)], ["Circuit depth", run.circuitDepth === null ? "—" : formatValue(BigInt(run.circuitDepth))],
            ["Coherence", run.coherenceSurvivalPct === null ? "—" : `${formatValue(run.coherenceSurvivalPct)}%`], ["Execution mode", run.executionMode.replaceAll("_", " ")],
          ].map(([label, value]) => <div key={label} className="min-w-0 rounded-lg bg-slate-900 p-3"><dt className="text-[10px] text-slate-500">{label}</dt><dd className="mt-2 font-mono text-slate-200 [overflow-wrap:anywhere]">{value}</dd></div>)}</dl>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Complete telemetry payload</p>
          <pre tabIndex={0} aria-label="Saved telemetry payload" className="max-h-80 overflow-auto rounded-lg border border-slate-800 bg-slate-950 p-4 font-mono text-[11px] leading-6 text-slate-400">{JSON.stringify(run.telemetry, null, 2)}</pre>
        </div>
      </details>)}</div>}
    </section>
  );
}

"use client";

import { Fragment, useState } from "react";
import { Pin, RotateCcw, Trash2 } from "lucide-react";
import { AdvisorDiagnostic } from "@/components/advisor-diagnostic";
import { AdvisorTelemetryBar } from "@/components/advisor-telemetry";
import { cachedInsight } from "@/lib/advisor-telemetry";
import { SNAPSHOT_NAME_LIMIT } from "@/lib/benchmark-snapshot";
import { coherenceBudget, pipelineTiming } from "@/lib/kpi-metrics";
import { formatDuration, formatRawMilliseconds } from "@/lib/duration";
import { hardwareLabel } from "@/lib/hardware-profiles";
import { DEFAULT_AVAILABLE_QUBITS, formatValue } from "@/lib/telemetry";
import type { SavedSimulationRun } from "@/types/run-history";

const timeFormatter = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Chicago", timeZoneName: "short" });
const budgetStyle = { NOMINAL: "text-emerald-700 dark:text-emerald-300 border-emerald-700/25 dark:border-emerald-400/25", DEGRADED: "text-amber-700 dark:text-amber-300 border-amber-700/25 dark:border-amber-400/25", EXCEEDED: "text-rose-700 dark:text-rose-300 border-rose-700/25 dark:border-rose-400/25" };
const button = "inline-flex min-h-7 items-center gap-1 rounded border border-slate-300 dark:border-slate-700 px-2 py-1 text-[10px] text-slate-700 dark:text-slate-300 hover:border-cyan-700/50 dark:hover:border-cyan-400/50 disabled:opacity-40";

/**
 * Render an immutable saved run with metadata-only naming and explicit row actions.
 * Editing state is local to the UUID-keyed row; failed async mutations retain the
 * current row/name, and restoration delegates to the captured-configuration handler.
 */
export function BenchmarkRow({ run, busy, selected, selectionDisabled, onSelect, onName, onDelete, onRestore }: {
  run: SavedSimulationRun;
  busy: boolean;
  selected: boolean;
  selectionDisabled: boolean;
  onSelect: (id: string) => void;
  onName: (id: string, name: string) => Promise<boolean>;
  onDelete: (id: string) => Promise<boolean>;
  onRestore: (run: SavedSimulationRun) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(run.snapshotName ?? "");
  const [expanded, setExpanded] = useState(false);
  const timing = pipelineTiming(run.telemetry);
  const coherence = coherenceBudget(run.telemetry);
  const kernel = run.telemetry.stages.stage_2_quantum_kernel;
  const metrics = kernel.metrics;
  return <Fragment>
    <tr data-testid="saved-run" data-run-id={run.id} className={`border-b border-slate-200 dark:border-slate-800 align-top text-[10px] text-slate-700 dark:text-slate-300 ${selected ? "bg-cyan-700/5 dark:bg-cyan-400/5" : ""}`}>
      <td className="p-2"><input type="checkbox" aria-label={`Compare ${run.snapshotName ?? run.scaleLabel} (${run.id})`} checked={selected} disabled={selectionDisabled} onChange={() => onSelect(run.id)} className="size-4 cursor-pointer accent-cyan-700 dark:accent-cyan-400 disabled:cursor-not-allowed disabled:opacity-30" /></td>
      <td className="p-2">
        {editing ? <form aria-label="Rename benchmark snapshot" className="space-y-1" onSubmit={async event => { event.preventDefault(); if (await onName(run.id, name)) setEditing(false); }}>
          <input aria-label="Snapshot name" autoFocus value={name} maxLength={SNAPSHOT_NAME_LIMIT} disabled={busy} onChange={event => setName(event.target.value)} className="w-full rounded border border-slate-400 dark:border-slate-600 bg-slate-50 dark:bg-slate-950 px-2 py-1 text-xs" />
          <div className="flex gap-1"><button type="submit" disabled={busy || !name.trim()} className={button}>{busy ? "Saving…" : "Save name"}</button><button type="button" disabled={busy} onClick={() => setEditing(false)} className={button}>Cancel</button></div>
        </form> : <><p className="flex items-start gap-1 font-semibold text-cyan-900 dark:text-cyan-100 [overflow-wrap:anywhere]">{run.isSnapshot && <Pin size={12} aria-label="Pinned Benchmark Snapshot" className="mt-0.5 shrink-0 text-cyan-700 dark:text-cyan-400" />}{run.snapshotName ?? "Unnamed run"}</p><p className="mt-0.5 text-[9px] text-slate-600 dark:text-slate-400">{run.workloadName}</p></>}
        <time dateTime={run.completedAt} className="mt-1 block text-[9px] text-slate-600 dark:text-slate-400">{timeFormatter.format(new Date(run.completedAt))}</time>
      </td>
      <td className="p-2"><p>{run.scaleLabel}</p><p className="mt-1 text-[9px] text-slate-600 dark:text-slate-400">{hardwareLabel(run.hardwareProfile)}</p></td>
      <td className="whitespace-nowrap p-2 font-mono">{run.stage1Node} → {run.stage2Node} → {run.stage3Node}</td>
      <td className="p-2"><p className="font-mono text-cyan-800 dark:text-cyan-200">{kernel.node === "QPU" ? `${formatValue(metrics.qubits_allocated)} / ${formatValue(metrics.available_qubits ?? run.request.available_qubits ?? DEFAULT_AVAILABLE_QUBITS)}` : "— (Classical)"}</p><p className="mt-1 text-[9px] text-slate-600 dark:text-slate-400">{kernel.node === "QPU" ? formatValue(metrics.parallelization_tier) : `${formatValue(metrics.qubits_required)} logical qubits`}</p></td>
      <td className="p-2 font-mono"><p title={formatRawMilliseconds(timing.computeMs)}>{formatDuration(timing.computeMs)} <span className="font-sans text-slate-600 dark:text-slate-400">compute</span></p><p title={formatRawMilliseconds(timing.overheadMs)} className="mt-1 text-amber-800 dark:text-amber-200">{formatDuration(timing.overheadMs)} <span className="font-sans text-slate-600 dark:text-slate-400">I/O</span></p></td>
      <td title={formatRawMilliseconds(timing.totalMs)} className="p-2 font-mono text-cyan-800 dark:text-cyan-200">{formatDuration(timing.totalMs)}</td>
      <td className="p-2"><p className="font-mono">{formatValue(coherence.survival)}{coherence.survival === undefined ? "" : "%"}</p>{coherence.status && <span className={`mt-1 inline-flex rounded border px-1 py-0.5 text-[8px] font-semibold ${budgetStyle[coherence.status]}`}>{coherence.status}</span>}</td>
      <td className="p-2 text-[9px] leading-4 [overflow-wrap:anywhere]">{run.primaryBottleneck}</td>
      <td className="p-2"><div className="flex flex-col items-start gap-1">
        <button type="button" onClick={() => onRestore(run)} className={button}><RotateCcw size={10} />Restore to Simulator</button>
        <div className="flex flex-wrap gap-1"><button type="button" disabled={busy} onClick={() => { setName(run.snapshotName ?? ""); setEditing(true); }} className={button}>{run.isSnapshot ? "Rename" : "Name snapshot"}</button><button type="button" disabled={busy} onClick={() => { void onDelete(run.id); }} className={`${button} text-rose-700 dark:text-rose-300`}><Trash2 size={10} />Delete</button></div>
        <button type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)} className={button}>{expanded ? "Hide details" : "Details"}</button>
      </div></td>
    </tr>
    {expanded && <tr><td colSpan={10} className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/50 p-3"><div className="space-y-3">
      {run.advisorInsight && <div aria-label="Saved advisor insight" className="space-y-3"><AdvisorTelemetryBar insight={cachedInsight(run.advisorInsight)} />{run.advisorInsight.notice && <p className="text-xs text-amber-800 dark:text-amber-200">{run.advisorInsight.notice}</p>}<AdvisorDiagnostic insight={run.advisorInsight} /></div>}
      <p className="text-[10px] font-semibold text-slate-600 dark:text-slate-400">Complete saved configuration and telemetry</p>
      <pre tabIndex={0} aria-label="Saved telemetry payload" className="max-h-80 overflow-auto rounded border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 p-3 text-[10px] leading-5 text-slate-600 dark:text-slate-400">{JSON.stringify({ request: run.request, telemetry: run.telemetry }, null, 2)}</pre>
    </div></td></tr>}
  </Fragment>;
}

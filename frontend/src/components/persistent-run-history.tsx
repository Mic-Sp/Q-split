"use client";

import { useId, useState } from "react";
import { ChevronDown, CircleAlert, Database, Download, LoaderCircle, RefreshCw } from "lucide-react";
import type { usePersistentRuns } from "@/hooks/use-persistent-runs";
import type { SavedSimulationRun } from "@/types/run-history";
import { BenchmarkRow } from "@/components/benchmark-row";
import { BenchmarkComparison } from "@/components/benchmark-comparison";
import { benchmarkExportRuns, MAX_COMPARISON_RUNS, selectedBenchmarkRuns, toggleBenchmarkSelection } from "@/lib/benchmark-comparison";
import { downloadBenchmark } from "@/lib/benchmark-export";

export function PersistentRunHistory({ history, onRestore }: { history: ReturnType<typeof usePersistentRuns>; onRestore: (run: SavedSimulationRun) => void }) {
  const [showAll, setShowAll] = useState(false);
  const listId = useId();
  const [namedOnly, setNamedOnly] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [downloadMessage, setDownloadMessage] = useState<string | null>(null);
  const candidates = namedOnly ? history.runs.filter(run => run.isSnapshot && run.snapshotName) : history.runs.slice(0, 20);
  const visibleRuns = candidates.slice(0, showAll ? candidates.length : 5);
  const selectedRuns = selectedBenchmarkRuns(history.runs, selectedIds);
  const exportRuns = benchmarkExportRuns(history.runs, visibleRuns, selectedIds);
  const toggleSelection = (id: string) => {
    setSelectedIds(current => toggleBenchmarkSelection(history.runs, current, id));
    setDownloadMessage(null);
  };
  const exportTelemetry = (format: "csv" | "json") => {
    try {
      downloadBenchmark(exportRuns, format);
      setDownloadMessage(`Downloaded ${exportRuns.length} ${exportRuns.length === 1 ? "run" : "runs"} as ${format.toUpperCase()}.`);
    } catch { setDownloadMessage("Download could not start. Please retry."); }
  };
  const hasNotice = history.message || history.savingCount > 0 || history.pendingCount > history.savingCount || history.availability === "loading" || (history.availability === "ready" && history.runs.length === 0);
  return (
    <section aria-label="Persistent Run History" className="mt-4 overflow-hidden rounded-xl border border-slate-800 bg-slate-900/35">
      <div className="console-header flex flex-wrap items-center justify-between gap-2 border-b border-slate-700/80 p-3">
        <div className="flex items-center gap-2"><Database size={16} className="text-cyan-400" /><div><h2 className="text-sm font-semibold text-cyan-100">Persistent Run History</h2><p className="mt-0.5 text-[10px] text-slate-500">Latest {visibleRuns.length} of {candidates.length} {namedOnly ? "named snapshots" : "recent runs"} · Central time</p></div></div>
        <div className="flex flex-wrap items-center gap-2">
          {(["csv", "json"] as const).map(format => <button type="button" key={format} disabled={!exportRuns.length} onClick={() => exportTelemetry(format)} className="inline-flex min-h-8 items-center gap-1.5 rounded-lg border border-cyan-400/25 px-2.5 py-1.5 text-[11px] text-cyan-200 hover:bg-cyan-400/10 disabled:opacity-40"><Download size={12} />Export {format.toUpperCase()}</button>)}
          {candidates.length > 5 && <button type="button" aria-expanded={showAll} aria-controls={listId} onClick={() => setShowAll(value => !value)} className="inline-flex min-h-8 items-center gap-1.5 rounded-lg border border-slate-700 px-2.5 py-1.5 text-[11px] text-slate-300 hover:border-cyan-400/50">{showAll ? "Show latest 5" : `Show all ${candidates.length} runs`}<ChevronDown size={12} className={showAll ? "rotate-180" : ""} /></button>}
          <button type="button" disabled={history.refreshing} onClick={() => { void history.refresh(); }} className="inline-flex min-h-8 items-center gap-1.5 rounded-lg border border-slate-700 px-2.5 py-1.5 text-[11px] text-slate-300 hover:border-cyan-400/50 disabled:opacity-50"><RefreshCw size={12} className={history.refreshing ? "animate-spin" : ""} />Refresh history</button>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 p-2">
        <div role="group" aria-label="Benchmark history filter" className="flex flex-wrap gap-1">
          {[false, true].map(value => <button key={String(value)} type="button" aria-pressed={namedOnly === value} onClick={() => { setNamedOnly(value); setShowAll(false); setDownloadMessage(null); }} className={`min-h-8 rounded-md px-3 py-1 text-[11px] ${namedOnly === value ? "bg-cyan-400/10 text-cyan-200" : "text-slate-400 hover:bg-slate-800"}`}>{value ? "Named Snapshots Only" : "All Recent Runs"}</button>)}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[10px] text-slate-400">
          <span role="status" aria-label="Benchmark selection status">{selectedRuns.length} / {MAX_COMPARISON_RUNS} selected · Exporting {selectedRuns.length ? `${selectedRuns.length} selected runs (including hidden rows)` : `${visibleRuns.length} displayed rows`}</span>
          {selectedRuns.length > 0 && <button type="button" onClick={() => { setSelectedIds([]); setDownloadMessage(null); }} className="rounded border border-slate-700 px-2 py-1 text-slate-300 hover:border-cyan-400/50">Clear selection</button>}
        </div>
      </div>
      {downloadMessage && <p role="status" className="px-3 py-2 text-[10px] text-cyan-200">{downloadMessage}</p>}
      {hasNotice && <div aria-live="polite" className="space-y-2 p-3">
        {history.message && <div className="flex items-start gap-3 rounded-lg border border-amber-400/20 bg-amber-400/5 p-4 text-xs leading-6 text-amber-200"><CircleAlert size={16} className="mt-1 shrink-0" /><p className="min-w-0 [overflow-wrap:anywhere]">{history.message}</p></div>}
        {history.savingCount > 0 && <p className="flex items-center gap-2 text-xs text-cyan-300"><LoaderCircle size={13} className="animate-spin" />Saving {history.savingCount} {history.savingCount === 1 ? "run" : "runs"} in the background…</p>}
        {history.pendingCount > history.savingCount && <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-800 p-3"><p className="max-w-2xl text-xs leading-6 text-slate-400">{history.pendingCount} {history.pendingCount === 1 ? "run is" : "runs are"} awaiting save in this tab. Unsaved runs are lost if you close or reload the page.</p><button type="button" onClick={history.retryPending} className="shrink-0 rounded-md border border-cyan-400/30 px-3 py-2 text-xs text-cyan-200">Retry saving</button></div>}
        {history.availability === "loading" && <p className="flex items-center gap-2 py-4 text-xs text-slate-400"><LoaderCircle size={14} className="animate-spin" />Loading saved runs…</p>}
        {history.availability === "ready" && history.runs.length === 0 && <p className="py-6 text-center text-sm text-slate-400">No saved runs yet. Completed simulations will appear here automatically.</p>}
      </div>}
      {namedOnly && candidates.length === 0 && <p className="p-4 text-xs text-slate-400">No named snapshots yet. Capture a completed run or name a recent run.</p>}
      <BenchmarkComparison runs={selectedRuns} onRemove={toggleSelection} />
      <div id={listId} role="region" aria-label="Benchmark Comparison Table" tabIndex={0} className="overflow-x-auto">
        <table className="w-full min-w-[1280px] table-fixed text-left">
          <caption className="sr-only">Benchmark comparison of saved configurations, compute and I/O latency, coherence, and bottlenecks</caption>
          <colgroup>{[3, 14, 10, 10, 12, 11, 8, 8, 11, 13].map((width, index) => <col key={index} style={{ width: `${width}%` }} />)}</colgroup>
          <thead className="console-header border-b border-slate-700/80 text-[9px] font-semibold uppercase text-slate-300"><tr><th scope="col" className="p-2"><span className="sr-only">Compare (up to 3 runs)</span></th>{["Snapshot Name / Timestamp", "Scale & Hardware Profile", "Stage Route · S1 → S2 → S3", "Qubits · Allocated / Available", "Pure Compute / Interconnect", "Total Latency", "Coherence / Budget", "Primary Bottleneck", "Actions"].map(label => <th scope="col" key={label} className="p-2 font-semibold">{label}</th>)}</tr></thead>
          <tbody>{visibleRuns.map(run => <BenchmarkRow key={run.id} run={run} busy={history.busyIds.includes(run.id)} selected={selectedRuns.some(selected => selected.id === run.id)} selectionDisabled={selectedRuns.length >= MAX_COMPARISON_RUNS && !selectedRuns.some(selected => selected.id === run.id)} onSelect={toggleSelection} onName={history.nameSnapshot} onDelete={history.deleteRun} onRestore={onRestore} />)}</tbody>
        </table>
      </div>
    </section>
  );
}

"use client";

import { X } from "lucide-react";
import { benchmarkComparison } from "@/lib/benchmark-comparison";
import type { SavedSimulationRun } from "@/types/run-history";
import { hardwareLabel } from "@/lib/hardware-profiles";

export function BenchmarkComparison({ runs, onRemove }: { runs: SavedSimulationRun[]; onRemove: (id: string) => void }) {
  const columns = benchmarkComparison(runs);
  if (!columns.length) return null;
  return <section aria-label="Selected benchmark comparison" className="border-b border-slate-700/80 bg-cyan-400/[0.025]">
    <div className="console-header border-b border-slate-800 px-3 py-2">
      <h3 className="text-xs font-semibold text-cyan-100">Side-by-side snapshot comparison</h3>
      <p className="mt-1 text-[10px] text-slate-400">Deltas use the first selected run as reference. {columns.length === 1 ? "Select another run to compare." : "Blocked runs show only executed work."}</p>
    </div>
    <div role="region" aria-label="Comparison matrix" tabIndex={0} className="overflow-x-auto">
      <table className="w-full min-w-[640px] table-fixed text-left text-[10px]">
        <caption className="sr-only">Systems metrics and differences relative to the first selected benchmark</caption>
        <thead className="border-b border-slate-700/80 text-cyan-100"><tr>
          <th scope="col" className="w-36 p-2 font-semibold">Systems metric</th>
          {columns.map(({ run }, index) => <th scope="col" key={run.id} className="p-2 align-top font-semibold">
            <div className="flex items-start justify-between gap-2"><span className="min-w-0 [overflow-wrap:anywhere]">{run.snapshotName ?? run.scaleLabel}</span><button type="button" aria-label={`Remove ${run.snapshotName ?? run.scaleLabel} from comparison`} onClick={() => onRemove(run.id)} className="shrink-0 rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-cyan-200"><X size={12} /></button></div>
            <span className="mt-1 block text-[9px] font-normal text-slate-400">{run.scaleLabel} · {hardwareLabel(run.hardwareProfile)} · {run.stage1Node} → {run.stage2Node} → {run.stage3Node}</span>
            <span className="mt-1 block text-[9px] font-normal text-cyan-400">{index === 0 ? "Reference run" : "Compared with reference"}</span>
          </th>)}
        </tr></thead>
        <tbody>{columns[0].metrics.map((metric, index) => <tr key={metric.label} className="border-b border-slate-800/70 last:border-0">
          <th scope="row" className="p-2 align-top font-medium text-slate-400">{metric.label}</th>
          {columns.map(column => { const cell = column.metrics[index]; return <td key={column.run.id} className={`p-2 align-top [overflow-wrap:anywhere] ${cell.changed ? "bg-cyan-400/5" : ""}`}>
            <p title={cell.raw} className="font-mono text-slate-200">{cell.value}</p>
            {cell.delta && <p title={cell.rawDelta} className={`mt-0.5 text-[9px] ${cell.changed ? "text-cyan-300" : "text-slate-500"}`}>{cell.delta}</p>}
          </td>; })}
        </tr>)}</tbody>
      </table>
    </div>
  </section>;
}

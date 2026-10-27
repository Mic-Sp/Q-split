import { pipelineLatencyBuckets } from "@/lib/kpi-metrics";
import type { HybridTelemetryResponse } from "@/types/telemetry";

const milliseconds = new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 });
const shareLabel = (share: number) => share > 0 && share < 0.1 ? "<0.1%" : `${share.toFixed(1)}%`;
const BUCKETS = [
  { key: "classicalMs", label: "Classical Compute", color: "bg-cyan-400", text: "text-cyan-300" },
  { key: "quantumMs", label: "Quantum Gate Execution", color: "bg-violet-400", text: "text-violet-300" },
  { key: "overheadMs", label: "Interconnect & Control Overhead", color: "bg-amber-400", text: "text-amber-300" },
] as const;

export function LatencyProportion({ data }: { data?: HybridTelemetryResponse }) {
  const timing = data ? pipelineLatencyBuckets(data) : null;
  const segments = BUCKETS.map(bucket => {
    const latency = timing?.[bucket.key] ?? 0;
    return { ...bucket, latency, share: timing && timing.totalMs > 0 ? latency / timing.totalMs * 100 : 0 };
  });
  const hasLatency = timing !== null && timing.totalMs > 0;

  return <section aria-label="Latency Proportion & Interconnect Overhead" className="rounded-xl border border-slate-800 bg-slate-900/35 p-4 sm:p-5">
    <div className="mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <h2 className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Latency Proportion &amp; Interconnect Overhead</h2>
      <p className="text-[10px] text-slate-500">Modeled wall-clock total <span className="ml-1 font-mono tabular-nums text-slate-300">{timing ? `${milliseconds.format(timing.totalMs)} ms` : "—"}</span></p>
    </div>
    <div role="img" aria-label={hasLatency ? segments.map(segment => `${segment.label}: ${milliseconds.format(segment.latency)} ms (${shareLabel(segment.share)})`).join("; ") : data ? "No active execution latency" : "Awaiting simulation telemetry"}
      className="flex h-4 w-full overflow-hidden rounded-md bg-slate-800/70 ring-1 ring-inset ring-slate-700/40">
      {hasLatency && segments.filter(segment => segment.latency > 0).map(segment => <span key={segment.key} aria-hidden="true" data-latency-segment={segment.key}
        title={`${segment.label}: ${milliseconds.format(segment.latency)} ms · ${shareLabel(segment.share)}`}
        style={{ width: `${segment.share}%`, minWidth: 8 }}
        className={`${segment.color} border-r border-slate-950/50 last:border-r-0`} />)}
    </div>
    <dl className="mt-4 grid gap-3 sm:grid-cols-3">
      {segments.map(segment => <div key={segment.key} className="min-w-0">
        <dt className="flex items-center gap-2 text-[10px] leading-4 text-slate-400"><span aria-hidden="true" className={`size-2 shrink-0 rounded-sm ${segment.color}`} />{segment.label}</dt>
        <dd className="mt-1 pl-4 font-mono text-xs tabular-nums"><span className={segment.text}>{timing ? `${milliseconds.format(segment.latency)} ms` : "—"}</span><span className="ml-2 text-[10px] text-slate-500">{timing ? shareLabel(segment.share) : "—"}</span></dd>
      </div>)}
    </dl>
    <p className="mt-3 text-[10px] leading-4 text-slate-500">{!data ? "Run a simulation to view the latency proportions." : !hasLatency ? "No active execution time recorded. Blocked stages contribute 0 ms." : "Non-zero segments have a minimum visible width; legend percentages show their actual shares."}</p>
  </section>;
}

import { pipelineLatencyBuckets } from "@/lib/kpi-metrics";
import { formatDuration, formatRawMilliseconds } from "@/lib/duration";
import type { HybridTelemetryResponse } from "@/types/telemetry";

const shareLabel = (share: number) => share > 0 && share < 0.1 ? "<0.1%" : `${share.toFixed(1)}%`;
const BUCKETS = [
  { key: "classicalMs", label: "Classical Compute", shortLabel: "Classical compute", color: "bg-cyan-400", text: "text-cyan-300" },
  { key: "quantumMs", label: "Quantum Gate Execution", shortLabel: "QPU gates", color: "bg-violet-400", text: "text-violet-300" },
  { key: "overheadMs", label: "Interconnect & Control Overhead", shortLabel: "I/O & control", color: "bg-amber-400", text: "text-amber-300" },
] as const;

/**
 * Render numerical latency shares with a visual floor for tiny nonzero segments.
 * Legend and accessible labels use actual bucket percentages, not minimum-width
 * pixels. A zero/missing total produces an explicit empty state rather than division by zero.
 */
export function LatencyProportion({ data, compact = false }: { data?: HybridTelemetryResponse; compact?: boolean }) {
  const timing = data ? pipelineLatencyBuckets(data) : null;
  const segments = BUCKETS.map(bucket => {
    const latency = timing?.[bucket.key] ?? 0;
    return { ...bucket, latency, share: timing && timing.totalMs > 0 ? latency / timing.totalMs * 100 : 0 };
  });
  const hasLatency = timing !== null && timing.totalMs > 0;

  return <section aria-label="Latency Proportion & Interconnect Overhead" className={compact ? "min-w-0 p-3" : "rounded-xl border border-slate-800 bg-slate-900/35 p-4 sm:p-5"}>
    <div className={`console-header flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-slate-700/80 ${compact ? "-mx-3 -mt-3 mb-[7px] px-3 pt-3" : "-mx-4 -mt-4 mb-[15px] px-4 pt-4 sm:-mx-5 sm:-mt-5 sm:px-5 sm:pt-5"}`}>
      <h2 className="text-[10px] font-bold uppercase tracking-wider text-slate-100">{compact ? "Latency proportions" : "Latency Proportion & Interconnect Overhead"}</h2>
      {!compact && <p className="text-[10px] text-slate-500">Modeled wall-clock total <span title={formatRawMilliseconds(timing?.totalMs)} className="ml-1 font-mono tabular-nums text-slate-300">{formatDuration(timing?.totalMs)}</span></p>}
    </div>
    <div role="img" aria-label={hasLatency ? segments.map(segment => `${segment.label}: ${formatDuration(segment.latency)} (${shareLabel(segment.share)})`).join("; ") : data ? "No active execution latency" : "Awaiting simulation telemetry"}
      title="Non-zero segments have an 8px minimum width; legend percentages show actual shares."
      className={`flex ${compact ? "h-2.5" : "h-4"} w-full overflow-hidden rounded-md bg-slate-800/70 ring-1 ring-inset ring-slate-700/40`}>
      {hasLatency && segments.filter(segment => segment.latency > 0).map(segment => <span key={segment.key} aria-hidden="true" data-latency-segment={segment.key}
        title={`${segment.label}: ${formatDuration(segment.latency)} · ${formatRawMilliseconds(segment.latency)} · ${shareLabel(segment.share)}`}
        style={{ width: `${segment.share}%`, minWidth: 8 }}
        className={`${segment.color} border-r border-slate-950/50 last:border-r-0`} />)}
    </div>
    <dl className={compact ? "mt-2 space-y-1.5" : "mt-4 grid gap-3 sm:grid-cols-3"}>
      {segments.map(segment => <div key={segment.key} className={`min-w-0 ${compact ? "flex flex-wrap items-center justify-between gap-x-1" : ""}`}>
        <dt title={segment.label} aria-label={segment.label} className="flex items-center gap-1.5 text-[10px] leading-4 text-slate-400"><span aria-hidden="true" className={`size-2 shrink-0 rounded-sm ${segment.color}`} />{compact ? segment.shortLabel : segment.label}</dt>
        <dd className={`${compact ? "text-[9px]" : "mt-1 pl-4 text-xs"} font-mono tabular-nums`}><span title={formatRawMilliseconds(timing ? segment.latency : undefined)} className={segment.text}>{formatDuration(timing ? segment.latency : undefined)}</span><span className="ml-1.5 text-[9px] text-slate-500">{timing ? shareLabel(segment.share) : "—"}</span></dd>
      </div>)}
    </dl>
    {(!compact || !hasLatency) && <p className="mt-2 text-[10px] leading-4 text-slate-500">{!data ? "Run a simulation to view the latency proportions." : !hasLatency ? "No active execution time recorded. Blocked stages contribute 0 ms." : "Non-zero segments have a minimum visible width; legend percentages show their actual shares."}</p>}
  </section>;
}

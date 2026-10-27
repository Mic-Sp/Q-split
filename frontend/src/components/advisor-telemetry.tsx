import { AdvisorSourceBadge } from "@/components/advisor-source-badge";
import type { AdvisorInsight } from "@/types/advisor";

const tokens = (value: number) => value.toLocaleString("en-US");
const usd = (value: number) => `$${value.toFixed(6)}`;

export function AdvisorTelemetryBar({ insight }: { insight: AdvisorInsight }) {
  const current = insight.telemetry;
  const original = insight.usage;
  const reused = insight.source === "cached" || current?.shared;
  return <div aria-label="AI Inference Telemetry & Unit Economics" className="@container overflow-hidden rounded-lg border border-cyan-400/15 bg-slate-950/70">
    <div className="console-header border-b border-slate-700/80 px-3 py-2 text-[9px] font-bold uppercase tracking-widest text-cyan-100">AI Inference Telemetry &amp; Unit Economics</div>
    <dl className="grid grid-cols-2 gap-x-3 gap-y-2 p-3 text-[10px] @2xl:grid-cols-[1.1fr_1.4fr_1.2fr_0.7fr]">
      <div><dt className="mb-1.5 text-slate-500">Execution source</dt><dd><AdvisorSourceBadge source={insight.source} />{current?.shared && <span className="ml-2 text-slate-400">Shared response</span>}</dd></div>
      <div><dt className="mb-1.5 text-slate-500">API tokens · Input / Output / Total</dt><dd className="font-mono tabular-nums text-cyan-100">{current ? `${tokens(current.inputTokens)} / ${tokens(current.outputTokens)} / ${tokens(current.totalTokens)}` : "Unavailable"}{current?.tokenSource === "estimated" && <span className="ml-1 font-sans text-slate-500">≈ estimated</span>}</dd></div>
      <div><dt className="mb-1.5 text-slate-500">Estimated run cost · USD</dt><dd className={`font-mono tabular-nums ${reused ? "text-emerald-300" : "text-cyan-100"}`}>{current ? usd(current.estimatedCostUsd) : "Unavailable"}{insight.source === "cached" && <span className="ml-1 font-sans text-[9px]">(Cache Saved)</span>}</dd></div>
      <div><dt className="mb-1.5 text-slate-500">Lookup latency</dt><dd className="font-mono tabular-nums text-cyan-100">{current?.latencyMs != null ? `${tokens(current.latencyMs)} ms` : "—"}</dd></div>
    </dl>
    {reused && <p className="border-t border-slate-800/80 px-3 py-2 text-[10px] leading-5 text-slate-400">
      {original ? <>Original generation{original.tokenSource === "estimated" ? " (estimated)" : ""}: <span className="font-mono">{tokens(original.inputTokens)} / {tokens(original.outputTokens)} / {tokens(original.totalTokens)}</span> tokens · <span className="font-mono text-emerald-300">{usd(current?.costSavedUsd ?? 0)}</span> saved this lookup.</> : "Original token metrics unavailable for this older diagnostic."}
    </p>}
  </div>;
}

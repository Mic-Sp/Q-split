"use client";

import { useEffect, useRef, useState } from "react";
import { BrainCircuit, CircleAlert, LoaderCircle, Sparkles } from "lucide-react";
import { AdvisorDiagnostic } from "@/components/advisor-diagnostic";
import { deterministicInsight, parseAdvisorInsight } from "@/lib/advisor";
import type { Snapshot } from "@/lib/telemetry";
import type { AdvisorInsight } from "@/types/advisor";
import type { CompletedRun } from "@/types/run-history";

const completedRun = (snapshot: Snapshot): CompletedRun => ({
  id: snapshot.id, completedAt: snapshot.completedAt, request: snapshot.request, telemetry: snapshot.data,
});

export function TelemetryAdvisor({ snapshot, previous, onInsight, savedInsight, saving, persistenceMessage, simulationLoading }: {
  snapshot: Snapshot | null;
  previous?: Snapshot;
  onInsight: (run: CompletedRun) => void;
  savedInsight?: AdvisorInsight | null;
  saving: boolean;
  persistenceMessage: string | null;
  simulationLoading: boolean;
}) {
  const [insight, setInsight] = useState<AdvisorInsight | null>(null);
  const [loading, setLoading] = useState(false);
  const [compare, setCompare] = useState(true);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);

  const generate = async () => {
    if (!snapshot || loading) return;
    controller.current?.abort();
    const active = new AbortController(); controller.current = active;
    const current = completedRun(snapshot);
    const prior = compare && previous ? completedRun(previous) : undefined;
    setLoading(true);
    let result: AdvisorInsight;
    try {
      const response = await fetch("/api/advisor", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ current, previous: prior }),
        signal: AbortSignal.any([active.signal, AbortSignal.timeout(22_000)]),
      });
      if (!response.ok) throw new Error("Advisor request failed");
      result = parseAdvisorInsight((await response.json()).insight, current.id);
    } catch (error) {
      if (active.signal.aborted) return;
      result = deterministicInsight(current, prior, error instanceof Error && error.name === "TimeoutError" ? "timeout" : "network_error");
    }
    if (active.signal.aborted) return;
    setInsight(result); setLoading(false);
    onInsight({ ...current, advisorInsight: result });
  };
  const saved = insight && savedInsight?.generatedAt === insight.generatedAt;

  return <section aria-label="AI Telemetry Advisor" className="mt-8 rounded-2xl border border-cyan-400/20 bg-slate-900/40">
    <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 p-5 sm:px-6">
      <div className="flex items-center gap-3"><BrainCircuit size={20} className="shrink-0 text-cyan-400" /><div>
        <h2 className="text-sm font-semibold">AI Telemetry Advisor</h2>
        <p className="mt-1 text-xs leading-5 text-slate-400">Architecture diagnostics for the completed simulation. Generated on demand.</p>
      </div></div>
      <button type="button" disabled={!snapshot || loading || simulationLoading} onClick={() => { void generate(); }} className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-cyan-400/30 bg-cyan-400/10 px-4 py-2 text-xs font-semibold text-cyan-200 hover:bg-cyan-400/15 disabled:cursor-not-allowed disabled:opacity-50">
        {loading ? <LoaderCircle size={14} className="animate-spin" /> : <Sparkles size={14} />}{loading ? "Analyzing telemetry…" : insight ? "Regenerate analysis" : "Generate analysis"}
      </button>
    </div>
    <div className="space-y-4 p-5 sm:p-6">
      {snapshot && <p className="text-xs leading-6 text-slate-400">Analyzing {snapshot.data.scale_label} · {snapshot.request.hardware_profile} · {Object.values(snapshot.data.stages).map((stage) => stage.node).join(" → ")}. Uses completed-run settings even if controls have since changed.</p>}
      {previous && <label className="flex items-center gap-2 text-xs leading-5 text-slate-400"><input type="checkbox" checked={compare} onChange={(event) => setCompare(event.target.checked)} disabled={loading} className="size-4 shrink-0 accent-cyan-400" />Compare with previous completed run ({previous.data.scale_label})</label>}
      {loading && <p role="status" className="flex items-center gap-2 text-xs text-cyan-200"><LoaderCircle size={14} className="animate-spin" />Analyzing routing, qubit budget, and telemetry. Simulations remain available.</p>}
      {!insight && !loading && <p className="py-3 text-sm leading-6 text-slate-400">{snapshot ? "Generate a diagnostic to explain this run’s bottlenecks and choose the next configuration to try." : "Run a simulation to enable the advisor."}</p>}
      {insight && <>
        <p className="text-[10px] font-semibold uppercase tracking-wider text-cyan-300">{insight.source === "gemini" ? `Gemini · ${insight.model}` : "Local deterministic diagnostic"}{insight.previousRunId ? " · includes previous-run comparison" : ""}</p>
        {insight.notice && <div role="status" className="flex gap-2 rounded-lg border border-amber-400/20 bg-amber-400/5 p-3 text-xs leading-6 text-amber-200"><CircleAlert size={15} className="mt-1 shrink-0" /><p>{insight.notice}</p></div>}
        <AdvisorDiagnostic insight={insight} />
        <p role="status" className="text-xs leading-6 text-slate-400">{saved ? "Insight saved with this run in Persistent Run History." : saving ? "Saving insight in the background…" : "Insight is available in this tab; use Retry saving in Persistent Run History if its save is pending."}</p>
        {!saved && persistenceMessage && <p className="text-xs leading-6 text-amber-200 [overflow-wrap:anywhere]">{persistenceMessage}</p>}
        <p className="text-[10px] leading-5 text-slate-500">Generated guidance interprets this simulator’s estimates; it is not a physical hardware measurement.</p>
      </>}
    </div>
  </section>;
}

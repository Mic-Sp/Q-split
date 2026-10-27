"use client";

import { useEffect, useRef, useState } from "react";
import { BrainCircuit, CircleAlert, LoaderCircle, Sparkles } from "lucide-react";
import { AdvisorDiagnostic } from "@/components/advisor-diagnostic";
import { AdvisorTelemetryBar } from "@/components/advisor-telemetry";
import { deterministicInsight, parseAdvisorInsight } from "@/lib/advisor";
import { cachedInsight, withLookupTelemetry } from "@/lib/advisor-telemetry";
import type { Snapshot } from "@/lib/telemetry";
import type { AdvisorInsight, AdvisorResponse } from "@/types/advisor";
import type { CompletedRun } from "@/types/run-history";

const completedRun = (snapshot: Snapshot): CompletedRun => ({
  id: snapshot.id, completedAt: snapshot.completedAt, request: snapshot.request, telemetry: snapshot.data,
});

export function TelemetryAdvisor({ snapshot, previous, onInsight, onPersisted, savedInsight, saving, persistenceMessage, simulationLoading }: {
  snapshot: Snapshot | null;
  previous?: Snapshot;
  onInsight: (run: CompletedRun) => void;
  onPersisted: () => void;
  savedInsight?: AdvisorInsight | null;
  saving: boolean;
  persistenceMessage: string | null;
  simulationLoading: boolean;
}) {
  const [generated, setGenerated] = useState<AdvisorInsight | null>(null);
  const [serverSaved, setServerSaved] = useState(false);
  const [cacheMessage, setCacheMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [compare, setCompare] = useState(true);
  const controller = useRef<AbortController | null>(null);
  const inFlight = useRef(false);
  useEffect(() => () => controller.current?.abort(), []);
  const comparisonId = compare && previous ? previous.id : null;
  const available = generated?.previousRunId === comparisonId ? generated : savedInsight?.previousRunId === comparisonId ? savedInsight : null;
  const insight = available === savedInsight && available ? cachedInsight(available) : available;

  const generate = async () => {
    // A synchronous guard protects rapid clicks before React commits loading.
    if (!snapshot || inFlight.current || simulationLoading) return;
    inFlight.current = true;
    controller.current?.abort();
    const active = new AbortController(); controller.current = active;
    const current = completedRun(snapshot);
    const prior = compare && previous ? completedRun(previous) : undefined;
    setLoading(true);
    const started = performance.now();
    let result: AdvisorInsight;
    let persisted = false;
    let message: string | null = null;
    try {
      try {
        const response = await fetch("/api/advisor", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ current, previous: prior }),
          signal: AbortSignal.any([active.signal, AbortSignal.timeout(26_000)]),
        });
        if (!response.ok) throw new Error("Advisor request failed");
        const body = await response.json() as AdvisorResponse;
        result = parseAdvisorInsight(body.insight, current.id);
        persisted = body.persistence?.status === "saved";
        message = body.persistence?.message ?? null;
      } catch (error) {
        if (active.signal.aborted) return;
        result = withLookupTelemetry(deterministicInsight(current, prior, error instanceof Error && error.name === "TimeoutError" ? "timeout" : "network_error"), Math.round(performance.now() - started));
      }
      if (active.signal.aborted) return;
      setGenerated(result); setServerSaved(persisted); setCacheMessage(message);
      if (persisted) onPersisted();
      else onInsight({ ...current, advisorInsight: result });
    } finally {
      inFlight.current = false;
      if (!active.signal.aborted) setLoading(false);
    }
  };
  const saved = insight && ((insight === generated && serverSaved) || savedInsight?.generatedAt === insight.generatedAt);

  return <section aria-label="AI Telemetry Advisor" className="min-w-0 rounded-xl border border-cyan-400/20 bg-slate-900/40">
    <div className="console-header flex flex-wrap items-center justify-between gap-2 rounded-t-xl border-b border-slate-700/80 p-3">
      <div className="flex items-center gap-2"><BrainCircuit size={16} className="shrink-0 text-cyan-400" /><div>
        <h2 className="text-sm font-semibold text-cyan-100">AI Telemetry Advisor</h2>
        <p className="mt-0.5 text-[10px] leading-4 text-slate-400">Completed-run architecture diagnostics · on demand</p>
      </div></div>
      <button type="button" disabled={!snapshot || loading || simulationLoading} onClick={() => { void generate(); }} className="inline-flex min-h-8 items-center gap-1.5 rounded-lg border border-cyan-400/30 bg-cyan-400/10 px-3 py-1.5 text-[11px] font-semibold text-cyan-200 hover:bg-cyan-400/15 disabled:cursor-not-allowed disabled:opacity-50">
        {loading ? <LoaderCircle size={14} className="animate-spin" /> : <Sparkles size={14} />}{loading ? "Analyzing telemetry…" : insight ? "Analyze run" : "Generate analysis"}
      </button>
    </div>
    <div className="space-y-3 p-3">
      {snapshot && <p className="text-[10px] leading-4 text-slate-400">Analyzing {snapshot.data.scale_label} · {snapshot.request.hardware_profile} · {Object.values(snapshot.data.stages).map((stage) => stage.node).join(" → ")}. Uses completed-run settings even if controls have since changed.</p>}
      {previous && <label className="flex items-center gap-2 text-xs leading-5 text-slate-400"><input type="checkbox" checked={compare} onChange={(event) => setCompare(event.target.checked)} disabled={loading} className="size-4 shrink-0 accent-cyan-400" />Compare with previous completed run ({previous.data.scale_label})</label>}
      {loading && <p role="status" className="flex items-center gap-2 text-xs text-cyan-200"><LoaderCircle size={14} className="animate-spin" />Analyzing routing, qubit budget, and telemetry. Simulations remain available.</p>}
      {!insight && !loading && <p className="py-3 text-sm leading-6 text-slate-400">{snapshot ? "Generate a diagnostic to explain this run’s bottlenecks and choose the next configuration to try." : "Run a simulation to enable the advisor."}</p>}
      {insight && <>
        <AdvisorTelemetryBar insight={insight} />
        <p className="text-[10px] font-semibold uppercase tracking-wider text-cyan-300">{insight.source !== "fallback" ? `Gemini · ${insight.model}` : "Local deterministic diagnostic"}{insight.previousRunId ? " · includes previous-run comparison" : ""}</p>
        {insight.notice && <div role="status" className="flex gap-2 rounded-lg border border-amber-400/20 bg-amber-400/5 p-3 text-xs leading-6 text-amber-200"><CircleAlert size={15} className="mt-1 shrink-0" /><p>{insight.notice}</p></div>}
        <AdvisorDiagnostic insight={insight} />
        <p role="status" className="text-xs leading-6 text-slate-400">{saved ? "Insight saved with this run in Persistent Run History." : saving ? "Saving insight in the background…" : "Insight is available in this tab; use Retry saving in Persistent Run History if its save is pending."}</p>
        {!saved && persistenceMessage && <p className="text-xs leading-6 text-amber-200 [overflow-wrap:anywhere]">{persistenceMessage}</p>}
        {!saved && cacheMessage && !persistenceMessage && <p className="text-xs leading-6 text-amber-200 [overflow-wrap:anywhere]">{cacheMessage}</p>}
        <p className="text-[10px] leading-5 text-slate-500">Generated guidance interprets this simulator’s estimates; it is not a physical hardware measurement.</p>
      </>}
    </div>
  </section>;
}

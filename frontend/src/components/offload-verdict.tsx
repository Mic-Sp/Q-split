import { Activity, CircleAlert, CircleCheck, CircleX } from "lucide-react";
import { offloadVerdict } from "@/lib/offload-verdict";
import type { Snapshot } from "@/lib/telemetry";

const STATUS = {
  optimal: { icon: CircleCheck, style: "border-emerald-400/20 bg-emerald-400/5 text-emerald-300" },
  warning: { icon: CircleAlert, style: "border-amber-400/20 bg-amber-400/5 text-amber-300" },
  blocked: { icon: CircleX, style: "border-rose-400/20 bg-rose-400/5 text-rose-300" },
};

export function OffloadVerdictStrip({ snapshot }: { snapshot: Snapshot | null }) {
  const verdict = snapshot ? offloadVerdict(snapshot.data, snapshot.request) : null;
  const style = verdict ? STATUS[verdict.status] : { icon: Activity, style: "border-slate-800 bg-slate-900/35 text-slate-400" };
  const Icon = style.icon;
  return <aside aria-label="Co-Design Offload Verdict" aria-live="polite" aria-atomic="true" className={`flex items-start gap-3 rounded-xl border px-4 py-3 sm:px-5 ${style.style}`}>
    <Icon size={17} aria-label={verdict ? `Offload status: ${verdict.status}` : "Awaiting telemetry"} className="mt-0.5 shrink-0" />
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1"><h2 className="text-[10px] font-semibold uppercase tracking-wider">Co-Design Offload Verdict</h2><p className="text-xs font-semibold">{verdict?.title ?? "Awaiting simulation"}</p></div>
      <p className="mt-1 text-xs leading-5 text-slate-300 [overflow-wrap:anywhere]">{verdict?.message ?? "Run a simulation to evaluate offload viability, resource limits, and interconnect costs."}</p>
    </div>
  </aside>;
}

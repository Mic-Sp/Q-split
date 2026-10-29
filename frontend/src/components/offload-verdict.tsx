import { Activity, CircleAlert, CircleCheck, CircleX } from "lucide-react";
import { offloadVerdict } from "@/lib/offload-verdict";
import type { Snapshot } from "@/lib/telemetry";
import { InfoPopover } from "@/components/info-popover";

const STATUS = {
  optimal: { icon: CircleCheck, style: "border-emerald-400/20 bg-emerald-400/5 text-emerald-300" },
  warning: { icon: CircleAlert, style: "border-amber-400/20 bg-amber-400/5 text-amber-300" },
  blocked: { icon: CircleX, style: "border-rose-400/20 bg-rose-400/5 text-rose-300" },
};

/**
 * Present the completed snapshot's systems verdict; compact text retains full context in an accessible popover.
 */
export function OffloadVerdictStrip({ snapshot, compact = false }: { snapshot: Snapshot | null; compact?: boolean }) {
  const verdict = snapshot ? offloadVerdict(snapshot.data, snapshot.request) : null;
  const style = verdict ? STATUS[verdict.status] : { icon: Activity, style: "border-slate-800 bg-slate-900/35 text-slate-400" };
  const Icon = style.icon;
  return <aside aria-label="Co-Design Offload Verdict" aria-live="polite" aria-atomic="true" className={`min-w-0 ${compact ? "p-3" : "overflow-hidden rounded-xl border px-4 py-3 sm:px-5"} ${style.style}`}>
    <div className={`console-header relative -mt-3 -mb-px border-b border-slate-700/80 pt-3 ${compact ? "-mx-3 pl-[37px] pr-3" : "-mx-4 pl-[45px] pr-4 sm:-mx-5 sm:pl-[49px] sm:pr-5"}`}>
      <Icon size={17} aria-label={verdict ? `Offload status: ${verdict.status}` : "Awaiting telemetry"} className={`absolute top-3.5 ${compact ? "left-3" : "left-4 sm:left-5"}`} />
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1"><h2 className="text-[9px] font-bold uppercase tracking-wider text-slate-100">Co-Design Offload Verdict</h2><p className={`${compact ? "text-[11px]" : "text-xs"} font-semibold`}>{verdict?.title ?? "Awaiting simulation"}</p>{compact && verdict && <InfoPopover label="Full co-design verdict"><p className="font-semibold text-cyan-200">{verdict.title}</p><p className="mt-2">{verdict.message}</p></InfoPopover>}</div>
    </div>
    <p className={`mt-1 ${compact ? "line-clamp-4 pl-[25px] text-[10px] leading-4" : "pl-[29px] text-xs leading-5"} text-slate-300 [overflow-wrap:anywhere]`}>{verdict?.message ?? "Run a simulation to evaluate offload viability, resource limits, and interconnect costs."}</p>
  </aside>;
}

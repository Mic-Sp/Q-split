import type { StageTelemetry } from "@/types/telemetry";
import { coherenceRangeLabel } from "@/lib/kpi-metrics";

/** Annotate an existing survival value without changing its status or thresholds. */
export function CoherenceRangeNote({ stage }: { stage?: StageTelemetry }) {
  const label = coherenceRangeLabel(stage);
  if (!label) return null;
  return <p className="mt-1 w-full text-[9px] leading-3 text-slate-600 dark:text-slate-400 [overflow-wrap:anywhere]"
    title="T1 point versus pessimistic T2 sensitivity, capped at the T1 point when T2 is longer. Both assume all-qubit exposure at 2Q-duration layers and may overlap calibrated gate errors. Model scenarios, not a confidence interval.">
    {label}
  </p>;
}

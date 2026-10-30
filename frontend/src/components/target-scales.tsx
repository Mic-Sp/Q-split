"use client";

import { useState } from "react";
import { TierTooltip } from "@/components/tier-tooltip";
import { SCALE_DESCRIPTIONS, WORKLOADS, workloadScaleLabel } from "@/lib/workloads";
import type { WorkloadId } from "@/types/telemetry";

/**
 * Render workload-specific scale choices with accessible context tooltips; selection changes controls only.
 */
export function TargetScales({ workload, scale, onSelect }: { workload: WorkloadId; scale: number; onSelect: (scale: number) => void }) {
  const [openScale, setOpenScale] = useState<number | null>(null);
  return <div className="flex flex-wrap gap-1.5">
    {WORKLOADS[workload].scales.map(value => <TierTooltip key={value} variant="scale" footer={false}
      label={workloadScaleLabel(value, workload)} selected={scale === value} onSelect={() => onSelect(value)}
      open={openScale === value} onOpenChange={open => setOpenScale(current => open ? value : current === value ? null : current)}>
      <p className="font-semibold text-cyan-800 dark:text-cyan-200">{workloadScaleLabel(value, workload)}</p>
      <p className="mt-2">{SCALE_DESCRIPTIONS[workload][value]}</p>
      <p className="mt-3 border-t border-slate-200 dark:border-slate-800 pt-2 text-[10px] leading-5 text-slate-600 dark:text-slate-400">Illustrative workload model; depth and timing depend on tier, routing, and hardware. Escape dismisses this tooltip.</p>
    </TierTooltip>)}
  </div>;
}

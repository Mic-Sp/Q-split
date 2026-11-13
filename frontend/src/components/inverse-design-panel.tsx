"use client";

import { useMemo, useState } from "react";
import type { CompletedRun } from "@/types/run-history";
import type { SimulationRequest } from "@/types/telemetry";
import { applyInverseDesignRecipe, inverseDesignTargets } from "@/lib/inverse-design";

const fmt = (value: number) => value === 0 ? "0" : value.toExponential(6);
const button = "rounded-lg border border-cyan-700/30 px-3 py-2 text-xs font-semibold text-cyan-800 dark:text-cyan-200 disabled:opacity-50";

export function InverseDesignPanel({ run, onApply, disabled }: { run: CompletedRun; onApply?: (request: SimulationRequest) => void; disabled?: boolean }) {
  const result = useMemo(() => inverseDesignTargets(run), [run]);
  const [target, setTarget] = useState(0.5);
  const [message, setMessage] = useState<string | null>(null);
  if (run.request.hardware_profile !== "custom") return null;
  const apply = (path: "balanced" | "surface_code") => {
    try {
      onApply?.(applyInverseDesignRecipe(run, target, path));
      setMessage(`Applied ${target * 100}% ${path === "balanced" ? "balanced recipe" : "surface-code configuration"} to the captured workload and capacity. Run simulation to verify.`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Recipe unavailable."); }
  };
  if (result.status !== "available") return <div aria-label="Inverse hardware design" className="rounded-lg border border-slate-300 p-3 text-xs dark:border-slate-700"><strong>Inverse hardware design</strong><p className="mt-2">{result.reason}</p></div>;
  const goal = result.targets.find(item => item.target_survival === target)!;
  const recipe = goal.balanced, surface = goal.surface_code, bottleneck = goal.single_bottleneck;
  return <div aria-label="Inverse hardware design" className="min-w-0 space-y-3 rounded-lg border border-cyan-700/25 bg-cyan-700/5 p-3 text-xs leading-5 [overflow-wrap:anywhere] dark:text-slate-200">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">Inverse hardware design · verified locally</h3>
      <label>Survival target <select aria-label="Inverse design survival target" value={target} onChange={event => { setTarget(Number(event.target.value)); setMessage(null); }} className="rounded border border-slate-400 bg-white p-1 dark:bg-slate-900"><option value={0.5}>50% viable target</option><option value={0.8}>80% stronger target</option></select></label>
    </div>
    <p>{run.request.custom_profile?.name} · {run.telemetry.scale_label}. Per-shot T1 point; T2 worst is a sensitivity bound, not confidence. Recorded circuit: {result.source.n_qubits} active qubits, {result.source.N2.toLocaleString()} native 2Q gates, {result.source.transfers_per_shot.toLocaleString()} transfers.</p>
    {recipe.status === "verified" ? <>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 sm:grid-cols-3">
        {Object.entries(recipe.parameters).map(([key, value]) => <div key={key} className="min-w-0"><dt className="text-slate-600 dark:text-slate-400">{key}</dt><dd className="break-all font-mono">{value === null ? "disabled / fallback" : key === "l_coupler_fidelity" ? value.toPrecision(12) : fmt(value)}{key.endsWith("_us") && value !== null ? " µs" : ""}</dd></div>)}
      </dl>
      <p>Forward check: {(recipe.verified_survival * 100).toFixed(6)}% point · {(recipe.worst_survival * 100).toFixed(6)}% worst. Uniform log-loss multiplier {fmt(recipe.k)}.</p>
      {onApply && <button type="button" className={button} disabled={disabled} onClick={() => apply("balanced")}>Apply Target Recipe to Custom Profile</button>}
      <details><summary className="cursor-pointer">Full-precision target parameters</summary><pre className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(recipe.parameters, null, 2)}</pre></details>
    </> : <p>{recipe.status === "already_met" ? "This target is already met; keep the current parameters." : recipe.reason}</p>}
    <p>Dominant point loss: <strong>{bottleneck.subsystem}</strong>. Perfecting only this subsystem yields a maximum {(100 * bottleneck.ceiling_survival).toPrecision(6)}% survival.
      {bottleneck.status === "solved" ? ` Target attainable alone: ${bottleneck.parameter} = ${fmt(bottleneck.value)}.` : bottleneck.status === "ceiling_below_target" ? " Other fixed losses prevent reaching this target alone." : bottleneck.status === "infinite_lifetime_required" ? " Reaching the ceiling requires infinite lifetime." : ""}</p>
    {surface && <div className="space-y-2 border-t border-cyan-700/20 pt-2">
      <h4 className="font-semibold">Surface-code alternative</h4>
      <p>Physical error {fmt(surface.physical_2q_error)} ({surface.physical_error_source.replaceAll("_", " ")}); threshold {fmt(surface.threshold_error)}, syndrome cycle {surface.syndrome_cycle_ns} ns. Reference-calibrated logical operation proxies.</p>
      {surface.status === "verified" ? <>
        <p>Minimum gate-budget d={surface.minimum_error_distance}; minimum whole-circuit verified <strong>d={surface.minimum_verified_distance}</strong>. Forward point {(100 * surface.verified_survival).toFixed(6)}% with {surface.circuit_us.toLocaleString()} µs coherent circuit time; logical gates can be slower.</p>
        <p>{surface.total_physical_qubits.toLocaleString()} physical qubits for configured capacity; {surface.active_circuit_physical_qubits.toLocaleString()} for the active circuit. {surface.nighthawk_r3_modules_required.toLocaleString()} equivalent Nighthawk r3 chips at 520 programmable qubits each (2d² per logical patch, excluding factories and routing). Physical chip counts do not become logical link topology.</p>
        {onApply && <button type="button" className={button} disabled={disabled} onClick={() => apply("surface_code")}>Apply Recommended d={surface.minimum_verified_distance} FTQC Config</button>}
      </> : <p role="status">{surface.status === "above_threshold" ? "Physical error is at or above threshold; increasing distance cannot suppress logical error. No FTQC recipe is offered." : surface.reason}</p>}
    </div>}
    {message && <p role="status">{message}</p>}
  </div>;
}

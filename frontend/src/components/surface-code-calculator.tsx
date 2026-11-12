"use client";

import { useState } from "react";
import type { CustomQPUProfileSpec, SurfaceCodeInputs } from "@/types/telemetry";
import { applySurfaceCodeParameters, calculateSurfaceCode, SURFACE_CODE_DEFAULTS } from "@/lib/surface-code";

const control = "mt-1 min-h-9 w-full min-w-0 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1.5 text-xs text-slate-800 dark:text-slate-200";
const button = "min-h-8 rounded-md border border-cyan-700/30 dark:border-cyan-400/30 px-2 py-1 text-[11px] text-cyan-800 dark:text-cyan-300 disabled:opacity-40";
const integer = (value: number) => value.toLocaleString("en-US");
const probability = (value: number) => value.toExponential(3);

/** Calculator state is a preview. Only Apply changes the captured hardware fields. */
export function SurfaceCodeCalculator({ profile, capacityText, activeCircuitQubits, onApply }: {
  profile: CustomQPUProfileSpec | null;
  capacityText: string;
  activeCircuitQubits?: number;
  onApply: (profile: CustomQPUProfileSpec) => void;
}) {
  const source = profile?.surface_code;
  const [distance, setDistance] = useState(String(source?.code_distance_d ?? SURFACE_CODE_DEFAULTS.code_distance_d));
  const [physicalError, setPhysicalError] = useState(String(source?.physical_2q_error ?? SURFACE_CODE_DEFAULTS.physical_2q_error));
  const [threshold, setThreshold] = useState(String(source?.threshold_error ?? SURFACE_CODE_DEFAULTS.threshold_error));
  const [cycle, setCycle] = useState(String(source?.syndrome_cycle_ns ?? SURFACE_CODE_DEFAULTS.syndrome_cycle_ns));
  const [targetOverride, setTargetOverride] = useState<string | null>(source ? String(source.logical_qubits_target) : null);
  const targetText = targetOverride ?? (capacityText.trim() || String(activeCircuitQubits ?? 1));
  let input: SurfaceCodeInputs | null = null, result: ReturnType<typeof calculateSurfaceCode> | null = null, error: string | null = null;
  try {
    if ([distance, physicalError, threshold, cycle, targetText].some(text => !text.trim() || !/^[+]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text.trim()))) throw new Error("Enter complete numeric values; scientific notation is supported.");
    input = { code_distance_d: Number(distance), physical_2q_error: Number(physicalError), threshold_error: Number(threshold), syndrome_cycle_ns: Number(cycle), logical_qubits_target: Number(targetText) };
    result = calculateSurfaceCode(input);
  } catch (reason) { error = reason instanceof Error ? reason.message : "Check surface-code inputs."; }
  let active: ReturnType<typeof calculateSurfaceCode> | null = null, activeError = false;
  if (result && input && Number.isSafeInteger(activeCircuitQubits) && activeCircuitQubits! >= 1) {
    try { active = calculateSurfaceCode({ ...input, logical_qubits_target: activeCircuitQubits! }); } catch { activeError = true; }
  }
  const currentPhysical = source?.physical_2q_error ?? profile?.err_2q;
  const loadablePhysical = currentPhysical != null && currentPhysical > 0 && currentPhysical < 1;
  const previewField = (label: string, text: string, set: (value: string) => void) => <label className="min-w-0 text-[11px]">{label}
    <input aria-label={label} type="text" inputMode="decimal" value={text} onChange={event => set(event.target.value)} className={control} spellCheck={false} />
  </label>;
  return <div aria-label="Surface-code distance calculator" className="min-w-0 space-y-3 p-3">
    <p className="text-[11px] text-slate-600 dark:text-slate-400">Preview physical-to-logical trade-offs, then apply them to the custom profile. The configured target is logical workspace capacity; physical chips are a separate footprint estimate.</p>
    <div className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-5">
      <label className="min-w-0 text-[11px]">Code distance d · odd ≥3<input aria-label="Surface-code distance d" type="number" min={3} step={2} value={distance} onChange={event => setDistance(event.target.value)} className={control} /></label>
      {previewField("Physical 2Q error probability", physicalError, setPhysicalError)}
      {previewField("Surface-code threshold probability", threshold, setThreshold)}
      {previewField("Syndrome cycle · ns", cycle, setCycle)}
      {previewField("Logical qubits target", targetText, setTargetOverride)}
    </div>
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <label className="flex min-w-0 flex-1 items-center gap-2 text-[11px]">Distance 3–35<input aria-label="Surface-code distance slider" type="range" min={3} max={35} step={2} value={Math.min(35, Math.max(3, Number(distance) || 3))} onChange={event => setDistance(event.target.value)} className="min-w-0 flex-1 accent-cyan-700" /></label>
      {[7, 15, 27].map(d => <button key={d} type="button" className={button} aria-pressed={Number(distance) === d} onClick={() => setDistance(String(d))}>d={d}</button>)}
      <button type="button" className={button} disabled={!loadablePhysical} onClick={() => { if (loadablePhysical) setPhysicalError(String(currentPhysical)); }}>Load current 2Q error</button>
      <button type="button" className={button} onClick={() => setPhysicalError("0.0037")}>Nighthawk physical proxy · 0.0037</button>
      <button type="button" className={button} onClick={() => { setDistance("27"); setPhysicalError("0.001"); setThreshold("0.01"); setCycle("1000"); }}>d=27 reference · p=0.001</button>
    </div>
    <p className="text-[10px] text-slate-500">Loading the current 2Q value interprets it as a physical noise proxy. Generated profiles reuse their recorded physical input; a manually entered logical gate error is not a physical error measurement.</p>
    {error && <p role="alert" className="text-xs text-rose-700 dark:text-rose-300">{error}</p>}
    {result && input && <>
      <div role="status" data-testid="surface-code-threshold" className={`rounded-md border px-2 py-1.5 text-[11px] ${result.is_below_threshold ? "border-emerald-700/30 text-emerald-800 dark:text-emerald-300" : "border-amber-700/40 text-amber-900 dark:text-amber-300"}`}>
        {result.is_below_threshold ? `Below threshold · each +2 distance multiplies round error by ${(input.physical_2q_error / input.threshold_error).toPrecision(3)} before clamping.`
          : input.physical_2q_error === input.threshold_error ? "At threshold · increasing d gives no exponential suppression; the round proxy stays constant."
          : "Above threshold · increasing d worsens the round error until saturation. Larger distance does not improve logical fidelity in this model."}
      </div>
      <dl className="grid min-w-0 gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {[
          ["Physical qubits per logical qubit · 2d²", integer(result.physical_qubits_per_logical), "surface-code-patch"],
          [`Total physical qubits · ${integer(input.logical_qubits_target)} logical`, integer(result.total_physical_qubits), "surface-code-total"],
          ["Nighthawk r3 chips · 520Q capacity basis", integer(result.nighthawk_r3_modules_required), "surface-code-modules"],
          ["Physical / logical 2Q error ratio", `${result.logical_error_suppression_ratio.toPrecision(4)}×`, "surface-code-suppression"],
          ["Raw logical error per syndrome round", probability(result.logical_error_per_round), "surface-code-round-error"],
          ["Calibrated logical 1Q error", probability(result.err_1q), "surface-code-1q-error"],
          ["Calibrated logical 2Q / readout error", probability(result.err_2q), "surface-code-2q-error"],
          ["Logical 2Q / readout duration", `${integer(result.t_2q_ns)} ns`, "surface-code-2q-duration"],
        ].map(([label, value, id]) => <div key={id} className="min-w-0 rounded-md border border-slate-200 dark:border-slate-700 p-2">
          <dt className="text-[10px] text-slate-600 dark:text-slate-400">{label}</dt><dd data-testid={id} className="mt-1 break-words font-mono text-xs text-cyan-900 dark:text-cyan-200">{value}</dd>
        </div>)}
      </dl>
      <p data-testid="surface-code-active-footprint" className="text-[11px] text-slate-600 dark:text-slate-400">{active
        ? `Last executed circuit if encoded: ${integer(activeCircuitQubits!)} logical patches → ${integer(active.total_physical_qubits)} physical qubits, approximately ${integer(active.nighthawk_r3_modules_required)} r3 chips at 520 programmable qubits/chip.`
        : activeError ? "The active-register footprint exceeds the supported numerical range at this distance." : "Run a feasible QPU circuit to show the physical footprint for its active register width."}</p>
      <p className="text-[10px] text-slate-500">1Q and reset take one cycle ({integer(result.t_1q_ns)} ns); 2Q lattice surgery and readout take d cycles. Footprint = logical target × 2d², with no factory, routing, decoder or interconnect overhead. The existing preset’s ~1,000-qubit footprint is coarse; this formula gives 1,458 at d=27.</p>
      <p className="text-[10px] text-slate-500">Chip count uses 520 programmable data/syndrome qubits per r3 chip, not all 2,034 physical elements. Dividing by 2,034 gives {integer(result.physical_element_equivalent_modules)} physical-element equivalents, which is not usable hosting capacity. These are illustrative footprint equivalents, not a feasible multi-chip QEC deployment estimate.</p>
      {result.logical_error_suppression_ratio < 1 && <p className="text-[11px] text-amber-800 dark:text-amber-300">The calibrated logical operation error exceeds the physical 2Q error here. Below-threshold round suppression alone does not guarantee a useful logical operation.</p>}
      {result.round_error_clamped && <p className="text-[10px] text-slate-500">Round error is clamped to [1e-18, 1]. Improvements can plateau at the numerical floor.</p>}
      <div role="region" aria-label="Surface-code distance trade-off" tabIndex={0} className="max-w-full overflow-x-auto">
        <table className="w-full text-left text-[10px]"><caption className="mb-1 text-left font-semibold">Distance trade-off at the current physical error and cycle time</caption>
          <thead><tr><th className="p-1">d</th><th className="p-1">Qubits / patch</th><th className="p-1">Logical 2Q error</th><th className="p-1">2Q duration · ns</th></tr></thead>
          <tbody>{[...new Set([7, 15, 27, 35, input.code_distance_d])].sort((a, b) => a - b).map(d => {
            const row = calculateSurfaceCode({ ...input!, code_distance_d: d });
            return <tr key={d} className={d === input!.code_distance_d ? "bg-cyan-700/10 dark:bg-cyan-400/10" : ""}><th scope="row" className="p-1">{d}</th><td className="p-1">{integer(row.physical_qubits_per_logical)}</td><td className="p-1 font-mono">{probability(row.err_2q)}</td><td className="p-1">{integer(row.t_2q_ns)}</td></tr>;
          })}</tbody>
        </table>
      </div>
      <details className="text-[10px] text-slate-600 dark:text-slate-400"><summary className="cursor-pointer font-semibold">Formula and reference calibration</summary>
        <p className="mt-1">ε_round = clamp(0.1 × (p_phys / p_th)^((d+1)/2), 1e-18, 1). At d=27, p_phys=0.001 and p_th=0.01, ε_ref ≈ 1e-15. Q-Split uses err_1q = min(1, 1e-10 × ε_round/ε_ref), and err_2q = err_meas = min(1, 1e-9 × ε_round/ε_ref). These fixed operation-error calibration factors are assumptions chosen to match ftqc_surface_code, not measured gate fidelities or extra elapsed syndrome rounds.</p>
        <p className="mt-1">The selected 1% threshold is illustrative and depends on noise/decoder assumptions. Changing cycle time changes durations; the per-round physical-error input remains fixed. See <a href="https://arxiv.org/abs/1208.0928" target="_blank" rel="noreferrer" className="underline">Fowler et al.</a> and <a href="https://quantum.cloud.ibm.com/learning/en/courses/tools-for-quantum-advantage/error-correction-ii" target="_blank" rel="noreferrer" className="underline">IBM’s error-correction overview</a>.</p>
      </details>
    </>}
    <button type="button" className={`${button} font-semibold`} disabled={!result || !input || !profile} onClick={() => { if (profile && input) onApply(applySurfaceCodeParameters(profile, input)); }}>Apply Surface-Code Parameters to Custom Profile</button>
    <p className="text-[10px] text-slate-500">Apply sets one logical workspace with T1/T2 disabled, routing/native-CX factors 1, and the calculated physical footprint. It clears inherited physical link channels, shot-rate limits and operation-count targets. Calculator edits remain previews until Apply.</p>
    {source && <p className="text-[10px] text-cyan-800 dark:text-cyan-300">Applied generator: d={source.code_distance_d}, p_phys={source.physical_2q_error}, cycle={source.syndrome_cycle_ns} ns · saved with presets and run history. Manual changes to generated fields clear this tag.</p>}
  </div>;
}

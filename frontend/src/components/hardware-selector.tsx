"use client";

import { HARDWARE_GROUPS, HARDWARE_PROFILES, MODULAR_QPU_PROFILES } from "@/lib/hardware-profiles";
import type { HardwareProfile, InterconnectConfig, CustomQPUProfileSpec } from "@/types/telemetry";
import { InfoPopover } from "@/components/info-popover";

const control = "min-h-9 w-full min-w-0 rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-2 py-1.5 text-[11px] text-slate-800 dark:text-slate-200";

/** Categories keep one canonical ID selected, including when restoring saved runs. */
export function HardwareSelector({ value, onChange, interconnect, onInterconnectChange, customProfile }: {
  value: HardwareProfile;
  onChange: (profile: HardwareProfile) => void;
  interconnect: InterconnectConfig;
  onInterconnectChange: (config: InterconnectConfig) => void;
  customProfile?: CustomQPUProfileSpec;
}) {
  const profile = HARDWARE_PROFILES[value];
  const modular = value === "ibm_nighthawk_r3" || value === "ibm_nighthawk_r3_dual" ? MODULAR_QPU_PROFILES[value] : null;
  return <div className="min-w-0 space-y-2">
    <label htmlFor="hardware-profile" className="sr-only">Hardware profile</label>
    <select id="hardware-profile" value={value} onChange={event => onChange(event.target.value as HardwareProfile)} className={control}>
      {HARDWARE_GROUPS.map(group => <optgroup key={group.label} label={group.label}>
        {group.ids.map(id => <option key={id} value={id}>{HARDWARE_PROFILES[id].label}</option>)}
      </optgroup>)}
    </select>
    <div aria-label="Hardware summary" className="flex flex-wrap items-center gap-1 text-[9px] text-slate-600 dark:text-slate-400">
      <span className="rounded border border-slate-300 dark:border-slate-700 px-1.5 py-0.5">{(value === "custom" ? customProfile?.n_qubits_max : profile.referenceQubits)?.toLocaleString("en-US") ?? "Exploratory"} {value === "ftqc_surface_code" ? "logical" : "programmable"} qubits</span>
      {value === "custom" && customProfile && <span>{customProfile.name} · {customProfile.module_count} module{customProfile.module_count === 1 ? "" : "s"} · User-defined</span>}
      {modular && <><span>{modular.physicalQubits.toLocaleString("en-US")} physical · {modular.moduleCount} module{modular.moduleCount === 1 ? "" : "s"}</span>
        <span>· {modular.activeLCouplers}/{modular.installedLCouplers} active l-couplers · 10,000 target operations</span></>}
      <InfoPopover label={`About ${profile.label}`}><p className="font-semibold">{profile.label}</p><p className="mt-2">{profile.description}</p><p className="mt-2">Selection sets reference capacity; manual overrides remain exploratory. Restoring a snapshot preserves its capacity and link controls.</p></InfoPopover>
    </div>
    {value === "ibm_nighthawk_r3_dual" && <fieldset className="min-w-0 rounded-lg border border-cyan-700/20 dark:border-cyan-400/20 p-2">
      <legend className="px-1 text-[10px] font-semibold text-cyan-800 dark:text-cyan-300">l-coupler scenario</legend>
      <div className="grid min-w-0 gap-2 sm:grid-cols-3">
        <label className="min-w-0 text-[10px]">Placement<select aria-label="Module placement" className={control} value={interconnect.placement ?? "auto"}
          onChange={event => onInterconnectChange({ ...interconnect, placement: event.target.value as "auto" | "dual" })}>
          <option value="auto">Auto · fill one 520Q module</option><option value="dual">Explicit · span both modules</option>
        </select></label>
        <label className="min-w-0 text-[10px]">Transfer fidelity<select aria-label="Transfer fidelity scenario" className={control} value={interconnect.fidelity_scenario ?? "demonstrated"}
          onChange={event => onInterconnectChange({ ...interconnect, fidelity_scenario: event.target.value as "demonstrated" | "target_2027" })}>
          <option value="demonstrated">99.3% · r1 peak extrapolation</option><option value="target_2027">99.9% · 2027 target</option>
        </select></label>
        <label className="min-w-0 text-[10px]">Assumed ns / round<input aria-label="Transfer duration assumption in ns" type="number" min="0.001" max="1000000" step="any" className={control}
          value={interconnect.transfer_duration_ns ?? 100} onChange={event => onInterconnectChange({ ...interconnect, transfer_duration_ns: Number(event.target.value) })} /></label>
      </div>
      <p className="mt-1.5 text-[9px] leading-4 text-slate-600 dark:text-slate-400">Auto uses no links at ≤520 active qubits. Cross-module traffic assumes mixed gate pairs, out-and-back transfers and ten parallel channels. Fidelity is extrapolated from four r1 links (99.0% mean); duration is an architectural assumption.</p>
    </fieldset>}
  </div>;
}

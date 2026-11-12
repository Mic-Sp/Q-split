"use client";

import { useEffect, useRef, useState } from "react";
import { BUILTIN_HARDWARE_PROFILE_IDS, type BuiltinHardwareProfile, type CustomQPUProfileSpec, type InterconnectConfig } from "@/types/telemetry";
import { HARDWARE_PROFILES } from "@/lib/hardware-profiles";
import { cloneBuiltinProfile, customProfileFromDraft, CUSTOM_PRESET_STORAGE_KEY, encodeCustomPresets, readCustomPresets, saveCustomPreset,
  type CustomNumberField, type CustomPreset, type CustomProfileDraft } from "@/lib/custom-profile";

const control = "mt-1 min-h-9 w-full min-w-0 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1.5 text-xs text-slate-800 dark:text-slate-200 disabled:opacity-50";
const button = "min-h-9 rounded-md border border-cyan-700/30 dark:border-cyan-400/30 px-3 py-1 text-xs text-cyan-800 dark:text-cyan-300 disabled:opacity-40";
const group = "min-w-0 rounded-lg border border-slate-200 dark:border-slate-700 p-3";

export function CustomHardwarePanel({ draft, onChange, onApply, onUseCapacity, interconnect, onInterconnectChange }: {
  draft: CustomProfileDraft;
  onChange: (draft: CustomProfileDraft) => void;
  onApply: (spec: CustomQPUProfileSpec) => void;
  onUseCapacity: (capacity: number) => void;
  interconnect: InterconnectConfig;
  onInterconnectChange: (value: InterconnectConfig) => void;
}) {
  const [baseline, setBaseline] = useState<BuiltinHardwareProfile>("ibm_heron_nisq");
  const [presets, setPresets] = useState<CustomPreset[]>([]);
  const [selectedPreset, setSelectedPreset] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const lifetimes = useRef({ t1_us: "200", t2_us: "150" });
  useEffect(() => {
    try { setPresets(readCustomPresets(localStorage.getItem(CUSTOM_PRESET_STORAGE_KEY))); }
    catch { setNotice("Saved presets could not be loaded. You can still edit and run a profile."); }
  }, []);
  let profile: CustomQPUProfileSpec | null = null, error: string | null = null;
  try { profile = customProfileFromDraft(draft); } catch (reason) { error = reason instanceof Error ? reason.message : "Check custom parameters."; }
  const logical = draft.t1_us === "" && draft.t2_us === "";
  const update = (field: keyof CustomProfileDraft, value: string) => onChange({ ...draft, [field]: value });
  const numberField = (field: CustomNumberField, label: string, optional = false, disabled = false) => <label key={field} className="min-w-0 text-[11px] text-slate-700 dark:text-slate-300">
    {label}{optional && <span className="ml-1 text-[9px] text-slate-500">(blank = none)</span>}
    <input aria-label={label} name={`custom-${field}`} type="text" inputMode="decimal" value={draft[field]} disabled={disabled}
      onChange={event => update(field, event.target.value)} className={control} spellCheck={false} />
  </label>;
  const store = (next: CustomPreset[], message: string) => {
    try { localStorage.setItem(CUSTOM_PRESET_STORAGE_KEY, encodeCustomPresets(next)); setPresets(next); setNotice(message); }
    catch { setNotice("Browser storage is unavailable or full. This configuration can still be simulated and saved in run history."); }
  };
  return <details open className="mt-3 min-w-0 rounded-lg border border-cyan-700/25 dark:border-cyan-400/25 bg-slate-50 dark:bg-slate-900/60">
    <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-cyan-900 dark:text-cyan-200">Custom Hardware Configuration Panel</summary>
    <div className="space-y-3 border-t border-cyan-700/20 dark:border-cyan-400/20 p-3">
      <p className="text-[11px] text-slate-600 dark:text-slate-400">User-defined research assumptions use the same gate, idle-decay and link model as built-in profiles. Profile capacity is the reference; Available QPU Qubits below controls execution capacity. Changes apply when you run.</p>
      <div className="grid gap-3 lg:grid-cols-2">
        <div className="flex min-w-0 flex-wrap items-end gap-2">
          <label className="min-w-0 flex-1 text-[11px]">Clone Baseline From…<select aria-label="Clone baseline from" value={baseline} onChange={event => setBaseline(event.target.value as BuiltinHardwareProfile)} className={control}>
            {BUILTIN_HARDWARE_PROFILE_IDS.map(id => <option key={id} value={id}>{HARDWARE_PROFILES[id].label}</option>)}
          </select></label>
          <button type="button" className={button} onClick={() => { onApply(cloneBuiltinProfile(baseline)); setNotice("Baseline copied. Adjust parameters before running."); }}>Clone baseline</button>
        </div>
        <div className="flex min-w-0 flex-wrap items-end gap-2">
          <label className="min-w-0 flex-1 text-[11px]">Named local presets<select aria-label="Named custom presets" value={selectedPreset} onChange={event => setSelectedPreset(event.target.value)} className={control}>
            <option value="">Choose a saved preset…</option>{presets.map(preset => <option key={preset.name} value={preset.name}>{preset.name}</option>)}
          </select></label>
          <button type="button" className={button} disabled={!selectedPreset} onClick={() => { const preset = presets.find(item => item.name === selectedPreset); if (preset) { onApply(preset.spec); setNotice("Preset loaded."); } }}>Load preset</button>
          <button type="button" className={button} disabled={!profile} onClick={() => { if (profile) { store(saveCustomPreset(presets, profile), "Preset saved in this browser under the custom profile name."); setSelectedPreset(profile.name); } }}>Save preset</button>
          <button type="button" className={button} disabled={!selectedPreset} onClick={() => { store(presets.filter(item => item.name !== selectedPreset), "Local preset deleted."); setSelectedPreset(""); }}>Delete preset</button>
        </div>
      </div>
      {notice && <p role="status" className="text-[11px] text-cyan-800 dark:text-cyan-300">{notice}</p>}
      <div className="grid min-w-0 gap-3 xl:grid-cols-2">
        <fieldset className={group}><legend className="px-1 text-xs font-semibold">Identity &amp; Capacity</legend>
          <div className="grid min-w-0 gap-3 sm:grid-cols-2">
            <label className="min-w-0 text-[11px]">Custom profile name<input aria-label="Custom profile name" maxLength={120} value={draft.name} onChange={event => update("name", event.target.value)} className={control} /></label>
            {numberField("n_qubits_max", "Custom programmable capacity", true)}
            {numberField("n_physical_qubits", "Total physical qubits", true)}
            {numberField("max_operations", "Advisory operation target", true)}
            {numberField("topology_factor", "Routing topology factor")}
            {numberField("native_2q_per_cx", "Native 2Q gates per CX")}
            {numberField("qubits_per_module", "Programmable qubits per module", true)}
            <label className="text-[11px]">Module count<select aria-label="Custom module count" className={control} value={draft.module_count} onChange={event => {
              const dual = event.target.value === "2";
              onChange({ ...draft, module_count: event.target.value,
                qubits_per_module: draft.qubits_per_module || (dual ? String(Math.max(1, Math.ceil(Number(draft.n_qubits_max || 1040) / 2))) : ""),
                l_couplers_active: dual ? draft.l_couplers_active === "0" ? "10" : draft.l_couplers_active : "0",
                l_couplers_installed: dual && Number(draft.l_couplers_installed) < 10 ? "10" : draft.l_couplers_installed,
                state_transfer_fidelity: draft.state_transfer_fidelity || (dual ? "0.993" : ""), transfer_duration_ns: draft.transfer_duration_ns || (dual ? "100" : "") });
            }}><option value="1">1 · single module</option><option value="2">2 · linked modules</option></select></label>
          </div>
          <p className="mt-2 text-[10px] text-slate-500">Cloned baseline: {draft.base_profile_id || "independent research profile"}. Physical qubits and operation targets are metadata.</p>
          <button type="button" className={`${button} mt-2`} disabled={!profile || profile.n_qubits_max === null} onClick={() => { if (profile?.n_qubits_max != null) onUseCapacity(profile.n_qubits_max); }}>Use profile capacity</button>
        </fieldset>
        <fieldset className={group}><legend className="px-1 text-xs font-semibold">Coherence &amp; Timing</legend>
          <label className="mb-3 flex items-start gap-2 text-[11px]"><input aria-label="Logical FTQC mode" type="checkbox" checked={logical} onChange={event => {
            if (event.target.checked) { lifetimes.current = { t1_us: draft.t1_us || "200", t2_us: draft.t2_us || "150" }; onChange({ ...draft, t1_us: "", t2_us: "" }); }
            else onChange({ ...draft, ...lifetimes.current });
          }} /><span>Logical FTQC Mode · disables separate T1/T2 idle decay. Include logical memory errors in gate/error rates by assumption.</span></label>
          <div className="grid min-w-0 gap-3 sm:grid-cols-2">
            {numberField("t1_us", "T1 lifetime · µs", true, logical)}{numberField("t2_us", "T2 lifetime · µs", true, logical)}
            {numberField("t_1q_ns", "1Q gate duration · ns")}{numberField("t_2q_ns", "2Q gate duration · ns")}
            {numberField("t_meas_ns", "Measurement duration · ns")}{numberField("t_reset_ns", "Reset duration · ns")}
            {numberField("repetition_rate_hz", "Repetition rate · Hz", true)}
          </div>
        </fieldset>
        <fieldset className={group}><legend className="px-1 text-xs font-semibold">Gate &amp; Readout Error Rates</legend>
          <p className="mb-2 text-[10px] text-slate-500">Probabilities from 0 to 1. Scientific notation such as 1e-4 is supported.</p>
          <div className="grid min-w-0 gap-3 sm:grid-cols-3">{numberField("err_1q", "1Q error probability")}{numberField("err_2q", "2Q error probability")}{numberField("err_meas", "Readout error probability")}</div>
        </fieldset>
        {draft.module_count === "2" && <fieldset className={group}><legend className="px-1 text-xs font-semibold">Multi-Chip Interconnect</legend>
          <div className="grid min-w-0 gap-3 sm:grid-cols-2">
            {numberField("l_couplers_installed", "Installed l-coupler channels")}{numberField("l_couplers_active", "Active l-coupler channels")}
            {numberField("state_transfer_fidelity", "State-transfer fidelity")}{numberField("state_transfer_target_fidelity", "Alternative target transfer fidelity", true)}
            {numberField("transfer_duration_ns", "Custom transfer duration · ns per round")}
            <label className="text-[11px]">Placement<select aria-label="Custom module placement" className={control} value={interconnect.placement ?? "auto"} onChange={event => onInterconnectChange({ ...interconnect, placement: event.target.value as "auto" | "dual" })}><option value="auto">Auto · fill one module first</option><option value="dual">Explicit · span both modules</option></select></label>
            <label className="text-[11px]">Fidelity scenario<select aria-label="Custom fidelity scenario" className={control} value={interconnect.fidelity_scenario ?? "demonstrated"} onChange={event => onInterconnectChange({ ...interconnect, fidelity_scenario: event.target.value as "demonstrated" | "target_2027" })}><option value="demonstrated">Use defined transfer fidelity</option><option value="target_2027" disabled={!draft.state_transfer_target_fidelity}>Use defined target fidelity</option></select></label>
          </div>
          {interconnect.transfer_duration_ns != null && <p className="mt-2 text-[10px] text-amber-800 dark:text-amber-300">Saved per-run transfer override: {interconnect.transfer_duration_ns} ns. Editing the profile duration clears this override.</p>}
          <p className="mt-2 text-[10px] text-slate-500">Two transfers per estimated remote CX; rounds = ceil(transfers / active channels). Assumes ideal channel utilization and uniformly mixed gate operands. Transfer stalls count toward coherent idle exposure.</p>
        </fieldset>}
      </div>
      {error && <p role="alert" className="text-xs text-rose-700 dark:text-rose-300">{error}</p>}
    </div>
  </details>;
}

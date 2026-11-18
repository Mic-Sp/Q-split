"use client";

import { GQE_FIELDS, GQE_MODE_LABELS, changeGqePreset, editGqeDraft, gqeDraft, gqeMultiplicities, parametersFromGqeDraft, type GQEDraft } from "@/lib/gqe";
import type { GQEParameters } from "@/types/telemetry";

export function GqeControls({ draft, qubits, onChange }: { draft: GQEDraft; qubits: number; onChange: (draft: GQEDraft) => void }) {
  let counts: ReturnType<typeof gqeMultiplicities> | null = null;
  try { counts = gqeMultiplicities(parametersFromGqeDraft(qubits, draft)); } catch { /* Incomplete drafts have inline feedback. */ }
  return <fieldset aria-label="GQE hybrid parameters" className="mt-3 min-w-0 rounded-lg border border-emerald-600/25 bg-emerald-600/5 p-3">
    <legend className="px-1 text-xs font-semibold text-emerald-900 dark:text-emerald-200">Generative eigensolver · hybrid loop parameters</legend>
    <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
      <label className="min-w-0 text-[11px] font-medium text-slate-800 dark:text-slate-200">Training mode
        <select aria-label="GQE training mode" value={draft.training_mode} onChange={event => onChange(changeGqePreset(draft, qubits, event.target.value as GQEParameters["training_mode"]))}
          className="mt-1 block min-h-9 max-w-full rounded-md border border-slate-300 bg-white px-2 text-xs dark:border-slate-700 dark:bg-slate-950">
          {Object.entries(GQE_MODE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
      <button type="button" onClick={() => onChange(changeGqePreset(gqeDraft(qubits), qubits, draft.training_mode))} className="min-h-8 rounded-md border border-emerald-600/30 px-2 text-[11px] text-emerald-800 dark:text-emerald-200">Use preset defaults</button>
    </div>
    <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-5">
      {GQE_FIELDS.map(field => {
        const value = /^\d+$/.test(draft.values[field.key]) ? Number(draft.values[field.key]) : NaN;
        const valid = Number.isSafeInteger(value) && value >= field.min && value <= field.max;
        return <div key={field.key} className="min-w-0">
          <label htmlFor={`gqe-${field.key}`} className="block text-[11px] font-medium text-slate-800 dark:text-slate-200">{field.label}{draft.overridden.includes(field.key) && <span className="ml-1 text-[9px] font-normal text-emerald-700 dark:text-emerald-300">edited</span>}</label>
          <input id={`gqe-${field.key}`} aria-label={field.label} type="number" min={field.min} max={field.max} step={1} value={draft.values[field.key]}
            onChange={event => onChange(editGqeDraft(draft, field.key, event.target.value))} aria-invalid={!valid} aria-describedby={`gqe-${field.key}-help`}
            className="mt-1 min-h-9 w-full rounded-md border border-slate-300 bg-white px-2 font-mono text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100" />
          <p id={`gqe-${field.key}-help`} className={`mt-1 text-[10px] ${valid ? "text-slate-500 dark:text-slate-400" : "text-rose-700 dark:text-rose-300"}`}>{valid ? "Range" : "Enter a whole number"} {field.min.toLocaleString()}–{field.max.toLocaleString()}</p>
        </div>;
      })}
    </div>
    <p className="mt-3 text-[11px] leading-5 text-slate-600 dark:text-slate-400">{counts ? `${counts.total_generated_circuits.toLocaleString()} generated circuits · ${counts.total_circuit_evaluations.toLocaleString()} basis evaluations · ${counts.total_shots.toLocaleString()} total shots.` : "Complete the bounded fields to configure this run."} Untouched fields follow molecule/mode presets; edited fields stay fixed. Changes apply on Run simulation.</p>
    {draft.training_mode === "pretrained_finetune" && <p className="mt-1 text-[10px] text-emerald-800 dark:text-emerald-200">Checkpoint loading is included. Historical offline pretraining is a separate reference cost.</p>}
  </fieldset>;
}

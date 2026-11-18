"use client";

import { SKQD_FIELDS, parametersFromSkqdDraft, effectiveSkqdSubspace, type SKQDDraft } from "@/lib/skqd";

export function SkqdControls({ draft, onChange, qubits }: { draft: SKQDDraft; onChange: (value: SKQDDraft) => void; qubits: number }) {
  let retained: number | null = null;
  try { retained = effectiveSkqdSubspace(qubits, parametersFromSkqdDraft(draft)); } catch { /* Field feedback below describes incomplete drafts. */ }
  return <fieldset aria-label="SKQD family parameters" className="mt-3 min-w-0 rounded-lg border border-violet-600/25 bg-violet-600/5 p-3">
    <legend className="px-1 text-xs font-semibold text-violet-800 dark:text-violet-200">Krylov family parameters</legend>
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {SKQD_FIELDS.map(field => {
        const number = /^\d+$/.test(draft[field.key]) ? Number(draft[field.key]) : NaN;
        const valid = Number.isSafeInteger(number) && number >= field.min && number <= field.max;
        return <div key={field.key} className="min-w-0">
          <label htmlFor={`skqd-${field.key}`} className="block text-[11px] font-medium text-slate-800 dark:text-slate-200">{field.label}</label>
          <input id={`skqd-${field.key}`} aria-label={field.label} type="number" min={field.min} max={field.max} step={1}
            value={draft[field.key]} onChange={event => onChange({ ...draft, [field.key]: event.target.value })} aria-invalid={!valid}
            aria-describedby={`skqd-${field.key}-help`} className="mt-1 min-h-9 w-full rounded-md border border-slate-300 bg-white px-2 font-mono text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100" />
          {(field.key === "krylov_dimension" || field.key === "trotter_steps") && <input type="range" aria-label={`${field.label} slider`} min={field.min} max={field.max} step={1}
            value={valid ? number : field.min} onChange={event => onChange({ ...draft, [field.key]: event.target.value })} className="mt-2 w-full accent-violet-600" />}
          <p id={`skqd-${field.key}-help`} className={`mt-1 text-[10px] ${valid ? "text-slate-500 dark:text-slate-400" : "text-rose-700 dark:text-rose-300"}`}>{valid ? "Range" : "Enter a whole number"} {field.min.toLocaleString()}–{field.max.toLocaleString()}</p>
        </div>;
      })}
    </div>
    <p className="mt-2 text-[11px] leading-5 text-slate-600 dark:text-slate-400">Effective retained basis: <strong className="font-mono text-violet-800 dark:text-violet-200">{retained === null ? "—" : retained.toLocaleString()} states</strong> · capped by requested R, 2<sup>{qubits}</sup>, and total samples. Changes apply on Run simulation.</p>
  </fieldset>;
}

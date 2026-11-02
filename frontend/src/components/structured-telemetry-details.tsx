import type { StageMetrics } from "@/types/telemetry";

const SECTIONS = [
  { key: "circuit_spec", label: "Circuit resources" },
  { key: "qpu_profile", label: "QPU profile" },
  { key: "log_survival_terms", label: "Survival diagnostics" },
  { key: "classical_baselines", label: "Classical baselines" },
] as const;

/** Keep units visible while turning backend field names into readable labels. */
function fieldLabel(key: string): string {
  const label = key.replace(/_(ms|us|ns)$/, (_, unit: string) => ` (${unit === "us" ? "µs" : unit})`).replaceAll("_", " ");
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** Render every level of structured telemetry without rounding reported numeric values. */
function TelemetryValue({ value }: { value: unknown }) {
  if (Array.isArray(value)) {
    if (!value.length) return <span className="text-slate-600 dark:text-slate-400">No items reported</span>;
    return <ul className="min-w-0 space-y-2 border-l border-slate-200 dark:border-slate-800 pl-3">
      {value.map((item, index) => <li key={index} className="min-w-0"><TelemetryValue value={item} /></li>)}
    </ul>;
  }
  if (value !== null && typeof value === "object") {
    return <TelemetryGrid values={value as Record<string, unknown>} />;
  }
  const text = typeof value === "boolean" ? value ? "Yes" : "No"
    : typeof value === "string" ? value || "—"
    : typeof value === "number" && Number.isFinite(value) ? String(value) : "—";
  return <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">{text}</span>;
}

function TelemetryGrid({ values }: { values: Record<string, unknown> }) {
  const entries = Object.entries(values);
  if (!entries.length) return <p className="text-slate-600 dark:text-slate-400">No fields reported</p>;

  return <dl className="grid min-w-0 grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2">
    {entries.map(([key, value]) => {
      const nested = value !== null && typeof value === "object";
      return <div key={key} className={nested ? "col-span-full min-w-0" : "min-w-0"}>
        <dt className={`text-[10px] leading-4 [overflow-wrap:anywhere] ${nested ? "font-semibold text-slate-700 dark:text-slate-300" : "text-slate-600 dark:text-slate-400"}`}>{fieldLabel(key)}</dt>
        <dd className={nested
          ? "mt-1 min-w-0 border-l border-slate-200 dark:border-slate-800 pl-3 text-[11px] leading-4 text-slate-900 dark:text-slate-100"
          : "mt-0.5 min-w-0 font-mono text-[11px] leading-4 text-slate-900 dark:text-slate-100"}>
          <TelemetryValue value={value} />
        </dd>
      </div>;
    })}
  </dl>;
}

/** Present reported fields in nested grids while accepting historical object shapes. */
export function StructuredTelemetryDetails({ metrics }: { metrics: StageMetrics }) {
  const sections = SECTIONS.flatMap(section => {
    const value: unknown = metrics[section.key];
    // Guard wire data at runtime; TypeScript interfaces do not validate incoming JSON.
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? [{ ...section, value }]
      : [];
  });
  if (!sections.length) return null;

  return <div className="mb-2 min-w-0 space-y-1.5">
    {sections.map(({ key, label, value }) => <details key={key} className="min-w-0 rounded-md border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/60">
      <summary className="cursor-pointer rounded-md px-2 py-1.5 text-[10px] font-medium text-slate-600 dark:text-slate-400 focus-visible:outline-2 focus-visible:outline-cyan-600">{label}</summary>
      <div role="region" tabIndex={0} aria-label={`${label} details`} className="mx-2 mb-2 max-h-80 min-w-0 overflow-auto rounded border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 p-3 focus-visible:outline-2 focus-visible:outline-cyan-600">
        <TelemetryGrid values={value as Record<string, unknown>} />
      </div>
    </details>)}
  </div>;
}

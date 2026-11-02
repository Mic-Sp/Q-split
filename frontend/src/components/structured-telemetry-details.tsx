import type { StageMetrics } from "@/types/telemetry";

const SECTIONS = [
  { key: "circuit_spec", label: "Circuit resources" },
  { key: "qpu_profile", label: "QPU profile" },
  { key: "log_survival_terms", label: "Survival diagnostics" },
  { key: "classical_baselines", label: "Classical baselines" },
] as const;

/** Display reported objects verbatim, without requiring historical payloads to match today's schema. */
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
      <pre tabIndex={0} aria-label={`${label} JSON`} className="mx-2 mb-2 max-h-64 min-w-0 overflow-auto rounded border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 p-2 font-mono text-[10px] leading-4 text-slate-600 dark:text-slate-400">{JSON.stringify(value, null, 2)}</pre>
    </details>)}
  </div>;
}

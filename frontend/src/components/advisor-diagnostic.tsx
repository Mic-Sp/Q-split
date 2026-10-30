import { ADVISOR_HEADINGS, type AdvisorInsight, type AdvisorSections } from "@/types/advisor";

/**
 * Render validated diagnostic fields as plain text under stable headings, without interpreting provider markup.
 */
export function AdvisorDiagnostic({ insight }: { insight: AdvisorInsight }) {
  return <div className="@container"><div className="grid gap-2 @3xl:grid-cols-3">
    {(Object.entries(ADVISOR_HEADINGS) as [keyof AdvisorSections, string][]).map(([key, heading]) => (
      <div key={key} className="min-w-0 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/60 p-3">
        <h3 className="text-xs font-semibold leading-5 text-cyan-800 dark:text-cyan-200">{heading}</h3>
        <p className="mt-2 whitespace-pre-line text-xs leading-5 text-slate-700 dark:text-slate-300 [overflow-wrap:anywhere]">{insight.sections[key]}</p>
      </div>
    ))}
  </div></div>;
}

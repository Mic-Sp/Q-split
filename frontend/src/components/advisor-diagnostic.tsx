import { ADVISOR_HEADINGS, type AdvisorInsight, type AdvisorSections } from "@/types/advisor";

export function AdvisorDiagnostic({ insight }: { insight: AdvisorInsight }) {
  return <div className="grid gap-3 lg:grid-cols-3">
    {(Object.entries(ADVISOR_HEADINGS) as [keyof AdvisorSections, string][]).map(([key, heading]) => (
      <div key={key} className="min-w-0 rounded-xl border border-slate-800 bg-slate-950/60 p-4">
        <h3 className="text-xs font-semibold leading-5 text-cyan-200">{heading}</h3>
        <p className="mt-3 whitespace-pre-line text-xs leading-6 text-slate-300 [overflow-wrap:anywhere]">{insight.sections[key]}</p>
      </div>
    ))}
  </div>;
}

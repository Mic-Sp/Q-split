import type { AdvisorInsight } from "@/types/advisor";

/**
 * Map canonical insight provenance to consistent source styling and an explanatory accessible label.
 */
export function AdvisorSourceBadge({ source }: { source: AdvisorInsight["source"] }) {
  const label = source === "gemini" ? "Live AI" : source === "cached" ? "Cached DB Hit" : "Deterministic Fallback";
  const title = source === "gemini" ? "Live Gemini AI" : source === "cached" ? "Neon PostgreSQL Read-Through Cache" : "Deterministic Local Fallback";
  return <span title={title} aria-label={`Diagnostic source: ${label}`} className={[
    "inline-flex shrink-0 rounded-full border px-2 py-1 text-[10px] font-medium",
    source === "fallback" ? "border-amber-400/25 bg-amber-400/5 text-amber-200" :
      source === "cached" ? "border-slate-700 bg-slate-800/60 text-slate-300" : "border-cyan-400/25 bg-cyan-400/5 text-cyan-200",
  ].join(" ")}>{label}</span>;
}

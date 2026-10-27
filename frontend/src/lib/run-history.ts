import type { SavedSimulationRun } from "@/types/run-history";

export function mergeRuns(current: SavedSimulationRun[], incoming: SavedSimulationRun[]) {
  const unique = new Map(current.map((run) => [run.id, run]));
  for (const run of incoming) {
    const existing = unique.get(run.id)?.advisorInsight;
    const preserve = existing && (!run.advisorInsight || Date.parse(existing.generatedAt) > Date.parse(run.advisorInsight.generatedAt));
    // A delayed initial save must not erase an insight just persisted by the
    // advisor endpoint or a more recent history refresh.
    unique.set(run.id, preserve ? { ...run, advisorInsight: existing } : run);
  }
  return [...unique.values()].sort((a, b) => b.completedAt.localeCompare(a.completedAt) || b.id.localeCompare(a.id)).slice(0, 20);
}

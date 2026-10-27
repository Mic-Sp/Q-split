import type { SavedSimulationRun } from "@/types/run-history";

export function mergeRuns(current: SavedSimulationRun[], incoming: SavedSimulationRun[]) {
  const unique = new Map(current.map((run) => [run.id, run]));
  for (const run of incoming) {
    const previous = unique.get(run.id);
    const existing = previous?.advisorInsight;
    const preserve = existing && (!run.advisorInsight || Date.parse(existing.generatedAt) > Date.parse(run.advisorInsight.generatedAt));
    // A delayed initial save must not erase an insight just persisted by the
    // advisor endpoint or a more recent history refresh.
    const preserveName = previous?.snapshotUpdatedAt && (!run.snapshotUpdatedAt || Date.parse(previous.snapshotUpdatedAt) > Date.parse(run.snapshotUpdatedAt));
    unique.set(run.id, { ...run, ...(preserve ? { advisorInsight: existing } : {}),
      ...(preserveName ? { snapshotName: previous.snapshotName, isSnapshot: previous.isSnapshot, snapshotUpdatedAt: previous.snapshotUpdatedAt } : {}) });
  }
  return [...unique.values()].sort((a, b) => b.completedAt.localeCompare(a.completedAt) || b.id.localeCompare(a.id)).filter((run, index) => index < 20 || run.isSnapshot);
}

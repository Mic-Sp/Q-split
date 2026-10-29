import type { SavedSimulationRun } from "@/types/run-history";
import type { WorkloadId } from "@/types/telemetry";

/**
 * Require stored metadata and captured request to agree with the selected workload before display/export.
 */
export function runsForWorkload(runs: SavedSimulationRun[], workload: WorkloadId) {
  return runs.filter(run => run.workloadId === workload && run.request.workload_id === workload);
}

/**
 * Build the workload-scoped table window before applying display limits.
 * Recent mode shows at most twenty cached runs, collapsed to five; named mode
 * also admits older pinned snapshots. Selection/export callers use the returned
 * scoped run pool so hidden foreign-workload IDs never enter a comparison.
 */
export function benchmarkHistory(runs: SavedSimulationRun[], workload: WorkloadId, namedOnly: boolean, showAll: boolean) {
  const scoped = runsForWorkload(runs, workload);
  const candidates = namedOnly ? scoped.filter(run => run.isSnapshot && run.snapshotName) : scoped.slice(0, 20);
  return { runs: scoped, candidates, visibleRuns: candidates.slice(0, showAll ? candidates.length : 5) };
}

/**
 * Merge asynchronous history/save results by immutable run UUID.
 * Preserve newer advisor output and snapshot metadata when stale responses arrive.
 * Sort deterministically by completion/ID, retaining twenty recent runs per workload
 * plus all older pins; one family's traffic cannot evict another family's window.
 */
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
  // Count within each workload after global ordering; older pins survive beyond their recent window.
  const counts = new Map<string, number>();
  return [...unique.values()].sort((a, b) => b.completedAt.localeCompare(a.completedAt) || b.id.localeCompare(a.id)).filter(run => {
    const count = (counts.get(run.workloadId) ?? 0) + 1;
    counts.set(run.workloadId, count);
    return count <= 20 || run.isSnapshot;
  });
}

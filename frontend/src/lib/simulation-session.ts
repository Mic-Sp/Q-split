import { describeChanges, type Snapshot, type Transition } from "@/lib/telemetry";
import type { WorkloadId } from "@/types/telemetry";

/** Tab-local latest snapshots and bounded same-workload transitions, separate from persistent database history. */
export interface SimulationSession {
  snapshots: Partial<Record<WorkloadId, Snapshot>>;
  history: Transition[];
  completed: number;
}

/**
 * Record a successful result against the last completed run in its own workload.
 * The first run establishes a baseline. Immutable snapshots prevent later control
 * edits from rewriting deltas; the global completion sequence identifies transitions,
 * while retention is independently capped at six transitions per workload.
 */
export function recordCompletedRun(session: SimulationSession, snapshot: Snapshot): SimulationSession {
  const workload = snapshot.request.workload_id;
  // Interleaved N and M runs have independent baselines, even though transition IDs share one sequence.
  const previous = session.snapshots[workload];
  const completed = session.completed + 1;
  const transition = previous ? { id: completed, before: previous, after: snapshot, changes: describeChanges(previous, snapshot) } : null;
  const counts = new Map<WorkloadId, number>();
  const history = (transition ? [transition, ...session.history] : session.history).filter(item => {
    const family = item.after.request.workload_id;
    const count = (counts.get(family) ?? 0) + 1;
    counts.set(family, count);
    return count <= 6;
  });
  return { snapshots: { ...session.snapshots, [workload]: snapshot }, history, completed };
}

/**
 * Select the active family's last snapshot and transitions without creating cross-workload deltas.
 */
export function sessionForWorkload(session: SimulationSession, workload: WorkloadId) {
  return { snapshot: session.snapshots[workload] ?? null,
    history: session.history.filter(item => item.before.request.workload_id === workload && item.after.request.workload_id === workload) };
}

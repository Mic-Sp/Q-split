import assert from "node:assert/strict";
import { test } from "node:test";
import { benchmarkHistory, mergeRuns, runsForWorkload } from "./run-history";
import { benchmarkExportRuns, selectedBenchmarkRuns, toggleBenchmarkSelection } from "./benchmark-comparison";
import { benchmarkCsv, benchmarkJson } from "./benchmark-export";
import { recordCompletedRun, sessionForWorkload, type SimulationSession } from "./simulation-session";
import { validateAdvisorRequest } from "./advisor-input";
import { deterministicInsight } from "./advisor";
import type { SavedSimulationRun } from "@/types/run-history";
import type { Snapshot } from "./telemetry";
import type { WorkloadId } from "@/types/telemetry";

function saved(workload: WorkloadId, index: number, pinned = false): SavedSimulationRun {
  const mips = workload === "quantum_mips";
  return { id: `c367fe2e-f083-4996-8cbd-${mips ? "1" : "2"}${String(index).padStart(11, "0")}`,
    completedAt: new Date(Date.UTC(2026, 9, mips ? 29 : 28, 12, index)).toISOString(), createdAt: "2026-10-28T12:00:00.000Z",
    workloadId: workload, workloadName: mips ? "Quantum-MIPS" : "Shor", scaleParam: mips ? 64 : 15, scaleLabel: mips ? "M = 64" : "N = 15",
    hardwareProfile: "ideal_sim", stage1Node: "CPU", stage2Node: "QPU", stage3Node: "CPU", executionMode: "NISQ_ANALYTICAL_PROFILER",
    totalLatencyMs: 0.5, bottleneckStatus: "OPTIMAL", primaryBottleneck: "NONE", qubitsRequired: mips ? 10 : 8,
    circuitDepth: "100", coherenceSurvivalPct: 100, snapshotName: pinned ? `${workload} pin ${index}` : null, isSnapshot: pinned,
    snapshotUpdatedAt: null, advisorInsight: null,
    request: { workload_id: workload, scale_param: mips ? 64 : 15, hardware_profile: "ideal_sim", available_qubits: 133 },
    telemetry: { workload_id: workload, workload_name: mips ? "Quantum-MIPS" : "Shor", scale_label: mips ? "M = 64" : "N = 15",
      execution_mode: "NISQ_ANALYTICAL_PROFILER", primary_bottleneck: "NONE", stages: {
        stage_1_classical_pre: { name: "Pre", node: "CPU", latency_ms: 0.2, status: "OPTIMAL", output_summary: "", metrics: {} },
        stage_2_quantum_kernel: { name: "Kernel", node: "QPU", latency_ms: 0.1, status: "OPTIMAL", output_summary: "", metrics: { available_qubits: 133, qubits_required: mips ? 10 : 8, coherence_survival_pct: 100 } },
        stage_3_classical_post: { name: "Post", node: "CPU", latency_ms: 0.2, status: "OPTIMAL", output_summary: "", metrics: {} },
      } },
  };
}
const snapshot = (run: SavedSimulationRun): Snapshot => ({ id: run.id, completedAt: run.completedAt, request: run.request, data: run.telemetry });

test("mixed history retains twenty recent runs per workload and older own pins through late saves and refreshes", () => {
  const all = ["shors_crypto", "quantum_mips"].flatMap(workload => Array.from({ length: 30 }, (_, index) => saved(workload as WorkloadId, index, index === 0)));
  let merged = mergeRuns([], all);
  for (const workload of ["shors_crypto", "quantum_mips"] as const) {
    assert.equal(runsForWorkload(merged, workload).length, 21);
    const latest = benchmarkHistory(merged, workload, false, false);
    assert.equal(latest.candidates.length, 20); assert.equal(latest.visibleRuns.length, 5);
    assert.ok(latest.visibleRuns.every(run => run.workloadId === workload));
    assert.equal(benchmarkHistory(merged, workload, false, true).visibleRuns.length, 20);
    const pins = benchmarkHistory(merged, workload, true, true).visibleRuns;
    assert.equal(pins.length, 1); assert.equal(pins[0].scaleLabel, workload === "quantum_mips" ? "M = 64" : "N = 15");
  }
  const late = saved("shors_crypto", 0);
  merged = mergeRuns(merged, [{ ...late, snapshotName: "Renamed Shor", isSnapshot: true, snapshotUpdatedAt: "2026-10-28T18:00:00.000Z" }]);
  merged = mergeRuns(merged, [late]);
  assert.equal(runsForWorkload(merged, "shors_crypto").find(run => run.id === late.id)?.snapshotName, "Renamed Shor");
  assert.equal(runsForWorkload(merged, "quantum_mips").length, 21);
});

test("switching workload scopes checked rows, comparison matrices and exports even when stale foreign IDs remain", () => {
  const shor = saved("shors_crypto", 1), mips = saved("quantum_mips", 1), pin = saved("quantum_mips", 0, true);
  const mixed = mergeRuns([], [shor, mips, pin]);
  const shorView = benchmarkHistory(mixed, "shors_crypto", false, false);
  const ids = toggleBenchmarkSelection(shorView.runs, [], shor.id);
  assert.deepEqual(selectedBenchmarkRuns(shorView.runs, ids), [shor]);
  const mipsView = benchmarkHistory(mixed, "quantum_mips", false, false);
  assert.deepEqual(selectedBenchmarkRuns(mipsView.runs, ids), []);
  assert.deepEqual(toggleBenchmarkSelection(mipsView.runs, ids, shor.id), []);
  const exportAll = benchmarkExportRuns(mipsView.runs, mipsView.visibleRuns, ids);
  assert.deepEqual(exportAll, mipsView.visibleRuns);
  const selected = toggleBenchmarkSelection(mipsView.runs, ids, pin.id);
  const exportSelected = benchmarkExportRuns(mipsView.runs, [mips], selected);
  assert.deepEqual(exportSelected, [pin]);
  assert.doesNotMatch(benchmarkCsv(exportSelected), /Shor|N = 15/);
  assert.ok(JSON.parse(benchmarkJson(exportSelected)).every((run: SavedSimulationRun) => run.request.workload_id === "quantum_mips"));
  assert.equal(benchmarkHistory(mixed.filter(run => run.id !== mips.id), "quantum_mips", false, true).visibleRuns.length, 1);
  assert.equal(benchmarkHistory(mixed, "shors_crypto", false, true).visibleRuns.length, 1);
});

test("interleaved session runs compare only their own last completed run and keep six transitions per workload", () => {
  let session: SimulationSession = { snapshots: {}, history: [], completed: 0 };
  session = recordCompletedRun(session, snapshot(saved("shors_crypto", 0)));
  assert.equal(sessionForWorkload(session, "quantum_mips").snapshot, null);
  session = recordCompletedRun(session, snapshot(saved("quantum_mips", 0)));
  assert.equal(session.history.length, 0, "The first run in each workload establishes its own baseline");
  for (let index = 1; index <= 8; index++) for (const workload of ["shors_crypto", "quantum_mips"] as const) session = recordCompletedRun(session, snapshot(saved(workload, index)));
  for (const workload of ["shors_crypto", "quantum_mips"] as const) {
    const view = sessionForWorkload(session, workload);
    assert.equal(view.snapshot?.id, saved(workload, 8).id);
    assert.equal(view.history.length, 6);
    assert.equal(view.history[0].before.id, saved(workload, 7).id);
    assert.ok(view.history.every(item => item.before.request.workload_id === workload && item.after.request.workload_id === workload));
  }
  assert.equal(session.completed, 18);
});

test("advisor validation rejects cross-workload comparisons and offline diagnostics discard foreign previous runs", () => {
  const completed = (run: SavedSimulationRun) => ({ id: run.id, completedAt: run.completedAt, request: run.request, telemetry: run.telemetry });
  const current = completed(saved("quantum_mips", 2)), previous = completed(saved("shors_crypto", 1));
  assert.throws(() => validateAdvisorRequest({ current, previous }));
  assert.equal(deterministicInsight(current, previous, "network_error").previousRunId, null);
  const own = completed(saved("quantum_mips", 1));
  assert.equal(validateAdvisorRequest({ current, previous: own }).previous?.id, own.id);
  assert.equal(deterministicInsight(current, own, "network_error").previousRunId, own.id);
});

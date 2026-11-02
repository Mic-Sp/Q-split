import assert from "node:assert/strict";
import { test } from "node:test";
import { describeChanges, isScalarMetricValue, parseTelemetry, type Snapshot } from "./telemetry";
import { resourceModelVersion } from "./model-version";
import { benchmarkJson } from "./benchmark-export";
import type { StageMetrics, StageTelemetry } from "@/types/telemetry";
import type { SavedSimulationRun } from "@/types/run-history";

// Synthetic values exercise wire shapes and precision, not hardware calibration.
function snapshot(metrics: StageMetrics = {}, version?: 1 | 2): Snapshot {
  const stage = (node: StageTelemetry["node"], metrics: StageMetrics = {}): StageTelemetry => ({
    name: node, node, latency_ms: 1, status: "OPTIMAL", output_summary: "Ready", metrics,
  });
  return {
    id: "baseline", completedAt: "2026-11-02T12:00:00.000Z",
    request: { workload_id: "shors_crypto", scale_param: 21, hardware_profile: "ideal_sim" },
    data: {
      ...(version === undefined ? {} : { resource_model_version: version }),
      workload_id: "shors_crypto", workload_name: "Shor", scale_label: "N = 21",
      execution_mode: "NISQ_ANALYTICAL_PROFILER", primary_bottleneck: "NONE",
      stages: {
        stage_1_classical_pre: stage("CPU"), stage_2_quantum_kernel: stage("QPU", metrics),
        stage_3_classical_post: stage("CPU"),
      },
    },
  };
}

test("flat metrics retain zero, booleans, missing values and decimal-string depths while rejecting complex or invalid values", () => {
  for (const value of [0, 0.000001, false, true, "38654705664", "", null, undefined]) {
    assert.equal(isScalarMetricValue(value), true);
  }
  for (const value of [{}, { nested: { depth: 100 } }, [], [1, 2], NaN, Infinity, -Infinity, () => 0]) {
    assert.equal(isScalarMetricValue(value), false);
  }
});

test("run deltas ignore structured metric changes, key ordering, additions and removals", () => {
  const before = snapshot({
    circuit_spec: { n_qubits: 13, depth: 100, n_1q: 100, n_2q: 100, n_meas: 13, stage1_ms: 1, stage3_ms: 1 },
    log_survival_terms: { one_qubit: 0, two_qubit: -1, measurement: 0, idle_t1: -1, idle_t2: -2 },
    classical_baselines: { circuit_emulation: { kernel_ms: 1 } },
    phases: [0, 0.5], reordered: { first: 1, second: 2 }, removed: { depth: 100 },
  }, 2);
  const after = structuredClone(before);
  const metrics = after.data.stages.stage_2_quantum_kernel.metrics;
  metrics.circuit_spec!.depth = 200;
  metrics.log_survival_terms!.two_qubit = -2;
  metrics.classical_baselines = { circuit_emulation: { kernel_ms: 2 } };
  metrics.phases = [0, 1];
  metrics.reordered = { second: 2, first: 1 };
  delete metrics.removed;
  metrics.added = { depth: 200 };
  // Deliberately incomplete wire profile: diagnostics must not require today's full typed schema.
  Reflect.set(metrics, "qpu_profile", { provenance: { source: "reported" } });
  assert.deepEqual(describeChanges(before, after), []);
});

test("run deltas ignore both directions of object/scalar and null/object transitions", () => {
  const before = snapshot({ becomesScalar: { depth: 100 }, becomesObject: "reported", nullToObject: null, objectToNull: {} }, 2);
  const after = snapshot({ becomesScalar: 100, becomesObject: { depth: 100 }, nullToObject: {}, objectToNull: null }, 2);
  assert.deepEqual(describeChanges(before, after), []);
});

test("run deltas keep scalar additions, removals, booleans, null and fractional latency precision", () => {
  const before = snapshot({ removed: "reported", nullable: null, execution_feasible: true, gate_execution_ms: 0.25 }, 2);
  const after = structuredClone(before);
  const metrics = after.data.stages.stage_2_quantum_kernel.metrics;
  delete metrics.removed;
  metrics.added = 0;
  metrics.nullable = false;
  metrics.execution_feasible = false;
  metrics.gate_execution_ms = 0.250001;
  const changes = describeChanges(before, after);
  const find = (name: string) => changes.find(change => change.label === `Quantum kernel · ${name}`)!;
  assert.equal(find("removed").after, "—");
  assert.equal(find("added").after, "0");
  assert.equal(find("nullable").before, "null");
  assert.equal(find("nullable").after, "false");
  assert.equal(find("execution feasible").after, "false");
  assert.equal(find("gate execution").before, find("gate execution").after);
  assert.notEqual(find("gate execution").beforeRaw, find("gate execution").afterRaw);
});

test("stage latency changes appear once even when metrics echo or independently change latency_ms", () => {
  const before = snapshot({ latency_ms: 1 }, 2);
  const after = structuredClone(before);
  after.data.stages.stage_2_quantum_kernel.latency_ms = 2;
  after.data.stages.stage_2_quantum_kernel.metrics.latency_ms = 2;
  const changes = describeChanges(before, after);
  assert.equal(changes.filter(change => change.label === "Quantum kernel · latency").length, 1);
  assert.equal(new Set(changes.map(change => change.label)).size, changes.length);
  after.data.stages.stage_2_quantum_kernel.latency_ms = 1;
  assert.deepEqual(describeChanges(before, after), []);
});

test("legacy parsing retains optional or historical structured data and version boundaries", () => {
  for (const version of [undefined, 1, 2] as const) {
    const before = snapshot({ gate_execution_ms: 0.25, measurement_reset_ms: 0.5, launch_overhead_ms: 0.25 }, version);
    // Unknown/incomplete historical objects remain readable without stricter parsing requirements.
    Reflect.set(before.data.stages.stage_2_quantum_kernel.metrics, "qpu_profile", { name: "Historical profile" });
    const wire = JSON.parse(JSON.stringify(before.data));
    assert.deepEqual(parseTelemetry(wire), before.data);
    assert.equal(resourceModelVersion(parseTelemetry(wire)), version ?? 1);
    assert.deepEqual(describeChanges(before, structuredClone(before)), []);
    assert.deepEqual(wire.stages.stage_2_quantum_kernel.metrics.qpu_profile, { name: "Historical profile" });
  }
  assert.deepEqual(describeChanges(snapshot(), snapshot({}, 2)), [{
    label: "Model version changed · metric comparison unavailable", before: "ILLUSTRATIVE_V1", after: "CALIBRATED_V2",
  }]);
});

test("filtering deltas preserves complete telemetry for saved payloads and JSON exports", () => {
  const before = snapshot({ classical_baselines: { circuit_emulation: { kernel_ms: 1 } } }, 2);
  const after = structuredClone(before);
  after.data.stages.stage_2_quantum_kernel.metrics.classical_baselines = { circuit_emulation: { kernel_ms: 2 } };
  const raw = JSON.stringify(after);
  assert.deepEqual(describeChanges(before, after), []);
  assert.equal(JSON.stringify(after), raw);
  const run = { telemetry: after.data } as SavedSimulationRun;
  assert.deepEqual(JSON.parse(benchmarkJson([run]))[0].telemetry, after.data);
});

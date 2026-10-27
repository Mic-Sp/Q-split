import assert from "node:assert/strict";
import { test } from "node:test";
import { formatDuration, formatDurationDelta, formatRawMilliseconds } from "./duration";
import { describeChanges, type Snapshot } from "./telemetry";

test("duration units follow exact millisecond, second, minute, hour, and day boundaries", () => {
  const cases: [number, string][] = [
    [0, "0.00 ms"], [0.45, "0.45 ms"], [23.78, "23.78 ms"], [999.99, "999.99 ms"],
    [1_000, "1.00 s"], [2_687.44, "2.69 s"], [59_990, "59.99 s"],
    [60_000, "1m 0s"], [151_000, "2m 31s"], [3_599_999, "59m 59s"],
    [3_600_000, "1h 0m"], [9_663_805.05, "2h 41m"], [86_399_999, "23h 59m"],
    [86_400_000, "24h 0m"], [86_400_001, "1d 0h"], [273_600_000, "3d 4h"],
  ];
  for (const [input, expected] of cases) assert.equal(formatDuration(input), expected, `${input} ms`);
});

test("duration formatting distinguishes zero from missing/invalid values without coercion", () => {
  for (const value of [undefined, null, -1, NaN, Infinity, -Infinity, "1000", true, {}, []]) {
    assert.equal(formatDuration(value), "—");
    assert.equal(formatRawMilliseconds(value), "—");
  }
  assert.equal(formatDuration(-0), "0.00 ms");
  assert.equal(formatDuration(0.000001), "0.00 ms");
});

test("raw hover readouts retain unshortened milliseconds and sub-millisecond precision", () => {
  assert.equal(formatRawMilliseconds(9_663_805.05), "9,663,805.05 ms");
  assert.equal(formatRawMilliseconds(0.000001), "0.000001 ms");
  assert.equal(formatRawMilliseconds(273_600_000), "273,600,000 ms");
});

test("duration deltas handle decreases, zero, tiny differences, and large changes", () => {
  assert.equal(formatDurationDelta(2_687.44), "+2.69 s");
  assert.equal(formatDurationDelta(-9_663_805.05), "−2h 41m");
  assert.equal(formatDurationDelta(0), "0.00 ms");
  assert.equal(formatDurationDelta(-0), "0.00 ms");
  assert.equal(formatDurationDelta(0.000001), "+<0.01 ms");
  assert.equal(formatDurationDelta(-0.000001), "−<0.01 ms");
  assert.equal(formatDurationDelta(Infinity), "—");
});

function snapshot(): Snapshot {
  return { id: "baseline", completedAt: "2026-10-27T12:00:00.000Z", request: { workload_id: "shors_crypto", scale_param: 21, hardware_profile: "ideal_sim" },
    data: { workload_id: "shors_crypto", workload_name: "Shor", scale_label: "N = 21", execution_mode: "NISQ_ANALYTICAL_PROFILER", primary_bottleneck: "NONE", stages: {
      stage_1_classical_pre: { name: "Pre", node: "CPU", latency_ms: 0.45, status: "OPTIMAL", output_summary: "Ready", metrics: {} },
      stage_2_quantum_kernel: { name: "Kernel", node: "QPU", latency_ms: 2_000, status: "OPTIMAL", output_summary: "Ready", metrics: { io_state_prep_ms: 1_000, circuit_depth: 100, execution_feasible: true } },
      stage_3_classical_post: { name: "Post", node: "CPU", latency_ms: 0.55, status: "OPTIMAL", output_summary: "Ready", metrics: {} },
    } } };
}

test("state delta durations use KPI wall-clock timing, format stage/I/O changes, and retain raw hover values", () => {
  const before = snapshot(), after = structuredClone(before);
  after.data.stages.stage_2_quantum_kernel.latency_ms = 9_663_000;
  after.data.stages.stage_2_quantum_kernel.metrics.io_state_prep_ms = 60_000;
  after.data.stages.stage_2_quantum_kernel.metrics.circuit_depth = 200;
  const changes = describeChanges(before, after);
  const total = changes.find(change => change.label === "Total latency")!;
  assert.equal(total.before, "3.00 s");
  assert.equal(total.after, "2h 42m");
  assert.equal(total.beforeRaw, "3,001 ms");
  assert.equal(total.afterRaw, "9,723,001 ms");
  const stage = changes.find(change => change.label === "Quantum kernel · latency")!;
  assert.equal(stage.before, "2.00 s"); assert.equal(stage.after, "2h 41m");
  const prep = changes.find(change => change.label === "Quantum kernel · io state prep")!;
  assert.equal(prep.before, "1.00 s"); assert.equal(prep.after, "1m 0s");
  const depth = changes.find(change => change.label === "Quantum kernel · circuit depth")!;
  assert.equal(depth.before, "100"); assert.equal(depth.after, "200"); assert.equal(depth.beforeRaw, undefined);
  assert.deepEqual(describeChanges(before, before), []);
});

test("state delta retains changes below display precision and notices separately reported QPU I/O", () => {
  const before = snapshot(), after = structuredClone(before);
  after.data.stages.stage_1_classical_pre.latency_ms += 0.000001;
  after.data.stages.stage_2_quantum_kernel.metrics.io_state_prep_ms = 2_000;
  const changes = describeChanges(before, after);
  const stage = changes.find(change => change.label === "Classical preprocessing · latency")!;
  assert.equal(stage.before, stage.after);
  assert.notEqual(stage.beforeRaw, stage.afterRaw);
  assert.equal(changes.find(change => change.label === "Total latency")!.after, "4.00 s");
});

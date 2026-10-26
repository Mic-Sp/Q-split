import assert from "node:assert/strict";
import { test } from "node:test";
import { createRunRecord, serializeRun } from "./run-record";
import { formatValue, qubitThresholds } from "./telemetry";
import type { SimulationRun } from "@/generated/prisma/client";

function completed() {
  return {
    id: "8ec8c412-392b-41d7-b61b-722357c28072", completedAt: "2026-10-26T15:00:00.000Z",
    request: { workload_id: "shors_crypto", scale_param: 2048, hardware_profile: "ibm_heron_nisq", routing: { stage_1_node: "GPU", stage_2_node: "QPU", stage_3_node: "CPU" } },
    telemetry: {
      workload_id: "shors_crypto", workload_name: "Shor's pipeline", scale_label: "RSA-2048",
      execution_mode: "NISQ_ANALYTICAL_PROFILER", primary_bottleneck: "QPU decoherence",
      stages: {
        stage_1_classical_pre: { name: "Preprocess", node: "GPU", latency_ms: 0.63, status: "WARNING", output_summary: "Prepared", metrics: { base_a: 7 } },
        stage_2_quantum_kernel: { name: "Period finding", node: "QPU", latency_ms: 9_663_676.42, status: "CRITICAL_BOTTLENECK", output_summary: "Decohered", metrics: { qubits_required: 4099, circuit_depth: 38_654_705_664, coherence_survival_pct: 0, nested: { values: [1, "phase", null] } } },
        stage_3_classical_post: { name: "Postprocess", node: "CPU", latency_ms: 128, status: "CRITICAL_BOTTLENECK", output_summary: "Starved", metrics: { factors_found: "NONE" } },
      },
    },
  };
}

test("derives summaries from telemetry and preserves full structured JSON", () => {
  const input = completed();
  const record = createRunRecord(input);
  assert.equal(record.totalLatencyMs, 9_663_805.05);
  assert.equal(record.bottleneckStatus, "CRITICAL_BOTTLENECK");
  assert.equal(record.stage1Node, "GPU");
  assert.equal(record.stage2Node, "QPU");
  assert.equal(record.stage3Node, "CPU");
  assert.equal(record.circuitDepth, BigInt(38_654_705_664));
  assert.equal(record.coherenceSurvivalPct, 0);
  assert.deepEqual(record.telemetry, input.telemetry);
  assert.deepEqual(record.requestPayload, input.request);
});

test("serialization retains large integer precision and valid timestamps", () => {
  const record = createRunRecord(completed());
  const saved = serializeRun({ ...record, createdAt: new Date("2026-10-26T15:00:01.000Z") } as SimulationRun);
  assert.equal(saved.circuitDepth, "38654705664");
  assert.equal(saved.completedAt, "2026-10-26T15:00:00.000Z");
  assert.doesNotThrow(() => JSON.stringify(saved));
  assert.equal(formatValue(BigInt(saved.circuitDepth!)), "38,654,705,664");
});

test("omitted routing uses the backend's CPU/QPU/CPU defaults", () => {
  const input = completed();
  Reflect.deleteProperty(input.request, "routing");
  input.telemetry.stages.stage_1_classical_pre.node = "CPU";
  assert.equal(createRunRecord(input).stage1Node, "CPU");
});

test("rejects mismatched request and telemetry and malformed metadata", () => {
  for (const change of [
    (input: ReturnType<typeof completed>) => { input.request.routing.stage_2_node = "GPU"; },
    (input: ReturnType<typeof completed>) => { input.telemetry.workload_id = "quantum_mips"; },
    (input: ReturnType<typeof completed>) => { input.id = "invalid"; },
    (input: ReturnType<typeof completed>) => { input.completedAt = "invalid"; },
    (input: ReturnType<typeof completed>) => { input.request.scale_param = -1; },
    (input: ReturnType<typeof completed>) => { input.request.hardware_profile = "unsupported"; },
  ]) {
    const input = completed(); change(input);
    assert.throws(() => createRunRecord(input));
  }
});

test("rejects invalid summaries before they reach the database", () => {
  for (const [metric, value] of [["qubits_required", -1], ["circuit_depth", Number.MAX_SAFE_INTEGER + 1], ["coherence_survival_pct", 101]] as const) {
    const input = completed();
    input.telemetry.stages.stage_2_quantum_kernel.metrics[metric] = value;
    assert.throws(() => createRunRecord(input));
  }
  const negative = completed(); negative.telemetry.stages.stage_2_quantum_kernel.latency_ms = -1;
  assert.throws(() => createRunRecord(negative));
});

test("missing optional metrics remain null rather than becoming zero", () => {
  const input = completed();
  Reflect.deleteProperty(input.telemetry.stages.stage_2_quantum_kernel.metrics, "qubits_required");
  Reflect.deleteProperty(input.telemetry.stages.stage_2_quantum_kernel.metrics, "circuit_depth");
  Reflect.deleteProperty(input.telemetry.stages.stage_2_quantum_kernel.metrics, "coherence_survival_pct");
  const record = createRunRecord(input);
  assert.equal(record.qubitsRequired, null);
  assert.equal(record.circuitDepth, null);
  assert.equal(record.coherenceSurvivalPct, null);
});

test("preserves QPU capacity and tier in saved JSON without a schema migration", () => {
  const input = completed();
  Object.assign(input.request, { available_qubits: 16384 });
  Object.assign(input.telemetry.stages.stage_2_quantum_kernel.metrics, {
    available_qubits: 16384, qubits_allocated: 11264, idle_qubits: 5120,
    parallelization_tier: "Carry-Lookahead Parallel", depth_complexity: "O(n log^2 n)",
  });
  const record = createRunRecord(input);
  assert.deepEqual(record.requestPayload, input.request);
  const saved = serializeRun({ ...record, createdAt: new Date() } as SimulationRun);
  assert.equal(saved.request.available_qubits, 16384);
  assert.equal(saved.telemetry.stages.stage_2_quantum_kernel.metrics.qubits_allocated, 11264);
});

test("rejects invalid capacity and mismatched QPU telemetry", () => {
  for (const available_qubits of [0, -1, 1.5, true, "133", null, 2147483648]) {
    const input = completed();
    Object.assign(input.request, { available_qubits });
    assert.throws(() => createRunRecord(input), /available qubits/);
  }
  const input = completed();
  Object.assign(input.request, { available_qubits: 133 });
  assert.throws(() => createRunRecord(input), /capacity does not match/);
});

test("UI threshold shortcuts match N15 special case and RSA capacities", () => {
  assert.deepEqual(qubitThresholds(15), { minimum: 8, windowed: 12, ceiling: 22 });
  assert.deepEqual(qubitThresholds(21), { minimum: 13, windowed: 15, ceiling: 28 });
  assert.deepEqual(qubitThresholds(35), { minimum: 15, windowed: 18, ceiling: 33 });
  assert.deepEqual(qubitThresholds(512), { minimum: 1027, windowed: 1536, ceiling: 2816 });
  assert.deepEqual(qubitThresholds(2048), { minimum: 4099, windowed: 6144, ceiling: 11264 });
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { coherenceBudget, pipelineLatencyBuckets, pipelineTiming } from "./kpi-metrics";
import type { HybridTelemetryResponse, StageNode, StageTelemetry } from "@/types/telemetry";

const stage = (node: StageNode, latency_ms: number, metrics: Record<string, unknown> = {}): StageTelemetry => ({
  name: "Stage", node, latency_ms, metrics, status: "OPTIMAL", output_summary: "Completed",
});
const fixture = (): HybridTelemetryResponse => ({
  workload_id: "shors_crypto", workload_name: "Shor", scale_label: "N = 21",
  execution_mode: "NISQ_ANALYTICAL_PROFILER", primary_bottleneck: "NONE",
  stages: {
    stage_1_classical_pre: stage("CPU", 0.28),
    stage_2_quantum_kernel: stage("QPU", 0.03, { coherence_survival_pct: 90.33, io_state_prep_ms: 0.15, execution_feasible: true }),
    stage_3_classical_post: stage("CPU", 0.31),
  },
});
const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} ≠ ${expected}`);

test("coherence budget uses exact survival thresholds independently of general stage severity", () => {
  const data = fixture();
  for (const [survival, status] of [[100, "NOMINAL"], [70, "NOMINAL"], [69.99, "DEGRADED"], [35, "DEGRADED"], [34.99, "EXCEEDED"], [0, "EXCEEDED"]] as const) {
    data.stages.stage_2_quantum_kernel.metrics.coherence_survival_pct = survival;
    data.stages.stage_2_quantum_kernel.status = "CRITICAL_BOTTLENECK";
    assert.deepEqual(coherenceBudget(data), { survival, classical: false, status });
  }
});

test("blocked QPU routes and insufficient capacity override even ideal coherence", () => {
  for (const metrics of [{ execution_feasible: false }, { routing_supported: false }, { qubits_allocated: 0 }, { available_qubits: 12, minimum_qubits_required: 13 }]) {
    const data = fixture();
    Object.assign(data.stages.stage_2_quantum_kernel.metrics, { coherence_survival_pct: 100 }, metrics);
    assert.equal(coherenceBudget(data).status, "EXCEEDED");
  }
  const upstreamBlocked = fixture();
  upstreamBlocked.stages.stage_1_classical_pre = stage("QPU", 0, { execution_feasible: false });
  upstreamBlocked.stages.stage_2_quantum_kernel = stage("CPU", 0, { coherence_survival_pct: 100 });
  assert.equal(coherenceBudget(upstreamBlocked).status, "EXCEEDED");
});

test("CPU/GPU kernels show the 100% deterministic classical baseline", () => {
  for (const node of ["CPU", "GPU"] as const) {
    const data = fixture();
    data.stages.stage_2_quantum_kernel = stage(node, 1, { coherence_survival_pct: 0 });
    assert.deepEqual(coherenceBudget(data), { survival: 100, classical: true, status: "NOMINAL" });
  }
  const missing = fixture(); delete missing.stages.stage_2_quantum_kernel.metrics.coherence_survival_pct;
  assert.deepEqual(coherenceBudget(missing), { survival: undefined, classical: false, status: null });
});

test("pipeline timing adds separately reported QPU I/O to active compute", () => {
  const data = fixture();
  const timing = pipelineTiming(data);
  near(timing.computeMs, 0.62); near(timing.overheadMs, 0.15); near(timing.totalMs, 0.77);
  data.stages.stage_2_quantum_kernel.metrics.io_readout_ms = 0.02;
  near(pipelineTiming(data).overheadMs, 0.17);
  data.stages.stage_2_quantum_kernel.latency_ms = 0;
  near(pipelineTiming(data).overheadMs, 0.17);
});

test("GPU launch/transfer and kernel overhead are separated once, including mixed routes", () => {
  const data = fixture();
  data.stages.stage_1_classical_pre = stage("GPU", 0.37, { launch_transfer_overhead_ms: 0.3 });
  data.stages.stage_3_classical_post = stage("GPU", 0.38, { launch_transfer_overhead_ms: 0.3 });
  const mixed = pipelineTiming(data);
  near(mixed.computeMs, 0.18); near(mixed.overheadMs, 0.75); near(mixed.totalMs, 0.93);
  data.stages.stage_2_quantum_kernel = stage("GPU", 3.3, { io_state_prep_ms: 0.3, launch_transfer_overhead_ms: 0.3 });
  const gpu = pipelineTiming(data);
  near(gpu.computeMs, 3.15); near(gpu.overheadMs, 0.9); near(gpu.totalMs, 4.05);
});

test("blocked/unsupported stages contribute no compute or retained overhead; CPU routes have no device I/O", () => {
  const data = fixture();
  data.stages.stage_1_classical_pre = stage("CPU", 0.28, { io_state_prep_ms: 123 });
  data.stages.stage_2_quantum_kernel = stage("QPU", 0, { io_state_prep_ms: 0.15 });
  data.stages.stage_3_classical_post = stage("GPU", 0, { launch_transfer_overhead_ms: 0.3, execution_feasible: false });
  assert.deepEqual(pipelineTiming(data), { computeMs: 0.28, overheadMs: 0, totalMs: 0.28 });
  data.stages.stage_2_quantum_kernel = stage("QPU", 0.03, { io_state_prep_ms: 0.15, routing_supported: false });
  assert.deepEqual(pipelineTiming(data), { computeMs: 0.28, overheadMs: 0, totalMs: 0.28 });
});

test("latency buckets separate classical kernels, QPU gates, and combined control overhead", () => {
  const data = fixture();
  data.stages.stage_1_classical_pre = stage("GPU", 0.37, { launch_transfer_overhead_ms: 0.3 });
  data.stages.stage_3_classical_post = stage("GPU", 0.38, { launch_transfer_overhead_ms: 0.3 });
  const buckets = pipelineLatencyBuckets(data);
  near(buckets.classicalMs, 0.15); near(buckets.quantumMs, 0.03); near(buckets.overheadMs, 0.75);
  near(buckets.totalMs, pipelineTiming(data).totalMs);
  near((buckets.classicalMs + buckets.quantumMs + buckets.overheadMs) / buckets.totalMs * 100, 100);
  const original = structuredClone(data);
  pipelineLatencyBuckets(data);
  assert.deepEqual(data, original, "Derived buckets must not mutate completed-run telemetry");
});

test("classical-only, tiny-share, and fully blocked latency buckets stay finite and nonnegative", () => {
  const data = fixture();
  data.stages.stage_2_quantum_kernel = stage("GPU", 3.3, { io_state_prep_ms: 0.3 });
  const classical = pipelineLatencyBuckets(data);
  near(classical.classicalMs, 3.59); near(classical.quantumMs, 0); near(classical.overheadMs, 0.3);
  data.stages.stage_2_quantum_kernel = stage("QPU", 1e9, { io_state_prep_ms: 0.15 });
  const large = pipelineLatencyBuckets(data);
  assert.ok(large.classicalMs > 0 && large.overheadMs > 0 && large.quantumMs / large.totalMs > 0.99);
  for (const item of Object.values(data.stages)) {
    item.latency_ms = 0;
    item.metrics.execution_feasible = false;
  }
  assert.deepEqual(pipelineLatencyBuckets(data), { classicalMs: 0, quantumMs: 0, overheadMs: 0, totalMs: 0 });
});

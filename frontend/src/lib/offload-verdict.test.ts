import assert from "node:assert/strict";
import { test } from "node:test";
import { offloadVerdict } from "./offload-verdict";
import type { HybridTelemetryResponse, SimulationRequest, StageNode, StageTelemetry } from "@/types/telemetry";

const request = (scale_param = 21, available_qubits = 133): SimulationRequest => ({ workload_id: "shors_crypto", scale_param, available_qubits, hardware_profile: "ibm_heron_nisq" });
const stage = (node: StageNode, latency_ms: number, metrics: Record<string, unknown> = {}): StageTelemetry => ({
  name: "Stage", node, latency_ms, metrics, status: "OPTIMAL", output_summary: "Completed",
});
const fixture = (): HybridTelemetryResponse => ({
  workload_id: "shors_crypto", workload_name: "Shor", scale_label: "N = 21", execution_mode: "NISQ_ANALYTICAL_PROFILER", primary_bottleneck: "NONE",
  stages: {
    stage_1_classical_pre: stage("CPU", 0.28),
    stage_2_quantum_kernel: stage("QPU", 0.03, { coherence_survival_pct: 90.33, io_state_prep_ms: 0.15, execution_feasible: true, qubits_required: 13,
      classical_cpu_baseline: { feasible: true, total_ms: 224.59, kernel_ms: 224, memory_budget_gib: 16 } }),
    stage_3_classical_post: stage("CPU", 0.31),
  },
});

test("capacity blockers take precedence over zero coherence and report exact scale-specific deficits", () => {
  for (const [scale, available, deficit] of [[15, 7, 1], [21, 12, 1], [35, 13, 2], [512, 133, 894], [2048, 4096, 3]]) {
    const data = fixture();
    Object.assign(data.stages.stage_2_quantum_kernel.metrics, { execution_feasible: false, coherence_survival_pct: 0 });
    const verdict = offloadVerdict(data, request(scale, available));
    assert.equal(verdict.title, "Capacity Blocked");
    assert.equal(verdict.status, "blocked");
    assert.ok(verdict.message.includes(`${deficit}-qubit deficit`));
  }
});

test("unsupported QPU host routes and starved pipelines never get favorable speedup verdicts", () => {
  const data = fixture();
  data.stages.stage_1_classical_pre = stage("QPU", 0, { routing_supported: false, execution_feasible: false });
  assert.equal(offloadVerdict(data, request()).title, "Routing Blocked");
  data.stages.stage_1_classical_pre = stage("CPU", 0, { execution_feasible: false });
  assert.equal(offloadVerdict(data, request()).title, "Execution Blocked");
});

test("CPU/GPU memory walls use register width and RAM budget, not their deterministic coherence", () => {
  for (const node of ["CPU", "GPU"] as const) {
    const data = fixture();
    data.stages.stage_2_quantum_kernel = stage(node, 0, { execution_feasible: false, coherence_survival_pct: 100, qubits_required: 4099, statevector_memory_budget_gib: node === "CPU" ? 16 : 8 });
    const verdict = offloadVerdict(data, request(2048));
    assert.equal(verdict.title, "Classical Memory Wall");
    assert.match(verdict.message, /2\^4,103 bytes/);
    assert.match(verdict.message, /at least 4,099 usable qubits/);
  }
});

test("coherence below 35% blocks QPU offload ahead of an I/O warning; exactly 35% is degraded", () => {
  const data = fixture();
  data.stages.stage_2_quantum_kernel.metrics.io_state_prep_ms = 2;
  for (const survival of [0, 34.99]) {
    data.stages.stage_2_quantum_kernel.metrics.coherence_survival_pct = survival;
    assert.equal(offloadVerdict(data, request()).title, "Decoherence Wall");
  }
  data.stages.stage_2_quantum_kernel.metrics.coherence_survival_pct = 35;
  data.stages.stage_2_quantum_kernel.metrics.io_state_prep_ms = 0.15;
  assert.equal(offloadVerdict(data, request()).title, "Coherence Degraded");
});

test("overhead must exceed 40% and a faster CPU claim requires an actual baseline comparison", () => {
  const data = fixture();
  data.stages.stage_1_classical_pre.latency_ms = 1;
  data.stages.stage_2_quantum_kernel.latency_ms = 2;
  data.stages.stage_2_quantum_kernel.metrics.io_state_prep_ms = 2;
  data.stages.stage_3_classical_post.latency_ms = 0;
  assert.equal(offloadVerdict(data, request()).title, "Quantum Advantage Window", "Exactly 40% is not dominated");
  data.stages.stage_2_quantum_kernel.metrics.io_state_prep_ms = 2.001;
  const dominated = offloadVerdict(data, request());
  assert.equal(dominated.title, "Interconnect Dominated");
  assert.ok(!dominated.message.includes("CPU execution remains faster"), "High overhead alone does not establish a slower offload run");
  data.stages.stage_2_quantum_kernel.metrics.classical_cpu_baseline = { feasible: true, total_ms: 4, kernel_ms: 3 };
  assert.match(offloadVerdict(data, request()).message, /CPU execution remains faster/);
});

test("nominal coherence requires at least 2x kernel and end-to-end CPU speedup for advantage", () => {
  const data = fixture();
  data.stages.stage_1_classical_pre.latency_ms = 0.25;
  data.stages.stage_2_quantum_kernel.latency_ms = 0.5;
  Object.assign(data.stages.stage_2_quantum_kernel.metrics, { io_state_prep_ms: 0, coherence_survival_pct: 70, classical_cpu_baseline: { feasible: true, total_ms: 2, kernel_ms: 1 } });
  data.stages.stage_3_classical_post.latency_ms = 0.25;
  assert.equal(offloadVerdict(data, request()).title, "Quantum Advantage Window");
  assert.match(offloadVerdict(data, { ...request(), hardware_profile: "ideal_sim" }).message, /ideal noise-free projection/);
  data.stages.stage_2_quantum_kernel.metrics.classical_cpu_baseline = { feasible: true, total_ms: 1.99, kernel_ms: 1 };
  assert.equal(offloadVerdict(data, request()).title, "Offload Comparison Needed");
  data.stages.stage_2_quantum_kernel.metrics.classical_cpu_baseline = { feasible: true, total_ms: 100, kernel_ms: 0.9 };
  assert.equal(offloadVerdict(data, request()).title, "Offload Comparison Needed");
});

test("legacy, infeasible, zero-latency, and classical-only runs retain honest verdicts", () => {
  const data = fixture();
  delete data.stages.stage_2_quantum_kernel.metrics.classical_cpu_baseline;
  assert.equal(offloadVerdict(data, request()).title, "Offload Comparison Needed");
  data.stages.stage_2_quantum_kernel.metrics.classical_cpu_baseline = { feasible: false, kernel_ms: null, total_ms: null, memory_budget_gib: 16 };
  assert.equal(offloadVerdict(data, request()).title, "Quantum Offload Candidate");
  data.stages.stage_2_quantum_kernel = stage("CPU", 1, { coherence_survival_pct: 100 });
  assert.equal(offloadVerdict(data, request()).title, "Classical Baseline");
  data.stages.stage_2_quantum_kernel = stage("QPU", 0, { coherence_survival_pct: 100 });
  data.stages.stage_1_classical_pre.latency_ms = 0;
  data.stages.stage_3_classical_post.latency_ms = 0;
  const verdict = offloadVerdict(data, request());
  assert.equal(verdict.title, "Offload Comparison Needed");
  assert.doesNotMatch(verdict.message, /NaN|Infinity/);
});

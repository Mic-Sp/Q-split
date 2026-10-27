import assert from "node:assert/strict";
import { test } from "node:test";
import { WORKLOADS, workloadScaleLabel, validWorkloadScale, parseSimulationRequest, mipsRoutingContext } from "./workloads";
import { hardwareDefaultQubits, qubitThresholds } from "./telemetry";

test("Quantum-MIPS controls expose all scales, index-width thresholds, and ideal ceilings independently from Shor", () => {
  const scales = [64, 1024, 32768, 131072, 1048576];
  assert.deepEqual(WORKLOADS.quantum_mips.scales, scales);
  for (const [index, scale] of scales.entries()) {
    const k = [6, 10, 15, 17, 20][index];
    assert.deepEqual(qubitThresholds(scale, "quantum_mips"), { minimum: k + 4, windowed: 2 * k + 8, ceiling: 4 * k + 16 });
    assert.match(workloadScaleLabel(scale, "quantum_mips"), /^M = /);
    assert.equal(hardwareDefaultQubits("ideal_sim", scale, "quantum_mips"), 4 * k + 16);
    for (const [profile, capacity] of [["ibm_heron_nisq", 133], ["google_weber_grid", 72], ["ionq_forte_trapped_ion", 36]] as const) {
      assert.equal(hardwareDefaultQubits(profile, scale, "quantum_mips"), capacity);
    }
    assert.equal(validWorkloadScale("shors_crypto", scale), false);
  }
  assert.deepEqual(qubitThresholds(15), { minimum: 8, windowed: 12, ceiling: 22 });
  assert.equal(hardwareDefaultQubits("ideal_sim", 512), 2816);
  assert.equal(workloadScaleLabel(2048), "RSA-2048");
  assert.match(WORKLOADS.quantum_mips.stages.join(" "), /LSH.*Grover-Max.*FP16/);
  assert.match(mipsRoutingContext(64), /CPU → QPU → CPU.*0.30 ms/);
  assert.match(mipsRoutingContext(1024), /GPU → QPU → GPU.*0.12×.*0.10×/);
});

test("simulation validation applies workload-specific defaults and rejects cross-workload scales and malformed controls", () => {
  assert.equal(parseSimulationRequest({ hardware_profile: "ideal_sim" }).scale_param, 15);
  assert.equal(parseSimulationRequest({ workload_id: "quantum_mips", hardware_profile: "ideal_sim" }).scale_param, 64);
  const base = { workload_id: "quantum_mips", scale_param: 64, hardware_profile: "ideal_sim", available_qubits: 17 };
  assert.deepEqual(parseSimulationRequest(base), base);
  for (const mutation of [{ workload_id: "unknown" }, { workload_id: null }, { scale_param: 15 }, { scale_param: 2048 },
    { scale_param: "64" }, { scale_param: null }, { hardware_profile: "unknown" }, { available_qubits: 0 }, { available_qubits: 1.5 },
    { routing: [] }, { routing: { stage_4_node: "CPU" } }, { routing: { stage_2_node: "TPU" } }]) {
    assert.throws(() => parseSimulationRequest({ ...base, ...mutation }));
  }
});

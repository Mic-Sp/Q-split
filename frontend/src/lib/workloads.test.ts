import assert from "node:assert/strict";
import { test } from "node:test";
import { WORKLOADS, SCALE_DESCRIPTIONS, activeParallelizationTier, workloadScaleLabel, validWorkloadScale, parseSimulationRequest, mipsRoutingContext } from "./workloads";
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

test("active tier follows threshold intervals, ceiling saturation, and invalid or insufficient custom capacities for both workloads", () => {
  for (const workload of ["shors_crypto", "quantum_mips"] as const) {
    for (const scale of WORKLOADS[workload].scales) {
      const { minimum, windowed, ceiling } = qubitThresholds(scale, workload);
      for (const [capacity, active] of [[minimum - 1, null], [minimum, "minimum"], [windowed - 1, "minimum"],
        [windowed, "windowed"], [ceiling - 1, "windowed"], [ceiling, "ceiling"], [ceiling + 100, "ceiling"],
        [2_147_483_647, "ceiling"]] as const) {
        assert.equal(activeParallelizationTier(scale, capacity, workload), active, `${workload}/${scale}/${capacity}`);
      }
      for (const invalid of [NaN, Infinity, -Infinity, 0, -1, minimum + 0.5, 2_147_483_648]) {
        assert.equal(activeParallelizationTier(scale, invalid, workload), null);
      }
    }
  }
});

test("every supported target scale has workload-specific context without promising live execution in parallel tiers", () => {
  for (const workload of ["shors_crypto", "quantum_mips"] as const) {
    assert.deepEqual(Object.keys(SCALE_DESCRIPTIONS[workload]).map(Number), WORKLOADS[workload].scales);
    for (const scale of WORKLOADS[workload].scales) assert.ok(SCALE_DESCRIPTIONS[workload][scale].length > 100);
  }
  assert.match(SCALE_DESCRIPTIONS.shors_crypto[15], /sequential tier.*live 8-qubit Qiskit Aer/);
  assert.match(SCALE_DESCRIPTIONS.shors_crypto[2048], /4,099–11,264.*38.6B.*multi-hour/);
  assert.match(SCALE_DESCRIPTIONS.quantum_mips[64], /sequential tier.*live 10-qubit.*0.30ms/);
  assert.match(SCALE_DESCRIPTIONS.quantum_mips[1024], /Stage 1 LSH.*Stage 3 FP16/);
  assert.match(SCALE_DESCRIPTIONS.quantum_mips[32768], /32,768.*142 Grover/);
  assert.match(SCALE_DESCRIPTIONS.quantum_mips[131072], /131,072.*285 Grover/);
  assert.match(SCALE_DESCRIPTIONS.quantum_mips[1048576], /1,048,576.*Multi-Oracle/);
});

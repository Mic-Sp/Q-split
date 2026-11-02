"""Workload adapters keep resource definitions independent from hardware physics."""

from unittest.mock import patch

import pytest

from backend.main import HARDWARE_PROFILES, RoutingConfig, STAGE_KEYS, run_quantum_mips_pipeline, run_shors_pipeline


@pytest.mark.parametrize("pipeline,scale", [(run_shors_pipeline, 21), (run_quantum_mips_pipeline, 1024)])
@pytest.mark.parametrize("capacity", [1, 133])
@pytest.mark.parametrize("nodes", [("CPU", "QPU", "CPU"), ("GPU", "QPU", "GPU"),
                                  ("CPU", "CPU", "CPU"), ("GPU", "GPU", "GPU"), ("QPU", "QPU", "CPU")])
def test_every_route_response_carries_calibrated_version(pipeline, scale, capacity, nodes):
    routing = RoutingConfig(stage_1_node=nodes[0], stage_2_node=nodes[1], stage_3_node=nodes[2])
    response = pipeline(scale, "ibm_heron_nisq", routing, capacity).model_dump()
    assert response["resource_model_version"] == 2
    assert response["routing_model"] == "CALIBRATED_V2"
    for stage in response["stages"].values():
        if "routing_model" in stage["metrics"]:
            assert stage["metrics"]["routing_model"] == "CALIBRATED_V2"
        if "resource_model_version" in stage["metrics"]:
            assert stage["metrics"]["resource_model_version"] == 2


@pytest.mark.parametrize("pipeline,scale", [(run_shors_pipeline, 21), (run_quantum_mips_pipeline, 1024)])
@pytest.mark.parametrize("capacity", [53, 72, 133, 1024])
def test_weber_reference_and_exploratory_capacities_remain_independent(pipeline, scale, capacity):
    kernel = pipeline(scale, "google_weber_grid", available_qubits=capacity).stages[STAGE_KEYS[1]]
    assert kernel.metrics["reference_qubits"] == 53
    assert kernel.metrics["available_qubits"] == capacity
    assert kernel.metrics["capacity_override"] is (capacity > 53)
    assert kernel.metrics["execution_feasible"]
    assert kernel.metrics["qpu_profile"]["n_qubits_max"] == 53
    assert kernel.metrics["qpu_profile"]["native_2q_per_cx"] == 2.0


@pytest.mark.parametrize("pipeline,scale,capacity", [(run_shors_pipeline, 21, 13), (run_quantum_mips_pipeline, 1024, 14)])
def test_same_workload_constructs_identical_spec_for_every_hardware_profile(pipeline, scale, capacity):
    stages = [pipeline(scale, profile, available_qubits=capacity).stages[STAGE_KEYS[1]] for profile in HARDWARE_PROFILES]
    assert all(stage.metrics["circuit_spec"] == stages[0].metrics["circuit_spec"] for stage in stages)
    assert all(stage.metrics["classical_baselines"] == stages[0].metrics["classical_baselines"] for stage in stages)
    assert len({stage.latency_ms for stage in stages}) == len(HARDWARE_PROFILES)
    for stage in stages:
        assert stage.metrics["resource_model_version"] == 2
        assert stage.metrics["qpu_io_included_in_latency"]
        assert stage.metrics["io_state_prep_ms"] == 0


@pytest.mark.parametrize("pipeline,scale", [(run_shors_pipeline, 21), (run_quantum_mips_pipeline, 1024)])
@pytest.mark.parametrize("node", ["CPU", "GPU"])
def test_classical_routers_never_invoke_qpu_physics(pipeline, scale, node):
    with patch("backend.main.estimate_qpu", side_effect=AssertionError("Classical emulation must not use hardware physics")):
        stage = pipeline(scale, "ionq_forte_trapped_ion", RoutingConfig(stage_2_node=node), 1).stages[STAGE_KEYS[1]]
    assert stage.metrics["coherence_survival_pct"] == 100
    assert stage.metrics["classical_baselines"]["circuit_emulation"]["name"] == "Classical Circuit Emulation"
    assert stage.metrics["classical_baselines"]["native_algorithm"]["available"]


@pytest.mark.parametrize("node", ["CPU", "GPU", "QPU"])
def test_live_mips_depth_and_gate_counts_are_cross_checks_only(node):
    reference = {"aer_reference_circuit_depth": 640, "aer_reference_qubits": 10, "aer_shots": 1024,
                 "aer_counts": {"101101": 1024}, "top_1_token_index": 45, "measured_peak_probability": 1,
                 "aer_compile_time_ms": 2, "aer_runtime_ms": 1, "aer_total_time_ms": 3}
    stages = []
    for compiled_depth, two_qubit_count in [(640, 10), (5000, 1000)]:
        with patch("backend.main.execute_live_quantum_mips_64", return_value={
            **reference, "aer_reference_circuit_depth": compiled_depth, "aer_gate_counts": {"cx": two_qubit_count, "rz": 100, "sx": 10, "measure": 6},
        }):
            stages.append(run_quantum_mips_pipeline(64, "ibm_heron_nisq", RoutingConfig(stage_2_node=node), available_qubits=10).stages[STAGE_KEYS[1]])
    assert [stage.metrics["aer_reference_circuit_depth"] for stage in stages] == [640, 5000]
    assert [stage.metrics["aer_gate_counts"]["cx"] for stage in stages] == [10, 1000]
    for key in ["circuit_spec", "circuit_depth", "reference_circuit_depth", "classical_baselines", "classical_cpu_baseline"]:
        assert stages[0].metrics[key] == stages[1].metrics[key]
    assert stages[0].latency_ms == stages[1].latency_ms
    assert stages[0].metrics["coherence_survival_pct"] == stages[1].metrics["coherence_survival_pct"]

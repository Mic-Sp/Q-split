"""SKQD family contracts, independent resource equations and route integration."""

import itertools
import json
import math
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from backend.estimation import estimate_qpu, estimate_qpu_family, estimate_classical_family
from backend.main import (SimulationRequest, RoutingConfig, run_skqd_pipeline, app,
                          QPU_LAUNCH_OVERHEAD_MS, STAGE_KEYS)
from backend.models import (CircuitSpec, SKQDParameters, KrylovCircuitMember,
                            KrylovCircuitFamily, InterconnectConfig)
from backend.profiles import HARDWARE_PROFILES, execution_profile
from backend.skqd import build_skqd_pipeline, skqd_host_resources
from backend.workloads import skqd_family, skqd_hamiltonian_terms


@pytest.fixture(autouse=True)
def local_engine_environment(monkeypatch):
    for variable in ("ENGINE_ENV", "ENGINE_SECRET", "ENGINE_ENABLE_DOCS"):
        monkeypatch.delenv(variable, raising=False)


def test_request_defaults_and_legacy_defaults_are_independent():
    payload = {"workload_id": "skqd"}
    request = SimulationRequest(**payload)
    assert request.scale_param == 22
    assert request.skqd == SKQDParameters(krylov_dimension=5, trotter_steps=6,
        shots_per_state=100_000, retained_subspace_dimension=10_000)
    assert payload == {"workload_id": "skqd"}
    assert SimulationRequest().scale_param == 15
    assert SimulationRequest(workload_id="quantum_mips").scale_param == 64
    assert SimulationRequest().skqd is None


@pytest.mark.parametrize("scale", [12, 22, 85])
def test_supported_scale_and_hamiltonian_terms(scale):
    assert SimulationRequest(workload_id="skqd", scale_param=scale).scale_param == scale
    assert skqd_hamiltonian_terms(scale) == (4 * scale**2 if scale == 85 else 3 * scale)


@pytest.mark.parametrize("scale", [15, 21, 23, 86, 0, True, 22.0, "22", None])
def test_invalid_scale_is_rejected(scale):
    with pytest.raises(ValidationError):
        SimulationRequest(workload_id="skqd", scale_param=scale)


@pytest.mark.parametrize("field,minimum,maximum", [
    ("krylov_dimension", 2, 15), ("trotter_steps", 1, 20),
    ("shots_per_state", 1_000, 1_000_000), ("retained_subspace_dimension", 100, 250_000)])
def test_parameter_bounds_and_strict_types(field, minimum, maximum):
    for value in (minimum, maximum):
        assert getattr(SKQDParameters(**{field: value}), field) == value
    for value in (minimum - 1, maximum + 1, True, float(minimum), str(minimum), None, math.inf, math.nan):
        with pytest.raises(ValidationError):
            SimulationRequest(workload_id="skqd", skqd={field: value})


def test_nested_unknown_parameters_and_wrong_workload_are_rejected():
    with pytest.raises(ValidationError):
        SimulationRequest(workload_id="skqd", skqd={"krylov_dimenson": 6})
    for workload in ("shors_crypto", "quantum_mips"):
        with pytest.raises(ValidationError):
            SimulationRequest(workload_id=workload, skqd={})


@pytest.mark.parametrize("q,d,m,depths,one,two", [
    (12, 3, 2, [1, 13, 25], [12, 60, 108], [0, 66, 132]),
    (22, 5, 6, [1, 37, 73, 109, 145], [22, 286, 550, 814, 1078], [0, 378, 756, 1134, 1512]),
])
def test_explicit_power_resources(q, d, m, depths, one, two):
    family = skqd_family(q, SKQDParameters(krylov_dimension=d, trotter_steps=m))
    assert [member.power_index for member in family.members] == list(range(d))
    assert [member.circuit_spec.depth for member in family.members] == depths
    assert [member.circuit_spec.n_1q for member in family.members] == one
    assert [member.circuit_spec.n_2q for member in family.members] == two
    assert all(member.circuit_spec.n_meas == q and member.shots == 100_000 for member in family.members)
    assert all(member.circuit_spec.stage1_ms == member.circuit_spec.stage3_ms == 0 for member in family.members)


def test_toy_calibration_never_changes_skqd_resources(monkeypatch):
    before = skqd_family(85)
    monkeypatch.setattr("backend.workloads.DEPTH_EXPANSION_FACTOR", 1000)
    monkeypatch.setattr("backend.workloads.GATE_COUNT_EXPANSION_FACTOR", 1000)
    assert skqd_family(85) == before
    last = before.members[-1].circuit_spec
    assert (last.depth, last.n_1q, last.n_2q) == (145, 4165, 6048)


def test_family_validation_preserves_strict_single_circuit_contract():
    family = skqd_family(12)
    spec = family.members[0].circuit_spec
    for change in ({"depth": [1, 2]}, {"power_index": 0}, {"shots": 1000}):
        with pytest.raises(ValidationError):
            CircuitSpec.model_validate({**spec.model_dump(), **change})
    for members in (family.members[:1], family.members * 4, family.members[::-1],
                    (family.members[0], family.members[2])):
        with pytest.raises(ValidationError):
            KrylovCircuitFamily(members=members)
    with pytest.raises(ValidationError):
        KrylovCircuitFamily(members=(family.members[0], skqd_family(22).members[1]))
    with pytest.raises(ValidationError):
        KrylovCircuitMember(power_index=0, circuit_spec=spec.model_copy(update={"stage1_ms": 2.0}), shots=1000)
    invalid = family.model_copy(update={"members": (family.members[0].model_copy(update={"shots": True}),
                                                   family.members[1])})
    with pytest.raises(ValidationError):
        estimate_qpu_family(invalid, HARDWARE_PROFILES["ideal_sim"], 0.3)
    assert KrylovCircuitFamily.model_validate_json(family.model_dump_json()) == family


@pytest.mark.parametrize("profile_id", HARDWARE_PROFILES)
def test_members_use_existing_hardware_estimator_and_one_launch(profile_id):
    family = skqd_family(12, SKQDParameters(krylov_dimension=3, shots_per_state=1000))
    profile = HARDWARE_PROFILES[profile_id]
    result = estimate_qpu_family(family, profile, 0.3)
    independent = [estimate_qpu(member.circuit_spec, profile, member.shots, 0.0) for member in family.members]
    assert [entry["metrics"] for entry in result["krylov_members"]] == independent
    assert result["latency_ms"] == pytest.approx(0.3 + sum(estimate["latency_ms"] for estimate in independent))
    assert result["launch_overhead_ms"] == 0.3
    assert result["latency_ms"] == pytest.approx(sum(result[key] for key in
        ("launch_overhead_ms", "gate_execution_ms", "measurement_reset_ms")))
    assert all(entry["metrics"]["launch_overhead_ms"] == 0 for entry in result["krylov_members"])
    assert "circuit_spec" not in result and "log_survival_terms" not in result
    assert "coherence_log_survival" not in result
    assert result["family_survival"]["deepest_member"]["point"] == independent[-1]["coherence_survival"]


def test_zero_power_and_per_member_repetition_floor():
    family = skqd_family(12, SKQDParameters(krylov_dimension=3, trotter_steps=20, shots_per_state=1000))
    result = estimate_qpu_family(family, HARDWARE_PROFILES["ibm_nighthawk_r2"], 0.3)
    zero = result["krylov_members"][0]
    assert zero["circuit_spec"]["n_2q"] == 0
    assert zero["metrics"]["latency_ms"] == pytest.approx(10.0)
    assert zero["metrics"]["repetition_delay_ms"] > 0
    assert [entry["metrics"]["circuit_depth"] for entry in result["krylov_members"]] == [2, 146, 290]
    assert result["latency_ms"] == pytest.approx(34.4)
    assert zero["metrics"]["t_circuit_us"] == pytest.approx(0.08)


@pytest.mark.parametrize("profile_id", HARDWARE_PROFILES)
def test_shot_weighted_survival_and_expected_samples(profile_id):
    family = skqd_family(12, SKQDParameters(krylov_dimension=3))
    family = family.model_copy(update={"members": tuple(member.model_copy(update={"shots": shots})
        for member, shots in zip(family.members, (1000, 3000, 10000)))})
    result = estimate_qpu_family(family, HARDWARE_PROFILES[profile_id], 0.3)
    for field in ("coherence_survival", "coherence_survival_best", "coherence_survival_worst"):
        expected = sum(member["shots"] * member["metrics"][field] for member in result["krylov_members"]) / 14000
        assert result[field] == pytest.approx(expected)
    assert result["family_survival"]["expected_surviving_samples"] == pytest.approx(14000 * result["coherence_survival"])
    assert 0 <= result["coherence_survival_worst"] <= result["coherence_survival_best"] <= 1
    assert len(result["krylov_members"]) == 3


@pytest.mark.parametrize("t2", [None, 1000.0])
def test_t2_fallback_and_cap(t2):
    profile = HARDWARE_PROFILES["ibm_heron_nisq"].model_copy(update={"t2_us": t2})
    result = estimate_qpu_family(skqd_family(12), profile, 0.3)
    assert result["coherence_survival_worst"] == result["coherence_survival_best"]


def test_survival_underflow_retains_log_and_expected_sample_information():
    profile = HARDWARE_PROFILES["ideal_sim"].model_copy(update={"t1_us": 0.004, "t2_us": 0.004})
    result = estimate_qpu_family(skqd_family(12, SKQDParameters(shots_per_state=1_000_000)), profile, 0.3)
    summary = result["family_survival"]
    assert result["coherence_survival"] == 0
    assert summary["log_point"] == pytest.approx(-750 - math.log(5))
    assert math.isfinite(summary["log_worst"])
    assert summary["expected_surviving_samples"] > 0
    json.dumps(result, allow_nan=False)


def test_certain_failure_and_infeasible_family_are_json_safe():
    family = skqd_family(12)
    for profile in (HARDWARE_PROFILES["ideal_sim"].model_copy(update={"err_meas": 1.0}),
                    execution_profile(HARDWARE_PROFILES["ideal_sim"], 11)):
        result = estimate_qpu_family(family, profile, 0.3)
        assert result["coherence_survival"] == 0
        assert result["family_survival"]["log_point"] is None
        assert result["family_survival"]["expected_surviving_samples"] == 0
        if not result["execution_feasible"]:
            assert result["latency_ms"] == result["launch_overhead_ms"] == 0
        json.dumps(result, allow_nan=False)


@pytest.mark.parametrize("launch", [-1, True, math.inf, math.nan, "0.3", None])
def test_family_launch_validation(launch):
    with pytest.raises(ValueError):
        estimate_qpu_family(skqd_family(12), HARDWARE_PROFILES["ideal_sim"], launch)


@pytest.mark.parametrize("node,ns_per_op,launch", [("CPU", 2, 0), ("GPU", 0.5, 0.3)])
def test_classical_compute_sums_distributions_but_ram_and_host_costs_do_not(node, ns_per_op, launch):
    family = skqd_family(12, SKQDParameters(krylov_dimension=3, trotter_steps=2), stage1_ms=2, stage3_ms=7)
    estimate = estimate_classical_family(family, node)["circuit_emulation"]
    # Counts above give total amplitude work (24 + 204 + 384) * 4096.
    compute = (24 + 204 + 384) * 4096 * ns_per_op / 1e6
    assert estimate["compute_latency_ms"] == pytest.approx(compute)
    assert estimate["kernel_ms"] == pytest.approx(compute + launch)
    assert estimate["total_ms"] == pytest.approx(compute + launch + 9)
    assert estimate["memory_required_bytes"] == 65536
    more_shots = skqd_family(12, SKQDParameters(krylov_dimension=3, trotter_steps=2, shots_per_state=1_000_000),
                             stage1_ms=2, stage3_ms=7)
    assert estimate_classical_family(more_shots, node)["circuit_emulation"] == estimate


@pytest.mark.parametrize("q", [12, 22, 85])
@pytest.mark.parametrize("node", ["CPU", "GPU"])
def test_statevector_memory_feasibility(q, node):
    cost = estimate_classical_family(skqd_family(q), node)["circuit_emulation"]
    assert cost["memory_required_bytes"] == 16 * 2**q
    assert cost["feasible"] == (q != 85)
    if q == 85:
        assert cost["kernel_ms"] is cost["total_ms"] is None


def test_stage3_sparse_work_and_memory_equations_and_R_scaling():
    small = skqd_host_resources(22, SKQDParameters(retained_subspace_dimension=100))
    large = skqd_host_resources(22, SKQDParameters(retained_subspace_dimension=200))
    assert small["total_raw_samples"] == 500_000
    assert small["recovery_bit_operations"] == 11_000_000
    assert small["projected_matrix_nnz"] == 6600
    assert small["solver_flops"] == 30 * 6600
    assert small["subspace_peak_memory_bytes"] == 24 * 6600 + 6 * 16 * 100
    assert small["projection_operations"] == pytest.approx(66 * 100 * math.log2(100))
    assert small["cpu_recovery_ms"] == 22
    assert small["cpu_projection_ms"] == pytest.approx(66 * 100 * math.log2(100) * 10 / 1e6)
    assert small["cpu_eigensolver_ms"] == pytest.approx(30 * 6600 * 2 / 1e6)
    assert large["subspace_peak_memory_bytes"] == 2 * small["subspace_peak_memory_bytes"]
    assert large["cpu_postprocessing_ms"] > small["cpu_postprocessing_ms"]
    assert large["cpu_recovery_ms"] == small["cpu_recovery_ms"]


@pytest.mark.parametrize("q,d,shots,requested,retained", [
    (12, 5, 100_000, 10_000, 4096), (22, 2, 1000, 250_000, 2000),
    (85, 5, 100_000, 10_000, 10_000), (85, 15, 1_000_000, 250_000, 250_000)])
def test_retained_basis_caps_without_allocating_Hilbert_space(q, d, shots, requested, retained):
    resources = skqd_host_resources(q, SKQDParameters(krylov_dimension=d, shots_per_state=shots,
                                                     retained_subspace_dimension=requested))
    assert resources["retained_subspace_dimension"] == retained
    assert resources["projected_matrix_nnz"] == retained * min(retained, resources["hamiltonian_pauli_terms"])


def test_recovery_work_scales_with_d_and_shots():
    first = skqd_host_resources(22, SKQDParameters(krylov_dimension=2, shots_per_state=1000, retained_subspace_dimension=100))
    second = skqd_host_resources(22, SKQDParameters(krylov_dimension=4, shots_per_state=1000, retained_subspace_dimension=100))
    third = skqd_host_resources(22, SKQDParameters(krylov_dimension=2, shots_per_state=2000, retained_subspace_dimension=100))
    assert second["cpu_recovery_ms"] == third["cpu_recovery_ms"] == 2 * first["cpu_recovery_ms"]
    assert second["subspace_peak_memory_bytes"] == third["subspace_peak_memory_bytes"] == first["subspace_peak_memory_bytes"]


def test_stage3_GPU_breakdown_crossover_and_provenance():
    cpu = run_skqd_pipeline(22, "ideal_sim")
    gpu = run_skqd_pipeline(22, "ideal_sim", RoutingConfig(stage_3_node="GPU"))
    post = gpu.stages[STAGE_KEYS[2]]
    assert post.latency_ms == pytest.approx(cpu.stages[STAGE_KEYS[2]].latency_ms * 0.25 + 0.3)
    assert post.latency_ms == pytest.approx(sum(post.metrics[key] for key in
        ("recovery_compute_ms", "projection_compute_ms", "eigensolver_compute_ms", "launch_transfer_overhead_ms")))
    assert post.metrics["subspace_peak_memory_bytes"] == cpu.stages[STAGE_KEYS[2]].metrics["subspace_peak_memory_bytes"]
    ratio = post.latency_ms / gpu.stages[STAGE_KEYS[1]].latency_ms
    assert post.metrics["classical_to_quantum_latency_ratio"] == pytest.approx(ratio)
    assert post.metrics["bottleneck_regime"] == ("classical-diagonalization-bound" if ratio >= 1 else "quantum-sampling-bound")
    assert post.metrics["solver_provenance"]["precision"] == "complex128"
    assert "utilization" not in gpu.model_dump_json().lower()


def test_weighted_mean_governs_status_instead_of_deepest_member():
    profile = HARDWARE_PROFILES["ideal_sim"].model_copy(update={"t1_us": 300.0, "t2_us": 300.0})
    data = build_skqd_pipeline(12, SKQDParameters(krylov_dimension=2, trotter_steps=20), profile, 12,
                              RoutingConfig().model_dump(), 0.3)
    kernel = data["stages"][STAGE_KEYS[1]]
    assert 35 < kernel["metrics"]["coherence_survival_pct"] < 70
    assert kernel["metrics"]["family_survival"]["deepest_member"]["point"] < 0.35
    assert kernel["status"] == "WARNING"
    assert kernel["metrics"]["coherence_status"] == "DEGRADED"


@pytest.mark.parametrize("nodes", list(itertools.product(("CPU", "GPU", "QPU"), repeat=3)))
def test_all_routes_and_starvation(nodes):
    routing = RoutingConfig(**dict(zip(("stage_1_node", "stage_2_node", "stage_3_node"), nodes)))
    response = run_skqd_pipeline(12, "ideal_sim", routing)
    stages = [response.stages[key] for key in STAGE_KEYS]
    assert [stage.node for stage in stages] == list(nodes)
    assert stages[0].metrics["execution_feasible"] == (nodes[0] != "QPU")
    assert stages[1].metrics["execution_feasible"] == (nodes[0] != "QPU")
    assert stages[2].metrics["execution_feasible"] == (nodes[0] != "QPU" and nodes[2] != "QPU")
    for stage in stages:
        if not stage.metrics["execution_feasible"]:
            assert stage.latency_ms == stage.metrics["compute_latency_ms"] == 0
    if nodes[0] == "QPU" or nodes[2] == "QPU":
        assert stages[2].metrics["classical_to_quantum_latency_ratio"] is None
    json.dumps(response.model_dump(), allow_nan=False)


@pytest.mark.parametrize("scale,node,capacity", [(22, "QPU", 21), (85, "CPU", 133), (85, "GPU", 133)])
def test_capacity_and_emulation_blockers_starve_postprocessing(scale, node, capacity):
    response = run_skqd_pipeline(scale, "ideal_sim", RoutingConfig(stage_2_node=node), capacity)
    kernel, post = [response.stages[key] for key in STAGE_KEYS[1:]]
    assert not kernel.metrics["execution_feasible"]
    assert kernel.latency_ms == post.latency_ms == 0
    assert post.metrics["subspace_peak_memory_bytes"] > 0
    assert post.metrics["classical_to_quantum_latency_ratio"] is None


def test_linked_family_transfer_costs_are_counted_once():
    family = skqd_family(22, SKQDParameters(krylov_dimension=3),
                         interconnect=InterconnectConfig(placement="dual", transfer_duration_ns=100.0))
    result = estimate_qpu_family(family, HARDWARE_PROFILES["ibm_nighthawk_r3_dual"], 0.3)
    assert result["krylov_members"][0]["metrics"]["transfers_per_shot"] == 0
    assert result["link_execution_ms"] > 0
    assert result["link_execution_ms"] < result["gate_execution_ms"]
    assert result["latency_ms"] == pytest.approx(result["launch_overhead_ms"] + result["gate_execution_ms"] + result["measurement_reset_ms"])


def test_api_defaults_bounded_payload_and_no_aer_execution():
    with TestClient(app) as client, patch("backend.main.execute_live_shors_15", side_effect=AssertionError), patch(
            "backend.main.execute_live_quantum_mips_64", side_effect=AssertionError):
        for scale in (12, 22, 85):
            result = client.post("/api/simulate", json={"workload_id": "skqd", "scale_param": scale,
                "skqd": {"krylov_dimension": 15, "trotter_steps": 20, "shots_per_state": 1_000_000,
                         "retained_subspace_dimension": 250_000}})
            assert result.status_code == 200, result.text
            data = result.json()
            assert data["resource_model_version"] == 2 and data["routing_model"] == "CALIBRATED_V2"
            assert data["execution_mode"] == "NISQ_ANALYTICAL_PROFILER"
            assert len(data["stages"][STAGE_KEYS[1]]["metrics"]["krylov_members"]) == 15
            assert len(result.content) < 65_536
            assert data["stages"][STAGE_KEYS[1]]["metrics"]["launch_overhead_ms"] == QPU_LAUNCH_OVERHEAD_MS
        default = client.post("/api/simulate", json={"workload_id": "skqd"})
        assert default.status_code == 200
        assert default.json()["stages"][STAGE_KEYS[1]]["metrics"]["qubits_required"] == 22


def test_invalid_api_parameters_are_rejected_before_dispatch():
    with TestClient(app) as client, patch("backend.main.run_skqd_pipeline") as dispatch:
        for body in ({"scale_param": 15}, {"skqd": {"krylov_dimension": 16}},
                     {"skqd": {"shots_per_state": True}}, {"skqd": {"unexpected": 6}}):
            assert client.post("/api/simulate", json={"workload_id": "skqd", **body}).status_code == 422
        dispatch.assert_not_called()


def test_SKQD_obeys_engine_authentication(monkeypatch):
    monkeypatch.setenv("ENGINE_SECRET", "skqd-test-secret")
    with TestClient(app) as client, patch("backend.main.run_skqd_pipeline") as dispatch:
        assert client.post("/api/simulate", json={"workload_id": "skqd"}).status_code == 401
        dispatch.assert_not_called()

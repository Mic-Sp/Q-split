"""Independent equation checks and BYOC boundary cases for the resource models."""

import math

import pytest
from pydantic import ValidationError

from backend.estimation import estimate_classical, estimate_qpu
from backend.models import CircuitSpec, QPUProfile
from backend.profiles import HARDWARE_PROFILES, execution_profile


@pytest.fixture
def spec():
    return CircuitSpec(n_qubits=3, depth=10, n_1q=12, n_2q=6, n_meas=3, stage1_ms=2, stage3_ms=4)


@pytest.fixture
def profile():
    return QPUProfile(id="custom", name="Custom device", n_qubits_max=3,
                      t1_us=200, t2_us=100, t_1q_ns=25, t_2q_ns=100,
                      t_meas_ns=2000, t_reset_ns=3000, err_1q=0.01,
                      err_2q=0.02, err_meas=0.03, topology_factor=1, provenance={})


def test_complete_repetition_and_survival_equations(spec, profile):
    actual = estimate_qpu(spec, profile, shots=100, launch_overhead_ms=0.5)
    assert actual["latency_ms"] == pytest.approx(0.5 + 100 * (10 * 100 + 2000 + 3000) / 1e6)
    assert actual["t_circuit_us"] == 1
    expected = 0.99**12 * 0.98**6 * 0.97**3 * math.exp(-3 * 1 / 200)
    assert actual["coherence_survival"] == pytest.approx(expected)
    assert actual["coherence_survival_pct"] == pytest.approx(100 * expected)
    assert actual["execution_feasible"]
    assert actual["latency_ms"] == pytest.approx(sum(actual[key] for key in
        ("gate_execution_ms", "measurement_reset_ms", "launch_overhead_ms")))


def test_shots_repeat_reset_and_measurement_but_not_survival(spec, profile):
    one = estimate_qpu(spec, profile, 1, 0.3)
    many = estimate_qpu(spec, profile, 512, 0.3)
    assert many["latency_ms"] - 0.3 == pytest.approx(512 * (one["latency_ms"] - 0.3))
    assert many["coherence_survival"] == one["coherence_survival"]
    slower_readout = profile.model_copy(update={"t_meas_ns": 20000, "t_reset_ns": 50000})
    assert estimate_qpu(spec, slower_readout, 1, 0.3)["coherence_survival"] == one["coherence_survival"]


def test_topology_expands_depth_and_two_qubit_errors_once_without_mutation(spec, profile):
    routed = profile.model_copy(update={"topology_factor": 1.5})
    result = estimate_qpu(spec, routed, 1, 0)
    assert result["circuit_depth"] == 15
    assert result["n_2q"] == 9
    assert result["coherence_survival"] == pytest.approx(0.99**12 * 0.98**9 * 0.97**3 * math.exp(-3 * 1.5 / 200))
    assert spec.depth == 10 and spec.n_2q == 6
    assert profile.topology_factor == 1


def test_capacity_is_inclusive_and_cannot_charge_an_infeasible_execution(spec, profile):
    assert estimate_qpu(spec, profile, 100, 0.5)["execution_feasible"]
    too_small = profile.model_copy(update={"n_qubits_max": 2})
    blocked = estimate_qpu(spec, too_small, 100, 0.5)
    assert not blocked["execution_feasible"]
    for key in ("latency_ms", "gate_execution_ms", "measurement_reset_ms", "launch_overhead_ms", "coherence_survival"):
        assert blocked[key] == 0


def test_unit_conversions_and_noise_free_reference(spec):
    assert HARDWARE_PROFILES["ibm_heron_nisq"].t1_us == 200
    assert HARDWARE_PROFILES["google_weber_grid"].t_2q_ns == 12
    assert HARDWARE_PROFILES["ionq_forte_trapped_ion"].t1_us == 100 * 1e6
    ideal = estimate_qpu(spec, HARDWARE_PROFILES["ideal_sim"], 512, 0.3)
    assert ideal["coherence_survival"] == 1
    assert ideal["latency_ms"] > 0.3


def test_certain_errors_with_no_gates_and_large_depth_underflow_stay_finite(spec, profile):
    certain_error = profile.model_copy(update={"err_2q": 1})
    assert estimate_qpu(spec, certain_error, 1, 0)["coherence_survival"] == 0
    empty = spec.model_copy(update={"depth": 0, "n_1q": 0, "n_2q": 0, "n_meas": 0})
    assert estimate_qpu(empty, certain_error, 1, 0)["coherence_survival"] == 1
    huge = spec.model_copy(update={"depth": 100_000_000_000, "n_2q": 100_000_000_000})
    result = estimate_qpu(huge, profile, 512, 0.3)
    assert result["coherence_survival"] == 0
    assert math.isfinite(result["latency_ms"])


@pytest.mark.parametrize("node,limit", [("CPU", 30), ("GPU", 29)])
def test_emulation_ram_limits_do_not_block_native_classical_algorithm(spec, node, limit):
    supplied = spec.model_copy(update={"n_qubits": limit, "native_classical_ms": 5,
                                      "native_classical_name": "Task-specific classical comparator"})
    exact = estimate_classical(supplied, node)
    assert exact["circuit_emulation"]["feasible"]
    assert exact["circuit_emulation"]["memory_required_bytes"] == exact["circuit_emulation"]["memory_budget_bytes"]
    over = estimate_classical(supplied.model_copy(update={"n_qubits": limit + 1}), node)
    assert not over["circuit_emulation"]["feasible"]
    assert over["circuit_emulation"]["kernel_ms"] is None
    assert over["circuit_emulation"]["compute_latency_ms"] is None
    assert over["circuit_emulation"]["launch_transfer_overhead_ms"] == 0
    assert over["native_algorithm"]["feasible"]
    assert over["native_algorithm"] == exact["native_algorithm"]


def test_unknown_native_algorithm_is_unavailable_and_huge_byoc_width_is_safe(spec):
    generic = estimate_classical(spec, "CPU")
    assert generic["native_algorithm"]["available"] is False
    assert generic["native_algorithm"]["kernel_ms"] is None
    huge = estimate_classical(spec.model_copy(update={"n_qubits": 2_147_483_647}), "CPU")
    assert not huge["circuit_emulation"]["feasible"]
    assert huge["circuit_emulation"]["memory_required_bytes"] is None


def test_classical_baselines_preserve_supplied_host_costs_and_charge_gpu_launch_once(spec):
    supplied = spec.model_copy(update={"native_classical_ms": 5, "native_classical_name": "Native comparator"})
    cpu = estimate_classical(supplied, "CPU")
    gpu = estimate_classical(supplied, "GPU")
    assert cpu["circuit_emulation"]["kernel_ms"] == pytest.approx(27 * 8 * 2 / 1e6)
    assert gpu["circuit_emulation"]["kernel_ms"] == pytest.approx(0.30 + 27 * 8 * 0.5 / 1e6)
    assert gpu["circuit_emulation"]["total_ms"] == pytest.approx(6 + 0.30 + 27 * 8 * 0.5 / 1e6)
    assert cpu["native_algorithm"]["total_ms"] == 11
    assert gpu["native_algorithm"]["total_ms"] == 7.55


@pytest.mark.parametrize("shots,launch", [(0, 0), (-1, 0), (True, 0), (1.5, 0), (1, -1), (1, math.inf), (1, math.nan)])
def test_invalid_execution_controls_are_rejected(spec, profile, shots, launch):
    with pytest.raises(ValueError):
        estimate_qpu(spec, profile, shots, launch)


@pytest.mark.parametrize("field,value", [("n_qubits", 0), ("depth", -1), ("n_1q", True),
                                         ("n_2q", 1.5), ("stage1_ms", math.nan), ("stage3_ms", -1)])
def test_circuit_models_reject_invalid_resources(spec, field, value):
    with pytest.raises(ValidationError):
        CircuitSpec.model_validate({**spec.model_dump(), field: value})


@pytest.mark.parametrize("field,value", [("t1_us", 0), ("t_2q_ns", -1), ("err_1q", -0.1),
                                         ("err_2q", 1.01), ("topology_factor", 0), ("t_meas_ns", math.inf)])
def test_profiles_reject_invalid_physics(profile, field, value):
    with pytest.raises(ValidationError):
        QPUProfile.model_validate({**profile.model_dump(), field: value})


def test_profiles_record_per_value_provenance_and_capacity_override_does_not_mutate():
    for profile in HARDWARE_PROFILES.values():
        assert profile.provenance["retrieval_date"] == "2026-11-01"
        for field in ("t1_us", "t2_us", "t_1q_ns", "t_2q_ns", "t_meas_ns", "t_reset_ns", "err_1q", "err_2q", "err_meas"):
            assert field in profile.provenance["value_types"]
    vendor = HARDWARE_PROFILES["google_weber_grid"]
    exploratory = execution_profile(vendor, 1024)
    assert vendor.n_qubits_max == 53
    assert exploratory.n_qubits_max == 1024


def test_invalid_classical_node_is_rejected(spec):
    with pytest.raises(ValueError):
        estimate_classical(spec, "QPU")

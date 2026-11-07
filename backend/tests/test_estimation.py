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


def test_native_conversion_doubles_routed_depth_and_two_qubit_count(spec, profile):
    routed = profile.model_copy(update={"topology_factor": 1.5})
    one = estimate_qpu(spec, routed, 100, 0.5)
    two = estimate_qpu(spec, routed.model_copy(update={"native_2q_per_cx": 2.0}), 100, 0.5)
    assert routed.native_2q_per_cx == 1.0
    assert two["circuit_depth"] == 2 * one["circuit_depth"] == 30
    assert two["n_2q"] == 2 * one["n_2q"] == 18
    assert two["gate_execution_ms"] == 2 * one["gate_execution_ms"]
    assert two["measurement_reset_ms"] == one["measurement_reset_ms"]
    assert two["launch_overhead_ms"] == one["launch_overhead_ms"]
    assert two["coherence_survival"] == pytest.approx(0.99**12 * 0.98**18 * 0.97**3 * math.exp(-3 * 3 / 200))
    assert spec.depth == 10 and spec.n_2q == 6


def test_routing_and_native_conversion_round_up_only_after_multiplication(spec, profile):
    native = profile.model_copy(update={"topology_factor": 1.25, "native_2q_per_cx": 2.0})
    actual = estimate_qpu(spec, native, 1, 0)
    assert actual["circuit_depth"] == 25
    assert actual["n_2q"] == 15  # ceil(6 * 1.25 * 2), not ceil(6 * 1.25) * 2.


def test_weber_time_and_error_describe_the_same_sqrt_iswap_native_gate():
    weber = HARDWARE_PROFILES["google_weber_grid"]
    assert (weber.t_2q_ns, weber.err_2q) == (32, 0.009)
    assert weber.native_2q_per_cx == 2.0
    statistics = weber.provenance["statistics"]
    for field in ("t_2q_ns", "err_2q"):
        assert statistics[field]["gate"] == "sqrt(iSWAP)"
        assert statistics[field]["source_url"] == "https://quantumai.google/hardware/datasheet/weber.pdf"
    assert "typical (median) isolated XEB" in statistics["err_2q"]["statistic_type"]
    assert weber.provenance["value_types"]["err_2q"] == "vendor_or_literature_approximation"
    assert weber.provenance["value_types"]["native_2q_per_cx"] == "model_assumption"
    assert "gate-decomposition reference" in weber.provenance["notes"]
    assert statistics["repetition_rate_hz"]["range"] == [1000, 5000]
    assert statistics["repetition_rate_hz"]["statistic_type"] == "typical repetition-rate range"
    assert weber.t_reset_ns == 200_000
    assert all(profile.native_2q_per_cx == 1.0 for key, profile in HARDWARE_PROFILES.items()
               if key != "google_weber_grid")


def test_capacity_is_inclusive_and_cannot_charge_an_infeasible_execution(spec, profile):
    assert estimate_qpu(spec, profile, 100, 0.5)["execution_feasible"]
    too_small = profile.model_copy(update={"n_qubits_max": 2})
    blocked = estimate_qpu(spec, too_small, 100, 0.5)
    assert not blocked["execution_feasible"]
    for key in ("latency_ms", "gate_execution_ms", "measurement_reset_ms", "launch_overhead_ms", "coherence_survival"):
        assert blocked[key] == 0


def test_unit_conversions_and_noise_free_reference(spec):
    assert HARDWARE_PROFILES["ibm_heron_nisq"].t1_us == 200
    assert HARDWARE_PROFILES["google_weber_grid"].t_2q_ns == 32
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


@pytest.mark.parametrize("shots", [True, False, 1.0, 1.5, "512", None, math.nan, math.inf, -math.inf, -1, 0])
def test_qpu_rejects_every_invalid_shot_type(spec, profile, shots):
    with pytest.raises(ValueError, match="shots"):
        estimate_qpu(spec, profile, shots, 0)


@pytest.mark.parametrize("launch", [True, False, "0.3", None, math.nan, math.inf, -math.inf, -1])
def test_qpu_rejects_invalid_launch_values(spec, profile, launch):
    with pytest.raises(ValueError, match="launch_overhead_ms"):
        estimate_qpu(spec, profile, 1, launch)


@pytest.mark.parametrize("estimator", ["QPU", "CPU", "GPU"])
@pytest.mark.parametrize("field", ["n_qubits", "depth", "n_1q", "n_2q", "n_meas",
                                   "stage1_ms", "stage3_ms", "native_classical_ms"])
@pytest.mark.parametrize("value", [True, False, math.nan, math.inf, -math.inf, -1])
def test_estimators_reject_invalid_resources_even_in_unvalidated_model_copies(spec, profile, estimator, field, value):
    invalid = spec.model_copy(update={field: value})
    with pytest.raises(ValidationError):
        if estimator == "QPU":
            estimate_qpu(invalid, profile, 1, 0)
        else:
            estimate_classical(invalid, estimator)


@pytest.mark.parametrize("field", ["n_qubits", "depth", "n_1q", "n_2q", "n_meas"])
@pytest.mark.parametrize("estimator", ["QPU", "CPU", "GPU"])
def test_estimators_reject_noninteger_resource_counts(spec, profile, field, estimator):
    invalid = spec.model_copy(update={field: 1.5})
    with pytest.raises(ValidationError):
        if estimator == "QPU":
            estimate_qpu(invalid, profile, 1, 0)
        else:
            estimate_classical(invalid, estimator)


@pytest.mark.parametrize("field", ["n_qubits_max", "t1_us", "t2_us", "t_1q_ns", "t_2q_ns",
                                   "t_meas_ns", "t_reset_ns", "err_1q", "err_2q", "err_meas",
                                   "topology_factor", "native_2q_per_cx", "repetition_rate_hz"])
@pytest.mark.parametrize("value", [True, False, math.nan, math.inf, -math.inf, -1])
def test_qpu_rejects_invalid_physics_even_in_unvalidated_profile_copies(spec, profile, field, value):
    invalid = profile.model_copy(update={field: value})
    with pytest.raises(ValidationError):
        estimate_qpu(spec, invalid, 1, 0)


@pytest.mark.parametrize("node", [True, False, math.nan, math.inf, -math.inf, -1, None, [], {}])
def test_classical_rejects_invalid_node_values(spec, node):
    with pytest.raises(ValueError, match="node_type"):
        estimate_classical(spec, node)


@pytest.mark.parametrize("shots", [1, 1.5, True, math.nan, math.inf, -1])
def test_classical_has_no_shot_parameter(spec, shots):
    # Emulate a distribution once; do not add a fake shot-batch API to this estimator.
    with pytest.raises(TypeError, match="shots"):
        estimate_classical(spec, "CPU", shots=shots)


@pytest.mark.parametrize("field,value", [("n_qubits", 0), ("depth", -1), ("n_1q", True),
                                         ("n_2q", 1.5), ("stage1_ms", math.nan), ("stage3_ms", -1)])
def test_circuit_models_reject_invalid_resources(spec, field, value):
    with pytest.raises(ValidationError):
        CircuitSpec.model_validate({**spec.model_dump(), field: value})


@pytest.mark.parametrize("field,value", [("t1_us", 0), ("t_2q_ns", -1), ("err_1q", -0.1),
                                         ("err_2q", 1.01), ("topology_factor", 0), ("t_meas_ns", math.inf),
                                         ("native_2q_per_cx", 0.9), ("native_2q_per_cx", math.inf)])
def test_profiles_reject_invalid_physics(profile, field, value):
    with pytest.raises(ValidationError):
        QPUProfile.model_validate({**profile.model_dump(), field: value})


def test_profiles_record_per_value_provenance_and_capacity_override_does_not_mutate():
    for profile in HARDWARE_PROFILES.values():
        assert profile.provenance["retrieval_date"] == ("2026-11-07" if profile.id == "ibm_nighthawk_r2" else "2026-11-02" if profile.id in {"google_weber_grid", "ftqc_surface_code"} else "2026-11-01")
        for field in ("t1_us", "t2_us", "t_1q_ns", "t_2q_ns", "t_meas_ns", "t_reset_ns", "err_1q", "err_2q", "err_meas", "native_2q_per_cx"):
            assert field in profile.provenance["value_types"]
    vendor = HARDWARE_PROFILES["google_weber_grid"]
    exploratory = execution_profile(vendor, 1024)
    assert vendor.n_qubits_max == 53
    assert exploratory.n_qubits_max == 1024


def test_invalid_classical_node_is_rejected(spec):
    with pytest.raises(ValueError):
        estimate_classical(spec, "QPU")

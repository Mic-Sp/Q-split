"""Nighthawk units, conservative peak-shot pacing and unchanged per-shot physics."""
import math
from typing import get_args

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from backend.estimation import estimate_qpu
from backend.main import HardwareProfile, SimulationRequest, app
from backend.models import CircuitSpec, QPUProfile
from backend.profiles import HARDWARE_PROFILES, TOPOLOGIES, execution_profile

PROFILE_ID = "ibm_nighthawk_r2"


def circuit(depth=10, qubits=3):
    return CircuitSpec(n_qubits=qubits, depth=depth, n_1q=12, n_2q=6, n_meas=3,
                       stage1_ms=0, stage3_ms=0)


def test_registered_profile_schema_units_and_separate_metadata():
    profile = HARDWARE_PROFILES[PROFILE_ID]
    assert set(get_args(HardwareProfile)) == set(HARDWARE_PROFILES) == set(TOPOLOGIES)
    assert SimulationRequest(hardware_profile=PROFILE_ID).hardware_profile == PROFILE_ID
    assert QPUProfile.model_validate_json(profile.model_dump_json()) == profile
    assert profile.name == "IBM Quantum System Two (Nighthawk r2)"
    assert (profile.n_qubits_max, profile.t1_us, profile.t2_us) == (120, 200, 160)
    assert (profile.t_1q_ns, profile.t_2q_ns, profile.t_meas_ns, profile.t_reset_ns) == (32, 40, 1500, 1000)
    assert (profile.err_1q, profile.err_2q, profile.err_meas) == (0.00025, 0.0037, 0.0075)
    assert profile.repetition_rate_hz == 100_000  # Hz, not kHz.
    assert profile.topology_factor == 1.2 and profile.native_2q_per_cx == 1
    metadata = profile.provenance["architecture"]
    assert metadata["total_physical_elements"] == sum(metadata[key] for key in
        ("programmable_qubits", "tunable_couplers", "dissipative_reset_gadgets")) == 458
    assert metadata["connectivity_degree"] == 4
    assert metadata["reset_only_effective_t1_ns"] == 25
    assert profile.provenance["statistics"]["validated_gate_count"]["at_least"] == 7500
    assert profile.provenance["value_types"]["err_2q"] == "user_supplied_specification"
    assert profile.provenance["value_types"]["t_meas_ns"] == "model_assumption"


def test_short_circuit_hits_100_khz_without_double_counting_one_us_reset():
    profile = HARDWARE_PROFILES[PROFILE_ID]
    result = estimate_qpu(circuit(), profile, 512, 0.3)
    assert result["circuit_depth"] == 12
    assert result["n_2q"] == 8
    assert result["t_circuit_us"] == pytest.approx(0.48)
    assert result["latency_ms"] == pytest.approx(0.3 + 512 / 100_000 * 1000)
    assert result["gate_execution_ms"] == pytest.approx(512 * 480 / 1e6)
    assert result["repetition_delay_ms"] == pytest.approx(512 * (10_000 - 480 - 1500 - 1000) / 1e6)
    assert result["measurement_reset_ms"] - result["repetition_delay_ms"] == pytest.approx(512 * 2500 / 1e6)
    assert result["latency_ms"] == pytest.approx(sum(result[key] for key in
        ("launch_overhead_ms", "gate_execution_ms", "measurement_reset_ms")))
    unpaced = estimate_qpu(circuit(), profile.model_copy(update={"repetition_rate_hz": None}), 512, 0.3)
    assert unpaced["latency_ms"] == pytest.approx(0.3 + 512 * 2980 / 1e6)
    assert unpaced["repetition_delay_ms"] == 0
    assert result["log_survival_terms"] == unpaced["log_survival_terms"]


def test_long_circuits_are_gate_limited_and_reset_is_charged_once():
    profile = HARDWARE_PROFILES[PROFILE_ID]
    result = estimate_qpu(circuit(depth=1000), profile, 1024, 0.3)
    assert result["t_circuit_us"] == 48
    assert result["repetition_delay_ms"] == 0
    assert result["latency_ms"] == pytest.approx(0.3 + 1024 * (48_000 + 1500 + 1000) / 1e6)
    slow_reset = estimate_qpu(circuit(depth=1000), profile.model_copy(update={"t_reset_ns": 200_000}), 1024, 0.3)
    assert slow_reset["latency_ms"] - result["latency_ms"] == pytest.approx(1024 * 199_000 / 1e6)
    assert slow_reset["coherence_log_survival"] == result["coherence_log_survival"]


def test_error_terms_t1_t2_and_shots_do_not_confuse_reset_with_coherence():
    profile = HARDWARE_PROFILES[PROFILE_ID]
    result = estimate_qpu(circuit(), profile, 1, 0)
    gates = 12 * math.log1p(-0.00025) + 8 * math.log1p(-0.0037) + 3 * math.log1p(-0.0075)
    expected_log = gates - 3 * 0.48 / 200
    assert result["coherence_log_survival"] == pytest.approx(expected_log)
    assert result["coherence_survival"] == pytest.approx(math.exp(expected_log))
    assert result["coherence_survival_worst"] == pytest.approx(math.exp(gates - 3 * 0.48 / 160))
    many = estimate_qpu(circuit(), profile, 1024, 0)
    assert many["coherence_survival"] == result["coherence_survival"]
    assert many["latency_ms"] == pytest.approx(1024 * result["latency_ms"])
    heron = estimate_qpu(circuit(), HARDWARE_PROFILES["ibm_heron_nisq"], 1024, 0)
    assert many["latency_ms"] < heron["latency_ms"]
    assert many["coherence_survival"] > heron["coherence_survival"]
    assert heron["latency_ms"] / many["latency_ms"] != pytest.approx(25)


def test_capacity_and_benchmark_gate_count_do_not_invent_a_depth_cutoff():
    profile = HARDWARE_PROFILES[PROFILE_ID]
    assert estimate_qpu(circuit(qubits=120), profile, 1, 0)["execution_feasible"]
    blocked = estimate_qpu(circuit(qubits=121), profile, 1, 0)
    assert not blocked["execution_feasible"]
    assert blocked["latency_ms"] == blocked["repetition_delay_ms"] == 0
    assert estimate_qpu(circuit(depth=8000), profile, 1, 0)["execution_feasible"]
    assert execution_profile(profile, 133).n_qubits_max == 133
    assert profile.n_qubits_max == 120
    assert all(p.repetition_rate_hz is None for key, p in HARDWARE_PROFILES.items() if key != PROFILE_ID)


@pytest.mark.parametrize("rate", [0, -1, True, False, "100000", math.nan, math.inf, -math.inf])
def test_invalid_rate_rejected_even_in_unvalidated_profile_copy(rate):
    with pytest.raises(ValidationError):
        estimate_qpu(circuit(), HARDWARE_PROFILES[PROFILE_ID].model_copy(update={"repetition_rate_hz": rate}), 1, 0)


@pytest.mark.parametrize("workload,scale", [("shors_crypto", 21), ("quantum_mips", 1024)])
def test_http_profile_consumed_by_both_workloads_and_preserves_reference(workload, scale, monkeypatch):
    monkeypatch.delenv("ENGINE_ENV", raising=False)
    monkeypatch.delenv("ENGINE_SECRET", raising=False)
    with TestClient(app) as client:
        for capacity in (120, 133):
            response = client.post("/api/simulate", json={"workload_id": workload, "scale_param": scale,
                "hardware_profile": PROFILE_ID, "available_qubits": capacity})
            assert response.status_code == 200
            stage = response.json()["stages"]["stage_2_quantum_kernel"]
            m = stage["metrics"]
            assert m["qpu_profile"]["n_qubits_max"] == m["reference_qubits"] == 120
            assert m["qpu_profile"]["repetition_rate_hz"] == 100_000
            assert m["capacity_override"] is (capacity > 120)
            assert m["connectivity_topology"] == "4-degree Square Grid"
            assert m["execution_feasible"]
            assert stage["latency_ms"] == pytest.approx(m["gate_execution_ms"] + m["measurement_reset_ms"] + m["launch_overhead_ms"])

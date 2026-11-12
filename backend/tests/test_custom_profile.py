"""Custom hardware shares validated physics, without mutating vendor profiles."""

import math
from copy import deepcopy

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from backend.main import SimulationRequest, app, simulate_workload
from backend.models import CustomQPUProfileSpec, InterconnectConfig, CircuitSpec
from backend.profiles import HARDWARE_PROFILES, resolve_profile
from backend.estimation import estimate_qpu


def custom(base="ibm_heron_nisq", **changes):
    fields = HARDWARE_PROFILES[base].model_dump(exclude={"id", "provenance"})
    return {**fields, "name": "Research QPU", "base_profile_id": base, **changes}


def spec(width=13, options=None):
    return CircuitSpec(n_qubits=width, depth=20, n_1q=40, n_2q=20, n_meas=3,
                       stage1_ms=0, stage3_ms=0, interconnect=options)


@pytest.mark.parametrize("base", HARDWARE_PROFILES)
def test_clones_keep_physics_and_user_defined_provenance(base):
    original = HARDWARE_PROFILES[base]
    resolved = resolve_profile("custom", CustomQPUProfileSpec(**custom(base)))
    expected = estimate_qpu(spec(), original, 512, 0.3)
    actual = estimate_qpu(spec(), resolved, 512, 0.3)
    assert resolved.id == "custom" and resolved.name == "Research QPU"
    assert resolved.provenance["base_profile_id"] == base
    assert set(resolved.provenance["value_types"].values()) == {"user_defined_custom"}
    assert actual["modules_used"] == 1 and actual["transfers_per_shot"] == 0
    for key in ("latency_ms", "coherence_log_survival", "coherence_survival_worst", "t_circuit_us"):
        assert actual[key] == expected[key]
    assert actual["log_survival_terms"]["interconnect"] == 0


@pytest.mark.parametrize("field,value", [
    ("name", ""), ("name", "   "), ("name", "x" * 121), ("name", "bad\nlabel"),
    ("n_qubits_max", 0), ("n_qubits_max", True), ("topology_factor", 0.99),
    ("native_2q_per_cx", 0.9), ("t1_us", 0), ("t2_us", -1),
    ("t_2q_ns", 0), ("t_1q_ns", -1), ("t_reset_ns", math.inf),
    ("t_meas_ns", math.nan), ("repetition_rate_hz", 0), ("err_1q", True),
    ("err_2q", 1.01), ("err_meas", -0.1), ("module_count", 3),
    ("base_profile_id", "custom"), ("err_1q", "1e-4"),
])
def test_invalid_custom_values_rejected(field, value):
    with pytest.raises(ValidationError):
        CustomQPUProfileSpec(**custom(**{field: value}))


def test_invalid_cross_field_geometry_and_links_rejected():
    for changes in [{"l_couplers_active": 1}, {"module_count": 2},
                    {"n_qubits_max": 41, "qubits_per_module": 20, "module_count": 2,
                     "l_couplers_active": 10, "l_couplers_installed": 10, "state_transfer_fidelity": 0.99, "transfer_duration_ns": 80}]:
        with pytest.raises(ValidationError):
            CustomQPUProfileSpec(**custom(**changes))
    with pytest.raises(ValidationError):
        CustomQPUProfileSpec(**custom(id="spoofed", provenance={}))


def test_custom_multi_module_uses_custom_boundary_channels_fidelity_and_duration():
    profile = resolve_profile("custom", CustomQPUProfileSpec(**custom("ibm_nighthawk_r3_dual",
        n_qubits_max=40, qubits_per_module=20, l_couplers_installed=3, l_couplers_active=3,
        state_transfer_fidelity=0.98, state_transfer_target_fidelity=0.9999, transfer_duration_ns=80)))
    contained = estimate_qpu(spec(20), profile, 1, 0)
    assert contained["modules_used"] == 1 and contained["transfers_per_shot"] == 0
    linked = estimate_qpu(spec(21), profile, 1, 0)
    assert linked["modules_used"] == 2
    assert linked["scheduled_transfer_rounds"] == math.ceil(linked["transfers_per_shot"] / 3)
    assert linked["link_time_ns"] == linked["scheduled_transfer_rounds"] * 80
    assert linked["link_log_survival"] == linked["transfers_per_shot"] * math.log(0.98)
    target = estimate_qpu(spec(21, InterconnectConfig(fidelity_scenario="target_2027")), profile, 1, 0)
    assert target["coherence_log_survival"] > linked["coherence_log_survival"]
    forced = estimate_qpu(spec(13, InterconnectConfig(placement="dual")), profile, 1, 0)
    assert forced["modules_used"] == 2 and forced["transfers_per_shot"] > 0


def test_ftqc_custom_turns_off_idle_decay_but_keeps_operation_and_link_errors():
    profile = resolve_profile("custom", CustomQPUProfileSpec(**custom("ibm_nighthawk_r3_dual", t1_us=None, t2_us=None)))
    result = estimate_qpu(spec(600), profile, 1, 0)
    terms = result["log_survival_terms"]
    assert terms["idle_t1"] == terms["idle_t2"] == 0
    assert result["coherence_log_survival"] == pytest.approx(sum(terms[key] for key in ("one_qubit", "two_qubit", "measurement", "interconnect")))
    assert result["coherence_survival_worst"] == result["coherence_survival_best"]


def test_request_contract_and_two_workloads(monkeypatch):
    monkeypatch.delenv("ENGINE_ENV", raising=False)
    monkeypatch.delenv("ENGINE_SECRET", raising=False)
    with TestClient(app) as client:
        for workload, scale in [("shors_crypto", 21), ("quantum_mips", 1024)]:
            request = {"hardware_profile": "custom", "custom_profile": custom(), "workload_id": workload,
                       "scale_param": scale, "available_qubits": 133}
            response = client.post("/api/simulate", json=request)
            assert response.status_code == 200, response.text
            metrics = response.json()["stages"]["stage_2_quantum_kernel"]["metrics"]
            assert metrics["hardware_architecture"] == metrics["qpu_profile"]["id"] == "custom"
            assert metrics["connectivity_topology"] == "User-defined routing"
            assert metrics["qpu_profile"]["name"] == "Research QPU"
            assert client.post("/api/simulate", json={**request, "custom_profile": None}).status_code == 422
            assert client.post("/api/simulate", json={**request, "hardware_profile": "ibm_heron_nisq"}).status_code == 422
            assert client.post("/api/simulate", json={**request, "interconnect": {"placement": "dual"}}).status_code == 422
            huge = client.post("/api/simulate", json={**request, "custom_profile": custom(t_2q_ns=1e308)})
            assert huge.status_code == 422 and "numerical range" in huge.json()["detail"]


def test_request_local_profiles_are_isolated_and_all_routes_use_resolved_physics():
    before = deepcopy(HARDWARE_PROFILES)
    first = simulate_workload(SimulationRequest(hardware_profile="custom", custom_profile=CustomQPUProfileSpec(**custom(err_2q=0.0)), scale_param=21))
    second = simulate_workload(SimulationRequest(hardware_profile="custom", custom_profile=CustomQPUProfileSpec(**custom(err_2q=0.5)), scale_param=21))
    assert first.stages["stage_2_quantum_kernel"].metrics["coherence_log_survival"] > second.stages["stage_2_quantum_kernel"].metrics["coherence_log_survival"]
    assert HARDWARE_PROFILES == before and "custom" not in HARDWARE_PROFILES

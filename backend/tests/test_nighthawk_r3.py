"""Linked-system scenarios add independent transfer loss and coherent stalls once."""

import math

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from backend.estimation import estimate_qpu
from backend.main import app, run_quantum_mips_pipeline, run_shors_pipeline, StageTelemetry, RoutingConfig
from backend.models import CircuitSpec, InterconnectConfig, QPUProfile
from backend.profiles import HARDWARE_PROFILES, execution_profile
from backend.workloads import partition_transfer_count


SINGLE = HARDWARE_PROFILES["ibm_nighthawk_r3"]
DUAL = HARDWARE_PROFILES["ibm_nighthawk_r3_dual"]


def circuit(width=521, **updates):
    return CircuitSpec(n_qubits=width, depth=10, n_1q=12, n_2q=20, n_meas=3,
                       stage1_ms=0, stage3_ms=0, **updates)


def test_registry_names_counts_and_inherited_assumptions():
    r2 = HARDWARE_PROFILES["ibm_nighthawk_r2"]
    for profile, capacity, physical, modules, channels in [(SINGLE, 520, 2034, 1, 0), (DUAL, 1040, 4068, 2, 10)]:
        assert (profile.n_qubits_max, profile.n_physical_qubits, profile.module_count, profile.l_couplers_active) == (capacity, physical, modules, channels)
        assert (profile.qubits_per_module, profile.max_operations, profile.l_couplers_installed) == (520, 10000, 10)
        assert profile.repetition_rate_hz == 100000
        inherited = profile.provenance["statistics"]["inherited_r2_parameters"]
        for field, value in inherited.items():
            assert getattr(profile, field) == getattr(r2, field) == value
            assert profile.provenance["value_types"][field] == "model_assumption_inherited_from_r2"
        assert "modular cryogenic mainframe" in profile.provenance["architecture"]["deployment_notes"]
        assert "November 11, 2026" in profile.provenance["architecture"]["deployment_notes"]
        assert QPUProfile.model_validate_json(profile.model_dump_json()) == profile
    assert SINGLE.name == "IBM Quantum System Two (Nighthawk r3 — 520Q)"
    assert DUAL.name == "IBM Quantum System Two (2x Nighthawk r3 Linked — 1,040Q)"
    stats = DUAL.provenance["statistics"]["state_transfer_fidelity"]
    assert (stats["peak"], stats["average"], stats["demonstrated_channels"]) == (0.993, 0.990, 4)


@pytest.mark.parametrize("width", [1, 28, 96, 519, 520])
def test_contained_execution_matches_single_even_with_1040_available(width):
    spec = circuit(width)
    single = estimate_qpu(spec, SINGLE, 512, 0.3)
    dual = estimate_qpu(spec, execution_profile(DUAL, 1040), 512, 0.3)
    for key in ("latency_ms", "coherence_log_survival", "coherence_survival_worst", "t_circuit_us"):
        assert single[key] == dual[key]
    assert (dual["modules_used"], dual["transfers_per_shot"], dual["scheduled_transfer_rounds"], dual["link_time_ns"], dual["link_log_survival"]) == (1, 0, 0, 0, 0)


@pytest.mark.parametrize("width", [521, 1027, 1040])
def test_link_fidelity_exposure_timing_and_parallel_rounds(width):
    spec = circuit(width)
    out = estimate_qpu(spec, DUAL, 3, 0.3)
    modules, transfers = partition_transfer_count(width, spec.n_2q, 520)
    assert modules == out["modules_used"] == 2
    assert transfers == out["transfers_per_shot"] > 0
    assert out["scheduled_transfer_rounds"] == math.ceil(transfers / 10)
    assert out["link_time_ns"] == math.ceil(transfers / 10) * 100
    assert out["t_circuit_us"] == (12 * 40 + out["link_time_ns"]) / 1000
    terms = out["log_survival_terms"]
    assert terms["interconnect"] == out["link_log_survival"] == transfers * math.log(0.993)
    assert terms["idle_t1"] == -width * out["t_circuit_us"] / 200
    assert terms["idle_t2"] == -width * out["t_circuit_us"] / 160
    gates = terms["one_qubit"] + terms["two_qubit"] + terms["measurement"] + terms["interconnect"]
    assert out["coherence_log_survival"] == gates + terms["idle_t1"]
    assert out["coherence_survival_worst"] == math.exp(gates + min(terms["idle_t1"], terms["idle_t2"]))
    assert out["latency_ms"] == pytest.approx(0.3 + 3 * max(out["t_circuit_us"] * 1000 + 2500, 10000) / 1e6)
    assert out["latency_ms"] == pytest.approx(sum(out[k] for k in ("gate_execution_ms", "measurement_reset_ms", "launch_overhead_ms")))
    assert out["link_execution_ms"] == 3 * out["link_time_ns"] / 1e6


def test_explicit_small_circuit_target_and_duration_are_independent():
    baseline = estimate_qpu(circuit(28), DUAL, 1, 0)
    measured_spec = circuit(28, interconnect=InterconnectConfig(placement="dual"))
    measured = estimate_qpu(measured_spec, DUAL, 1, 0)
    target = estimate_qpu(circuit(28, interconnect=InterconnectConfig(placement="dual", fidelity_scenario="target_2027")), DUAL, 1, 0)
    slower = estimate_qpu(circuit(28, interconnect=InterconnectConfig(placement="dual", transfer_duration_ns=10000)), DUAL, 1, 0)
    assert baseline["modules_used"] == 1 and measured["modules_used"] == 2
    assert measured["transfers_per_shot"] == target["transfers_per_shot"] == slower["transfers_per_shot"]
    assert target["coherence_log_survival"] > measured["coherence_log_survival"] > slower["coherence_log_survival"]
    assert target["latency_ms"] == measured["latency_ms"] < slower["latency_ms"]
    assert slower["log_survival_terms"]["interconnect"] == measured["log_survival_terms"]["interconnect"]
    assert target["log_survival_terms"]["idle_t1"] == measured["log_survival_terms"]["idle_t1"]


def test_width_capacity_and_advisory_operation_target():
    assert estimate_qpu(circuit(520), SINGLE, 1, 0)["execution_feasible"]
    assert not estimate_qpu(circuit(521), SINGLE, 1, 0)["execution_feasible"]
    assert estimate_qpu(circuit(1040), DUAL, 1, 0)["execution_feasible"]
    blocked = estimate_qpu(circuit(1041), DUAL, 1, 0)
    assert not blocked["execution_feasible"] and blocked["log_survival_terms"] is None
    assert blocked["latency_ms"] == blocked["link_execution_ms"] == 0
    assert not estimate_qpu(circuit(521), execution_profile(DUAL, 520), 1, 0)["execution_feasible"]
    assert estimate_qpu(circuit(28).model_copy(update={"n_2q": 10001}), SINGLE, 1, 0)["execution_feasible"]


def test_workload_allocations_not_available_capacity_trigger_links():
    assert run_quantum_mips_pipeline(1048576, DUAL.id, available_qubits=1040).stages["stage_2_quantum_kernel"].metrics["modules_used"] == 1
    rsa = run_shors_pipeline(512, DUAL.id, available_qubits=1040).stages["stage_2_quantum_kernel"].metrics
    assert rsa["qubits_allocated"] == 1027 and rsa["modules_used"] == 2
    assert rsa["coherence_survival"] == 0 and math.isfinite(rsa["coherence_log_survival"])
    assert not run_shors_pipeline(512, SINGLE.id, available_qubits=520).stages["stage_2_quantum_kernel"].metrics["execution_feasible"]
    starved = run_shors_pipeline(512, DUAL.id, RoutingConfig(stage_1_node="QPU"), available_qubits=1040).stages["stage_2_quantum_kernel"]
    assert not starved.metrics["execution_feasible"] and starved.latency_ms == 0
    assert starved.metrics["link_execution_ms"] == starved.metrics["transfers_per_shot"] == starved.metrics["link_log_survival"] == 0
    assert "modules_used" not in starved.metrics


def test_api_options_and_historical_logs(monkeypatch):
    monkeypatch.delenv("ENGINE_ENV", raising=False)
    monkeypatch.delenv("ENGINE_SECRET", raising=False)
    payload = {"workload_id": "shors_crypto", "scale_param": 21, "hardware_profile": DUAL.id, "available_qubits": 1040,
               "interconnect": {"placement": "dual", "fidelity_scenario": "target_2027", "transfer_duration_ns": 80.0}}
    with TestClient(app) as client:
        response = client.post("/api/simulate", json=payload)
        assert response.status_code == 200
        metrics = response.json()["stages"]["stage_2_quantum_kernel"]["metrics"]
        assert metrics["modules_used"] == 2 and metrics["selected_transfer_fidelity"] == 0.999
        assert metrics["transfer_duration_ns"] == 80
        assert metrics["circuit_spec"]["interconnect"] == payload["interconnect"]
        assert client.post("/api/simulate", json={**payload, "hardware_profile": SINGLE.id}).status_code == 422
        for value in (0, -1, True, "100", float("inf")):
            if not isinstance(value, float):
                assert client.post("/api/simulate", json={**payload, "interconnect": {"transfer_duration_ns": value}}).status_code == 422
    legacy = {key: 0.0 for key in ("one_qubit", "two_qubit", "measurement", "idle_t1", "idle_t2")}
    assert StageTelemetry(name="Legacy", node="QPU", latency_ms=1, status="OPTIMAL", output_summary="", metrics={"log_survival_terms": legacy}).metrics["log_survival_terms"] == legacy


@pytest.mark.parametrize("config", [{"transfer_duration_ns": 0}, {"transfer_duration_ns": float("nan")}, {"placement": "unknown"}, {"fidelity_scenario": "peak"}])
def test_invalid_options_revalidated(config):
    with pytest.raises(ValidationError):
        estimate_qpu(circuit(interconnect=InterconnectConfig.model_construct(**config)), DUAL, 1, 0)

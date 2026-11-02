"""Logical error suppression and lattice-surgery latency remain separate costs."""

import math

import pytest
from fastapi.testclient import TestClient

from backend.main import app
from backend.profiles import GIDNEY_2025_RSA, GOOGLE_WILLOW_QEC, HARDWARE_PROFILES


def test_ftqc_provenance_distinguishes_cycle_source_from_logical_assumptions():
    profile = HARDWARE_PROFILES["ftqc_surface_code"]
    provenance = profile.provenance
    assert profile.n_qubits_max == 1024
    assert profile.t1_us is None and profile.t2_us is None
    assert profile.t_2q_ns == profile.t_meas_ns == 27 * profile.t_1q_ns
    assert profile.t_reset_ns == profile.t_1q_ns == 1000
    assert (profile.err_1q, profile.err_2q, profile.err_meas) == (1e-10, 1e-9, 1e-9)
    assert profile.topology_factor == profile.native_2q_per_cx == 1
    assert provenance["sources"] == [GIDNEY_2025_RSA, GOOGLE_WILLOW_QEC]
    assert provenance["retrieval_date"] == "2026-11-02"
    for field, kind in provenance["value_types"].items():
        assert kind == ("vendor_or_literature_approximation" if field == "t_1q_ns" else "model_assumption")
        assert provenance["statistics"][field]["source_url"] in provenance["sources"]
        assert provenance["statistics"][field]["statistic_type"]
    assert "double-counting" in provenance["notes"]
    assert "1,000 physical superconducting" in provenance["notes"]
    assert "1.1 us" in provenance["notes"]


@pytest.mark.parametrize("workload,scale", [
    *[("shors_crypto", scale) for scale in (15, 21, 35)],
    *[("quantum_mips", scale) for scale in (64, 1024, 32768, 131072, 1048576)],
])
def test_ftqc_http_survival_and_logical_gate_latency_tradeoff(workload, scale, monkeypatch):
    monkeypatch.delenv("ENGINE_ENV", raising=False)
    monkeypatch.delenv("ENGINE_SECRET", raising=False)
    request = {"workload_id": workload, "scale_param": scale, "available_qubits": 1024}
    with TestClient(app) as client:
        ftqc = client.post("/api/simulate", json={**request, "hardware_profile": "ftqc_surface_code"})
        nisq = client.post("/api/simulate", json={**request, "hardware_profile": "ibm_heron_nisq"})
    assert ftqc.status_code == nisq.status_code == 200
    stage = ftqc.json()["stages"]["stage_2_quantum_kernel"]
    physical = nisq.json()["stages"]["stage_2_quantum_kernel"]
    metrics = stage["metrics"]
    assert metrics["coherence_status"] == "NOMINAL"
    assert stage["status"] == "OPTIMAL"
    assert metrics["coherence_survival_pct"] > 99.9
    assert metrics["coherence_survival_pct"] > physical["metrics"]["coherence_survival_pct"]
    assert physical["metrics"]["coherence_status"] == "EXCEEDED"
    assert metrics["log_survival_terms"]["idle_t1"] == metrics["log_survival_terms"]["idle_t2"] == 0
    assert metrics["coherence_survival"] == pytest.approx(math.exp(sum(
        metrics["log_survival_terms"][term] for term in ("one_qubit", "two_qubit", "measurement"))))
    assert metrics["reference_qubits"] == 1024 and not metrics["capacity_override"]
    assert metrics["qpu_profile"]["t1_us"] is None
    assert metrics["circuit_spec"] == physical["metrics"]["circuit_spec"]
    assert metrics["classical_baselines"] == physical["metrics"]["classical_baselines"]
    assert metrics["t_circuit_us"] == metrics["circuit_depth"] * 27
    assert metrics["gate_execution_ms"] == pytest.approx(metrics["shots"] * metrics["t_circuit_us"] / 1000)
    assert stage["latency_ms"] == pytest.approx(metrics["gate_execution_ms"] +
        metrics["measurement_reset_ms"] + metrics["launch_overhead_ms"])
    assert stage["latency_ms"] > physical["latency_ms"]
    assert stage["latency_ms"] > metrics["classical_baselines"]["native_algorithm"]["kernel_ms"]

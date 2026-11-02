"""T1 point compatibility, alternative T2 idle decay, and the public wire schema."""

import json
import math

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from backend.estimation import estimate_qpu
from backend.main import STAGE_KEYS, StageTelemetry, app
from backend.models import CircuitSpec
from backend.profiles import HARDWARE_PROFILES


@pytest.fixture
def spec():
    return CircuitSpec(n_qubits=3, depth=10, n_1q=12, n_2q=6, n_meas=3, stage1_ms=0, stage3_ms=0)


@pytest.mark.parametrize("profile_id", HARDWARE_PROFILES)
def test_point_is_unchanged_and_range_is_ordered_for_every_profile(spec, profile_id):
    profile = HARDWARE_PROFILES[profile_id]
    actual = estimate_qpu(spec, profile, 512, 0.3)
    # Reproduce the previous estimator's T1-only computation independently.
    depth = math.ceil(spec.depth * profile.topology_factor)
    cx = math.ceil(spec.n_2q * profile.topology_factor)
    legacy_log = 0.0
    for count, error in [(spec.n_1q, profile.err_1q), (cx, profile.err_2q), (spec.n_meas, profile.err_meas)]:
        if count:
            legacy_log += count * math.log1p(-error)
    if profile.t1_us is not None:
        legacy_log -= spec.n_qubits * depth * profile.t_2q_ns / 1000 / profile.t1_us
    point = actual["coherence_survival"]
    assert point == math.exp(legacy_log)
    assert actual["coherence_survival_pct"] == 100 * point
    assert 1 >= actual["coherence_survival_best"] >= point >= actual["coherence_survival_worst"] >= 0
    assert actual["coherence_survival_best"] == point


@pytest.mark.parametrize("profile_id", HARDWARE_PROFILES)
def test_log_terms_reconstruct_point_and_pessimistic_scenario(spec, profile_id):
    actual = estimate_qpu(spec, HARDWARE_PROFILES[profile_id], 512, 0.3)
    terms = actual["log_survival_terms"]
    assert set(terms) == {"one_qubit", "two_qubit", "measurement", "idle_t1", "idle_t2"}
    assert all(term <= 0 for term in terms.values())
    gate_log = sum(terms[key] for key in ("one_qubit", "two_qubit", "measurement"))
    # Idle terms are alternatives, so only idle_t1 belongs to the point sum.
    reconstructed_point = math.exp(gate_log + terms["idle_t1"])
    assert abs(reconstructed_point - actual["coherence_survival"]) <= 1e-9
    reconstructed_worst = math.exp(gate_log + min(terms["idle_t1"], terms["idle_t2"]))
    assert abs(reconstructed_worst - actual["coherence_survival_worst"]) <= 1e-9


def test_t2_is_an_alternative_idle_charge_and_uses_existing_microsecond_units(spec):
    profile = HARDWARE_PROFILES["ionq_forte_trapped_ion"]
    actual = estimate_qpu(spec, profile, 512, 0.3)
    terms = actual["log_survival_terms"]
    exposure = spec.n_qubits * actual["t_circuit_us"]
    assert terms["idle_t1"] == -exposure / profile.t1_us
    assert terms["idle_t2"] == -exposure / profile.t2_us
    assert terms["idle_t2"] < terms["idle_t1"]
    assert actual["coherence_survival_worst"] < actual["coherence_survival_best"]
    assert math.exp(sum(terms.values())) < actual["coherence_survival"]


def test_missing_t2_falls_back_to_t1(spec):
    profile = HARDWARE_PROFILES["ibm_heron_nisq"].model_copy(update={"t2_us": None})
    actual = estimate_qpu(spec, profile, 1, 0)
    assert actual["log_survival_terms"]["idle_t1"] == actual["log_survival_terms"]["idle_t2"]
    assert actual["coherence_survival_best"] == actual["coherence_survival"] == actual["coherence_survival_worst"]


def test_longer_t2_does_not_invert_best_and_worst(spec):
    profile = HARDWARE_PROFILES["google_weber_grid"]
    assert profile.t2_us > profile.t1_us
    actual = estimate_qpu(spec, profile, 1, 0)
    assert actual["log_survival_terms"]["idle_t2"] > actual["log_survival_terms"]["idle_t1"]
    assert actual["coherence_survival_worst"] == actual["coherence_survival_best"]


@pytest.mark.parametrize("depth", [0, 10, 100_000_000_000])
def test_ideal_survival_is_exactly_one_for_every_scenario(spec, depth):
    actual = estimate_qpu(spec.model_copy(update={"depth": depth}), HARDWARE_PROFILES["ideal_sim"], 512, 0.3)
    for key in ("coherence_survival", "coherence_survival_best", "coherence_survival_worst"):
        assert actual[key] == 1.0
    assert actual["coherence_survival_pct"] == 100.0
    assert all(value == 0 for value in actual["log_survival_terms"].values())
    assert all(math.copysign(1, value) == 1 for value in actual["log_survival_terms"].values())


def test_infeasible_execution_has_zero_range_and_no_physical_breakdown(spec):
    profile = HARDWARE_PROFILES["ibm_heron_nisq"].model_copy(update={"n_qubits_max": 2})
    actual = estimate_qpu(spec, profile, 512, 0.3)
    assert not actual["execution_feasible"]
    assert actual["coherence_survival_best"] == actual["coherence_survival_worst"] == actual["coherence_survival"] == 0
    assert actual["log_survival_terms"] is None


def test_certain_gate_failure_is_json_safe_and_unused_gates_have_zero_log(spec):
    profile = HARDWARE_PROFILES["ibm_heron_nisq"].model_copy(update={"err_2q": 1})
    actual = estimate_qpu(spec, profile, 1, 0)
    assert actual["coherence_survival_best"] == actual["coherence_survival_worst"] == 0
    assert actual["log_survival_terms"]["two_qubit"] is None  # JSON representation of -infinity.
    json.dumps(actual, allow_nan=False)
    stage = StageTelemetry(name="Kernel", node="QPU", latency_ms=actual["latency_ms"],
                           status="CRITICAL_BOTTLENECK", output_summary="Synthetic certain failure", metrics=actual)
    assert json.loads(stage.model_dump_json())["metrics"]["log_survival_terms"]["two_qubit"] is None
    unused = estimate_qpu(spec.model_copy(update={"n_2q": 0}), profile, 1, 0)
    assert unused["log_survival_terms"]["two_qubit"] == 0


@pytest.mark.parametrize("workload,scale,capacity", [("shors_crypto", 21, 13), ("quantum_mips", 1024, 14)])
@pytest.mark.parametrize("profile_id", HARDWARE_PROFILES)
def test_survival_range_survives_response_validation_over_http(monkeypatch, workload, scale, capacity, profile_id):
    monkeypatch.delenv("ENGINE_SECRET", raising=False)
    with TestClient(app) as client:
        response = client.post("/api/simulate", json={"workload_id": workload, "scale_param": scale,
                                                     "available_qubits": capacity, "hardware_profile": profile_id})
    assert response.status_code == 200
    metrics = response.json()["stages"][STAGE_KEYS[1]]["metrics"]
    assert metrics["coherence_survival_best"] >= metrics["coherence_survival"] >= metrics["coherence_survival_worst"]
    assert metrics["log_survival_terms"] is not None
    assert metrics["hardware_architecture"] == profile_id  # Extra workload metrics remain intact.


def test_openapi_documents_optional_survival_fields_and_legacy_metrics_stay_extensible():
    schema = app.openapi()["components"]["schemas"]
    assert {"coherence_survival_best", "coherence_survival_worst", "log_survival_terms"} <= set(schema["StageMetrics"]["properties"])
    assert set(schema["LogSurvivalTerms"]["properties"]) == {"two_qubit", "one_qubit", "measurement", "idle_t1", "idle_t2"}
    legacy = StageTelemetry(name="Host", node="CPU", latency_ms=1, status="OPTIMAL", output_summary="", metrics={"legacy": "retained"})
    assert legacy.metrics == {"legacy": "retained"}
    with pytest.raises(ValidationError):
        StageTelemetry(name="Bad", node="QPU", latency_ms=1, status="OPTIMAL", output_summary="", metrics={"coherence_survival_best": 2})

"""Surface-code generation is reproducible, reference-calibrated and verified."""

import math

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from backend.main import app
from backend.models import CustomQPUProfileSpec, SurfaceCodeMetadata
from backend.profiles import HARDWARE_PROFILES, resolve_profile
from backend.surface_code import surface_code_parameters

REFERENCE = dict(code_distance_d=27, physical_2q_error=0.001, threshold_error=0.01,
                 syndrome_cycle_ns=1000.0, logical_qubits_target=1024)


def generated_profile(**changes):
    source = {**REFERENCE, **changes}
    derived = surface_code_parameters(**source)
    fields = HARDWARE_PROFILES["ftqc_surface_code"].model_dump(exclude={"id", "provenance"})
    fields.update(name="Generated surface code", base_profile_id="ftqc_surface_code",
                  n_qubits_max=source["logical_qubits_target"], n_physical_qubits=derived["total_physical_qubits"],
                  surface_code={**source, "physical_qubits_per_logical": derived["physical_qubits_per_logical"], "model_version": 1})
    fields.update({key: derived[key] for key in ("t_1q_ns", "t_2q_ns", "t_meas_ns", "t_reset_ns", "err_1q", "err_2q", "err_meas")})
    return fields


def test_reference_matches_existing_targets_but_uses_documented_rotated_footprint():
    derived = surface_code_parameters(**REFERENCE)
    reference = HARDWARE_PROFILES["ftqc_surface_code"]
    for field in ("t_1q_ns", "t_2q_ns", "t_meas_ns", "t_reset_ns", "err_1q", "err_2q", "err_meas"):
        assert derived[field] == getattr(reference, field)
    assert derived["logical_error_per_round"] == pytest.approx(1e-15)
    assert derived["physical_qubits_per_logical"] == 1458
    assert derived["total_physical_qubits"] == 1492992
    assert derived["nighthawk_r3_modules_required"] == 2872
    assert derived["physical_element_equivalent_modules"] == 735


@pytest.mark.parametrize("physical", [0.001, 0.0037, 5e-324])
def test_monotonic_improvement_and_numerical_floor(physical):
    rows = [surface_code_parameters(**{**REFERENCE, "physical_2q_error": physical, "code_distance_d": d}) for d in range(3, 36, 2)]
    for previous, current in zip(rows, rows[1:]):
        assert current["logical_error_per_round"] <= previous["logical_error_per_round"]
        assert current["err_1q"] <= previous["err_1q"]
        assert current["err_2q"] <= previous["err_2q"]
        assert current["physical_qubits_per_logical"] > previous["physical_qubits_per_logical"]
    assert all(1e-18 <= row["logical_error_per_round"] <= 1 for row in rows)


def test_above_and_at_threshold_are_not_improvements():
    low = surface_code_parameters(**{**REFERENCE, "code_distance_d": 3, "physical_2q_error": 0.011})
    high = surface_code_parameters(**{**REFERENCE, "code_distance_d": 35, "physical_2q_error": 0.011})
    assert not low["is_below_threshold"] and not high["is_below_threshold"]
    assert high["logical_error_per_round"] > low["logical_error_per_round"]
    equal = [surface_code_parameters(**{**REFERENCE, "code_distance_d": d, "physical_2q_error": 0.01}) for d in (3, 35)]
    assert not equal[0]["is_below_threshold"]
    assert equal[0]["logical_error_per_round"] == equal[1]["logical_error_per_round"]
    assert surface_code_parameters(**{**REFERENCE, "physical_2q_error": 0.99, "threshold_error": 5e-324})["logical_error_per_round"] == 1


@pytest.mark.parametrize("field,value", [
    ("code_distance_d", 4), ("code_distance_d", 2), ("code_distance_d", True), ("code_distance_d", 3.5),
    ("physical_2q_error", 0), ("physical_2q_error", 1), ("physical_2q_error", "0.001"),
    ("threshold_error", math.nan), ("threshold_error", 0), ("syndrome_cycle_ns", math.inf),
    ("syndrome_cycle_ns", 0), ("syndrome_cycle_ns", 1e308), ("logical_qubits_target", 0),
    ("logical_qubits_target", 2147483648), ("code_distance_d", 10**1000 + 1),
])
def test_invalid_source_or_derived_range_is_rejected(field, value):
    with pytest.raises((ValueError, ValidationError)):
        surface_code_parameters(**{**REFERENCE, field: value})


def test_verified_source_survives_resolution_and_preserves_builtin():
    fields = generated_profile()
    spec = CustomQPUProfileSpec(**fields)
    profile = resolve_profile("custom", spec)
    assert profile.surface_code.code_distance_d == 27
    assert profile.provenance["surface_code"]["model_version"] == 1
    assert "520 programmable" in profile.provenance["surface_code"]["module_basis"]
    assert "1458" in profile.provenance["surface_code"]["notes"]
    assert profile.provenance["value_types"]["err_2q"] == "surface_code_calibrated_model_assumption"
    assert HARDWARE_PROFILES["ftqc_surface_code"].n_physical_qubits is None
    assert CustomQPUProfileSpec.model_validate_json(spec.model_dump_json()) == spec


@pytest.mark.parametrize("field,value", [("err_2q", 0.1), ("t_2q_ns", 1000), ("n_physical_qubits", 1000), ("t1_us", 200), ("topology_factor", 1.2)])
def test_stale_generator_tag_is_rejected_after_manual_edits(field, value):
    with pytest.raises(ValidationError):
        CustomQPUProfileSpec(**{**generated_profile(), field: value})
    plain = {**generated_profile(), field: value, "surface_code": None}
    assert CustomQPUProfileSpec(**plain).surface_code is None


def test_invalid_or_constructed_metadata_is_revalidated():
    source = generated_profile()["surface_code"]
    for key, value in [("code_distance_d", 4), ("physical_qubits_per_logical", 1000), ("model_version", 2), ("syndrome_cycle_ns", True)]:
        with pytest.raises(ValidationError):
            SurfaceCodeMetadata(**{**source, key: value})
    with pytest.raises(ValidationError):
        CustomQPUProfileSpec(**{**generated_profile(), "surface_code": SurfaceCodeMetadata.model_construct(**{**source, "physical_qubits_per_logical": 1000})})


def test_api_runs_generated_logical_physics_and_rejects_forged_metadata(monkeypatch):
    monkeypatch.delenv("ENGINE_ENV", raising=False)
    monkeypatch.delenv("ENGINE_SECRET", raising=False)
    with TestClient(app) as client:
        for workload, scale in [("shors_crypto", 21), ("quantum_mips", 1024)]:
            payload = dict(workload_id=workload, scale_param=scale, hardware_profile="custom", custom_profile=generated_profile(), available_qubits=1024)
            result = client.post("/api/simulate", json=payload)
            assert result.status_code == 200, result.text
            metrics = result.json()["stages"]["stage_2_quantum_kernel"]["metrics"]
            assert metrics["qpu_profile"]["surface_code"]["code_distance_d"] == 27
            assert metrics["qpu_profile"]["n_physical_qubits"] == 1492992
            assert metrics["log_survival_terms"]["idle_t1"] == metrics["log_survival_terms"]["idle_t2"] == 0
            assert metrics["coherence_survival"] > 0.999
            forged = {**payload, "custom_profile": {**payload["custom_profile"], "err_2q": 0.1}}
            assert client.post("/api/simulate", json=forged).status_code == 422

"""Regression checks for Shor depth and timing across live/model boundaries."""

import math
from unittest.mock import patch

import pytest

from backend.workloads import DEPTH_EXPANSION_FACTOR

from backend.main import (
    HARDWARE_PROFILES, NATIVE_BASIS_GATES, STAGE_KEYS, execute_live_shors_15,
    qpu_capacity_plan, run_shors_pipeline,
)


@pytest.mark.parametrize("profile", HARDWARE_PROFILES)
@pytest.mark.parametrize("tier", ["sequential", "windowed", "ceiling"])
def test_modeled_depth_and_runtime_increase_and_survival_decreases_with_problem_size(profile, tier):
    # Compare like-for-like workspace tiers. Fixed capacity can change tiers as
    # size grows, so it does not isolate the size-scaling formula.
    stages = []
    with patch("backend.main.execute_live_shors_15", return_value={
        "qubits": 8, "depth": 189, "period_r": 4, "top_measurements": "|0100⟩ (1/4)",
        "gate_counts": {"cx": 100, "measure": 4}, "counts": {"0100": 512},
    }):
        for scale in [15, 21, 35, 512, 2048]:
            n = scale if scale in [512, 2048] else (scale - 1).bit_length()
            capacity = {"sequential": 8 if scale == 15 else 2 * n + 3,
                        "windowed": 3 * n, "ceiling": -(-11 * n // 2)}[tier]
            stage = run_shors_pipeline(scale, profile, available_qubits=capacity).stages[STAGE_KEYS[1]]
            assert stage.metrics["reference_circuit_depth"] == math.ceil(qpu_capacity_plan(scale, capacity)["circuit_depth"] * DEPTH_EXPANSION_FACTOR)
            stages.append(stage)
    for smaller, larger in zip(stages, stages[1:]):
        assert smaller.metrics["circuit_depth"] < larger.metrics["circuit_depth"]
        assert smaller.latency_ms < larger.latency_ms
        for field in ("coherence_survival_best", "coherence_survival", "coherence_survival_worst"):
            assert larger.metrics[field] <= smaller.metrics[field]
        # Natural logs keep the regression meaningful after probabilities underflow.
        assert larger.metrics["coherence_log_survival"] <= smaller.metrics["coherence_log_survival"]


def test_live_sampling_depth_cannot_change_modeled_n15_latency():
    stages = []
    for compiled_depth in [189, 5000]:
        with patch("backend.main.execute_live_shors_15", return_value={
            "qubits": 8, "depth": compiled_depth, "period_r": 4, "top_measurements": "|0100⟩ (1/4)",
            "gate_counts": {"cx": 100, "measure": 4}, "counts": {"0100": 512},
        }):
            stages.append(run_shors_pipeline(15, "ideal_sim", available_qubits=8).stages[STAGE_KEYS[1]])
    assert [stage.metrics["aer_reference_circuit_depth"] for stage in stages] == [189, 5000]
    depth = math.ceil(288 * DEPTH_EXPANSION_FACTOR)
    assert all(stage.metrics["circuit_depth"] == depth for stage in stages)
    assert all(stage.latency_ms == (0.30 + 512 * (depth * 250 + 1500) / 1e6) for stage in stages)


def test_shors_aer_compiles_native_basis_and_repeats_exact_shot_counts():
    first = execute_live_shors_15()
    second = execute_live_shors_15()
    assert first == second
    assert set(first["gate_counts"]) <= set(NATIVE_BASIS_GATES) | {"measure"}
    assert first["gate_counts"]["cx"] > 0
    assert first["gate_counts"]["measure"] == 4
    assert first["depth"] > 0
    assert sum(first["counts"].values()) == 512
    assert set(first["counts"]) == {"0000", "0100", "1000", "1100"}
    assert first["period_r"] == 4
    ideal = execute_live_shors_15(noisy=False)
    assert ideal["counts"] == first["counts"]
    assert ideal["coherence_pct"] == 100


@pytest.mark.parametrize("profile", ["ibm_heron_nisq", "google_weber_grid", "ionq_forte_trapped_ion"])
@pytest.mark.parametrize("survival", [0.0, 34.99])
def test_live_n15_exceeded_summaries_name_reference_and_modeled_hardware(profile, survival):
    with patch("backend.estimation.math.exp", return_value=survival / 100), patch(
        "backend.main.execute_live_shors_15", return_value={
            "qubits": 8, "depth": 1594, "period_r": 4, "top_measurements": "|0100⟩ (1/4)",
            "gate_counts": {"cx": 798, "measure": 4}, "counts": {"0100": 512},
        },
    ):
        response = run_shors_pipeline(15, profile, available_qubits=8)
    assert response.execution_mode == "LIVE_QISKIT_AER"
    kernel, post = [response.stages[key] for key in STAGE_KEYS[1:]]
    for stage in (kernel, post):
        assert stage.status == "CRITICAL_BOTTLENECK"
        assert stage.metrics["coherence_status"] == "EXCEEDED"
        assert "Ideal Aer reference:" in stage.output_summary
        assert f"Modeled {HARDWARE_PROFILES[profile].name} survival {survival}%" in stage.output_summary
    assert kernel.metrics["coherence_survival_pct"] == survival
    assert "Extracted period r = 4" in kernel.output_summary
    assert "continued fractions yield 15 = 3 × 5" in post.output_summary
    assert "below the reliability threshold, so no hardware factorization is claimed" in post.output_summary
    assert post.metrics["factors_found"] == "NONE (Decohered)"

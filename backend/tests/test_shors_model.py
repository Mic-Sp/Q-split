"""Regression checks for Shor depth and timing across live/model boundaries."""

from unittest.mock import patch

import pytest

from backend.main import (
    HARDWARE_PROFILES, NATIVE_BASIS_GATES, STAGE_KEYS, execute_live_shors_15,
    qpu_capacity_plan, run_shors_pipeline,
)


@pytest.mark.parametrize("profile", HARDWARE_PROFILES)
@pytest.mark.parametrize("tier", ["sequential", "windowed", "ceiling"])
def test_modeled_depth_and_runtime_strictly_increase_with_problem_size(profile, tier):
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
            assert stage.metrics["reference_circuit_depth"] == qpu_capacity_plan(scale, capacity)["circuit_depth"]
            stages.append(stage)
    for smaller, larger in zip(stages, stages[1:]):
        assert smaller.metrics["circuit_depth"] < larger.metrics["circuit_depth"]
        assert smaller.latency_ms < larger.latency_ms


def test_live_sampling_depth_cannot_change_modeled_n15_latency():
    stages = []
    for compiled_depth in [189, 5000]:
        with patch("backend.main.execute_live_shors_15", return_value={
            "qubits": 8, "depth": compiled_depth, "period_r": 4, "top_measurements": "|0100⟩ (1/4)",
            "gate_counts": {"cx": 100, "measure": 4}, "counts": {"0100": 512},
        }):
            stages.append(run_shors_pipeline(15, "ideal_sim", available_qubits=8).stages[STAGE_KEYS[1]])
    assert [stage.metrics["aer_reference_circuit_depth"] for stage in stages] == [189, 5000]
    assert all(stage.metrics["circuit_depth"] == 288 for stage in stages)
    assert all(stage.latency_ms == round(288 * 0.00025, 2) for stage in stages)


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

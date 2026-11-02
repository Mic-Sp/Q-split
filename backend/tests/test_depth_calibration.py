"""Toy calibration checks and regression coverage for the former MIPS scale seam."""

import json
import math
from pathlib import Path
import subprocess
import sys
from unittest.mock import patch

import pytest

from backend.main import HARDWARE_PROFILES, QUANTUM_MIPS_SCALES, STAGE_KEYS, quantum_mips_kernel, quantum_mips_qubit_thresholds
from backend.scripts.calibrate_depth import calibrate
from backend.workloads import DEPTH_EXPANSION_FACTOR, GATE_COUNT_EXPANSION_FACTOR, mips_spec, shors_spec


@pytest.fixture(scope="module")
def calibration():
    return calibrate()


@pytest.mark.parametrize("reference_index", [0, 1])
def test_calibrated_analytic_resources_are_within_fifteen_percent_of_native_reference(calibration, reference_index):
    reference = calibration["references"][reference_index]
    spec = (shors_spec(15, 8, reference["analytic_depth"]) if reference_index == 0 else mips_spec(64, 10))
    for analytic, compiled in [(spec.depth, reference["compiled_depth"]),
                               (spec.n_1q, reference["one_qubit_count"]),
                               (spec.n_2q, reference["cx_count"])]:
        assert abs(analytic - compiled) / compiled <= 0.15
    assert spec.n_1q == math.ceil(2 * reference["analytic_depth"] * GATE_COUNT_EXPANSION_FACTOR)
    assert spec.n_2q == math.ceil(reference["analytic_depth"] * GATE_COUNT_EXPANSION_FACTOR)
    assert calibration["recommended_depth_expansion_factor"] == DEPTH_EXPANSION_FACTOR
    assert calibration["recommended_gate_count_expansion_factor"] == GATE_COUNT_EXPANSION_FACTOR


def test_recommended_factors_use_the_requested_independent_statistics(calibration):
    references = calibration["references"]
    depth_ratios = [reference["compiled_depth"] / reference["analytic_depth"] for reference in references]
    gate_ratios = []
    for reference in references:
        one_qubit_ratio = reference["one_qubit_count"] / (2 * reference["analytic_depth"])
        two_qubit_ratio = reference["cx_count"] / reference["analytic_depth"]
        assert reference["one_qubit_ratio"] == pytest.approx(one_qubit_ratio)
        assert reference["two_qubit_ratio"] == pytest.approx(two_qubit_ratio)
        gate_ratios.extend([one_qubit_ratio, two_qubit_ratio])
    assert calibration["recommended_depth_expansion_factor"] == round(sum(depth_ratios) / len(depth_ratios), 2)
    assert calibration["recommended_gate_count_expansion_factor"] == round(sum(gate_ratios) / len(gate_ratios), 2)
    assert set(calibration["statistic_types"]) == {
        "recommended_depth_expansion_factor", "recommended_gate_count_expansion_factor",
    }


def test_both_workloads_expand_identical_logical_proxies_identically():
    # The logical laws differ, but both workloads use the same separate
    # depth/count corrections and do not equate CX count with depth.
    specs = [(shors_spec(15, 8, 288), 288), (mips_spec(64, 10), 202)]
    for spec, logical_depth in specs:
        assert spec.depth == math.ceil(logical_depth * DEPTH_EXPANSION_FACTOR)
        assert spec.n_1q == math.ceil(2 * logical_depth * GATE_COUNT_EXPANSION_FACTOR)
        assert spec.n_2q == math.ceil(logical_depth * GATE_COUNT_EXPANSION_FACTOR)
        assert spec.n_2q != spec.depth


@pytest.mark.parametrize("workload", ["shor", "mips"])
@pytest.mark.parametrize("changed_factor", ["DEPTH_EXPANSION_FACTOR", "GATE_COUNT_EXPANSION_FACTOR"])
def test_depth_and_count_factors_change_only_their_own_resources(monkeypatch, workload, changed_factor):
    from backend import workloads

    def build():
        return shors_spec(15, 8, 288) if workload == "shor" else mips_spec(64, 10)

    before = build()
    monkeypatch.setattr(workloads, changed_factor, 2 * getattr(workloads, changed_factor))
    after = build()
    if changed_factor == "DEPTH_EXPANSION_FACTOR":
        assert after.depth > before.depth
        assert (after.n_1q, after.n_2q) == (before.n_1q, before.n_2q)
    else:
        assert after.depth == before.depth
        assert after.n_1q > before.n_1q
        assert after.n_2q > before.n_2q


@pytest.mark.parametrize("profile", HARDWARE_PROFILES)
@pytest.mark.parametrize("tier", ["minimum_qubits_required", "windowed_qubits_required", "ceiling_qubits_required"])
def test_mips_depth_grows_across_all_scales_without_a_live_analytic_seam(profile, tier):
    with patch("backend.main.execute_live_quantum_mips_64", return_value={
        "aer_reference_circuit_depth": 9999, "aer_reference_qubits": 10,
        "aer_gate_counts": {"cx": 1, "measure": 6}, "aer_shots": 1024,
        "aer_counts": {"101101": 1024}, "top_1_token_index": 45,
        "measured_peak_probability": 1, "aer_runtime_ms": 1,
    }):
        stages = [quantum_mips_kernel(scale, profile, "QPU", quantum_mips_qubit_thresholds(scale)[tier])
                  for scale in QUANTUM_MIPS_SCALES]
    depths = [stage.metrics["circuit_depth"] for stage in stages]
    assert all(smaller <= larger for smaller, larger in zip(depths, depths[1:]))
    assert depths[1] >= 3 * depths[0]
    for smaller, larger in zip(stages, stages[1:]):
        assert larger.latency_ms >= smaller.latency_ms
        for field in ("coherence_survival_best", "coherence_survival", "coherence_survival_worst", "coherence_log_survival"):
            assert larger.metrics[field] <= smaller.metrics[field]
    for scale, stage in zip(QUANTUM_MIPS_SCALES, stages):
        assert stage.metrics["circuit_spec"] == mips_spec(
            scale, stage.metrics["qubits_allocated"], stage.metrics["depth_multiplier"],
        ).model_dump()


def test_calibration_script_runs_without_fastapi_import():
    root = Path(__file__).resolve().parents[2]
    result = subprocess.run([
        sys.executable, "-c",
        "import runpy, sys; sys.modules['fastapi'] = None; "
        "runpy.run_path('backend/scripts/calibrate_depth.py', run_name='__main__')",
    ], cwd=root, capture_output=True, text=True, check=True)
    output = json.loads(result.stdout)
    assert output["recommended_depth_expansion_factor"] == DEPTH_EXPANSION_FACTOR
    assert output["recommended_gate_count_expansion_factor"] == GATE_COUNT_EXPANSION_FACTOR
    for reference in output["references"]:
        assert reference["compiled_depth"] > 0
        assert reference["cx_count"] > 0
        assert reference["one_qubit_count"] > 0
        assert reference["depth_ratio"] == pytest.approx(reference["compiled_depth"] / reference["analytic_depth"])

"""Base selection distinguishes toy moduli from analytical RSA bit-widths."""

import math
from unittest.mock import patch

import pytest

from backend.main import RoutingConfig, STAGE_KEYS, run_shors_pipeline
from backend.workloads import select_shors_base


def test_toy_base_sweep_is_coprime_and_minimal_except_live_n15():
    for modulus in range(2, 201):
        base = select_shors_base(modulus)
        assert base >= 2
        assert math.gcd(base, modulus) == 1, (modulus, base)
        if modulus != 15:
            assert all(math.gcd(candidate, modulus) != 1 for candidate in range(2, base)), (modulus, base)
    assert select_shors_base(2) == 3


@pytest.mark.parametrize("modulus", [15, 21, 35])
@pytest.mark.parametrize("node", ["CPU", "GPU", "QPU"])
def test_supported_toy_pipelines_report_a_coprime_base(modulus, node):
    with patch("backend.main.execute_live_shors_15", return_value={
        "qubits": 8, "depth": 1594, "period_r": 4, "top_measurements": "|0100⟩ (1/4)",
        "gate_counts": {"cx": 798, "measure": 4}, "counts": {"0100": 512},
    }):
        result = run_shors_pipeline(modulus, "ideal_sim", RoutingConfig(stage_2_node=node))
    pre = result.stages[STAGE_KEYS[0]]
    base = pre.metrics["base_a"]
    assert math.gcd(base, modulus) == 1
    assert base == select_shors_base(modulus)
    assert f"Selected coprime base a = {base}" in pre.output_summary
    if modulus == 35:
        assert base == 2
        assert "N = 35" in pre.output_summary


def test_n15_preserves_base_seven_and_passes_it_to_aer():
    assert select_shors_base(15) == 7
    with patch("backend.main.execute_live_shors_15", return_value={
        "qubits": 8, "depth": 1594, "period_r": 4, "top_measurements": "|0100⟩ (1/4)",
        "gate_counts": {"cx": 798, "measure": 4}, "counts": {"0100": 512},
    }) as aer:
        result = run_shors_pipeline(15, "ideal_sim", available_qubits=8)
    assert result.stages[STAGE_KEYS[0]].metrics["base_a"] == 7
    aer.assert_called_once_with(a=7, noisy=False)


@pytest.mark.parametrize("bits", [512, 2048])
def test_rsa_uses_fixed_base_without_treating_bit_width_as_modulus(bits):
    with patch("backend.workloads.math.gcd", side_effect=AssertionError("RSA modulus is unspecified")):
        assert select_shors_base(bits) == 2
        result = run_shors_pipeline(bits, "ideal_sim")
    pre = result.stages[STAGE_KEYS[0]]
    assert pre.metrics["base_a"] == 2
    assert "Selected fixed base a = 2" in pre.output_summary
    assert "odd-modulus assumption" in pre.output_summary
    assert "bit-width" in pre.output_summary


@pytest.mark.parametrize("scale", [0, 1, -1, True, 15.0, "35", None])
def test_invalid_scales_fail_before_the_base_search(scale):
    with pytest.raises(ValueError):
        select_shors_base(scale)

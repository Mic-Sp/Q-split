"""The backend and frontend use inclusive 70% / 35% coherence boundaries."""

from unittest.mock import patch

import pytest

from backend.main import (
    STAGE_KEYS, coherence_status, run_quantum_mips_pipeline, run_shors_pipeline,
)


@pytest.mark.parametrize("survival,classification,severity", [
    (100, "NOMINAL", "OPTIMAL"), (70, "NOMINAL", "OPTIMAL"),
    (69.99, "DEGRADED", "WARNING"), (40, "DEGRADED", "WARNING"),
    (35, "DEGRADED", "WARNING"), (34.99, "EXCEEDED", "CRITICAL_BOTTLENECK"),
    (15, "EXCEEDED", "CRITICAL_BOTTLENECK"), (0, "EXCEEDED", "CRITICAL_BOTTLENECK"),
])
@pytest.mark.parametrize("workload,scale,capacity", [("shor", 15, 8), ("shor", 21, 13), ("mips", 1024, 14)])
def test_kernel_and_postprocessing_share_coherence_boundaries(survival, classification, severity, workload, scale, capacity):
    assert coherence_status(survival) == classification
    with patch("backend.main.math.exp", return_value=survival / 100), patch(
        "backend.main.execute_live_shors_15", return_value={
            "qubits": 8, "depth": 1594, "period_r": 4, "top_measurements": "|0100⟩ (1/4)",
            "gate_counts": {"cx": 798, "measure": 4}, "counts": {"0100": 512},
        },
    ):
        pipeline = run_shors_pipeline if workload == "shor" else run_quantum_mips_pipeline
        response = pipeline(scale, "ibm_heron_nisq", available_qubits=capacity)
    kernel, post = [response.stages[key] for key in STAGE_KEYS[1:]]
    assert kernel.metrics["coherence_survival_pct"] == survival
    assert kernel.metrics["coherence_status"] == post.metrics["coherence_status"] == classification
    assert kernel.status == post.status == severity
    if workload == "shor":
        assert (post.metrics["factors_found"] == "NONE (Decohered)") == (classification == "EXCEEDED")
    else:
        assert kernel.metrics["retrieval_reliable"] == (classification != "EXCEEDED")
        if classification != "NOMINAL":
            assert "QPU" in response.primary_bottleneck
            assert "GPU" not in response.primary_bottleneck


@pytest.mark.parametrize("pipeline,scale", [(run_shors_pipeline, 21), (run_quantum_mips_pipeline, 1024)])
def test_blocked_ideal_qpu_cannot_leave_nominal_postprocessing_coherence(pipeline, scale):
    response = pipeline(scale, "ideal_sim", available_qubits=1)
    for key in STAGE_KEYS[1:]:
        stage = response.stages[key]
        assert not stage.metrics["execution_feasible"]
        assert stage.metrics["coherence_status"] == "EXCEEDED"


@pytest.mark.parametrize("pipeline,scale,capacity", [(run_shors_pipeline, 21, 13), (run_quantum_mips_pipeline, 1024, 14)])
@pytest.mark.parametrize("profile", ["ibm_heron_nisq", "ideal_sim"])
def test_percentage_formatting_changes_only_prose_not_precision_or_classification(pipeline, scale, capacity, profile):
    before = pipeline(scale, profile, available_qubits=capacity).model_dump()
    with patch("backend.main._fmt_pct", return_value="display-only"):
        after = pipeline(scale, profile, available_qubits=capacity).model_dump()
    assert "display-only" in after["stages"][STAGE_KEYS[1]]["output_summary"]
    for stages in (before["stages"], after["stages"]):
        for stage in stages.values():
            stage.pop("output_summary")
    # Includes every float, best/worst bound, status, and response key.
    assert after == before

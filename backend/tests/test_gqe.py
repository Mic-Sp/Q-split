"""GPT-QE molecular defaults, epoch accounting, AI costs and representative physics."""

import itertools
import json
import math
from pathlib import Path
import shutil
import subprocess
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from backend.estimation import estimate_qpu
from backend.gqe import (GQE_AI_MODEL, GQE_AI_PROFILES, estimate_gqe_qpu, estimate_gqe_emulation,
                         gqe_ai_resources)
from backend.main import (SimulationRequest, RoutingConfig, run_gqe_pipeline, app, STAGE_KEYS)
from backend.models import CircuitSpec, GQEParameters, GQEExecutionPlan, InterconnectConfig
from backend.profiles import HARDWARE_PROFILES, execution_profile
from backend.workloads import gqe_parameters, gqe_plan


@pytest.fixture(autouse=True)
def local_engine_environment(monkeypatch):
    for variable in ("ENGINE_ENV", "ENGINE_SECRET", "ENGINE_ENABLE_DOCS"):
        monkeypatch.delenv(variable, raising=False)


def small_plan(**changes):
    return gqe_plan(4, {"epochs": 2, "circuits_per_epoch": 3, "sequence_length": 4, "vocabulary_size": 32,
        "pauli_measurement_groups": 4, "shots_per_group": 100, "gradient_steps_per_epoch": 1,
        "minibatch_size": 8, "replay_buffer_capacity": 100, **changes})


@pytest.mark.parametrize("q,tokens,vocab,groups,epochs,finetune", [
    (4, 10, 80, 5, 200, 40), (10, 40, 416, 25, 1000, 200), (12, 80, 592, 45, 1500, 300)])
@pytest.mark.parametrize("mode", ["from_scratch", "pretrained_finetune"])
def test_molecular_and_mode_defaults(q, tokens, vocab, groups, epochs, finetune, mode):
    payload = {"workload_id": "gqe", "scale_param": q, "gqe": {"training_mode": mode}}
    original = json.loads(json.dumps(payload))
    request = SimulationRequest(**payload)
    p = request.gqe
    assert p.sequence_length == tokens
    assert p.vocabulary_size == vocab
    assert p.pauli_measurement_groups == groups
    assert p.epochs == (finetune if mode == "pretrained_finetune" else epochs)
    assert (p.circuits_per_epoch, p.shots_per_group, p.gradient_steps_per_epoch,
            p.minibatch_size, p.replay_buffer_capacity) == (50, 1024, 5, 50, 1000)
    assert payload == original
    assert gqe_parameters(q, {"training_mode": mode}) == p


def test_omitted_scale_partial_controls_and_explicit_epochs():
    assert SimulationRequest(workload_id="gqe").scale_param == 4
    request = SimulationRequest(workload_id="gqe", scale_param=12,
                                gqe={"training_mode": "pretrained_finetune", "epochs": 3, "vocabulary_size": 100})
    assert request.gqe.epochs == 3
    assert request.gqe.vocabulary_size == 100
    assert request.gqe.sequence_length == 80
    assert GQEParameters(training_mode="pretrained_finetune").epochs == 40
    typed = gqe_parameters(12, GQEParameters(training_mode="pretrained_finetune"))
    assert (typed.epochs, typed.sequence_length, typed.vocabulary_size) == (300, 80, 592)
    assert gqe_parameters(10, GQEParameters(epochs=7)).epochs == 7
    assert SimulationRequest().scale_param == 15 and SimulationRequest().gqe is None
    assert SimulationRequest(workload_id="quantum_mips").scale_param == 64
    assert SimulationRequest(workload_id="skqd").scale_param == 22


@pytest.mark.parametrize("field,lower,upper", [
    ("epochs", 1, 5000), ("circuits_per_epoch", 1, 250), ("sequence_length", 4, 200),
    ("vocabulary_size", 32, 2048), ("pauli_measurement_groups", 1, 250), ("shots_per_group", 100, 100_000),
    ("gradient_steps_per_epoch", 1, 50), ("minibatch_size", 8, 256), ("replay_buffer_capacity", 100, 50_000)])
def test_parameter_bounds_and_strict_numeric_types(field, lower, upper):
    for value in (lower, upper):
        assert getattr(SimulationRequest(workload_id="gqe", gqe={field: value}).gqe, field) == value
    for value in (lower - 1, upper + 1, True, float(lower), str(lower), None, math.inf, math.nan, [lower]):
        with pytest.raises(ValidationError):
            SimulationRequest(workload_id="gqe", gqe={field: value})


@pytest.mark.parametrize("q", [True, 4.0, "4", 5, 22, 85, 0, None])
def test_reject_unsupported_or_noninteger_scales(q):
    with pytest.raises(ValidationError):
        SimulationRequest(workload_id="gqe", scale_param=q)


@pytest.mark.parametrize("value", ["offline", None, True, 42, []])
def test_invalid_training_mode(value):
    with pytest.raises(ValidationError):
        SimulationRequest(workload_id="gqe", gqe={"training_mode": value})


def test_unknown_nested_controls_and_foreign_workloads():
    for value in ({"epohs": 5}, {"pauli_Measurement_groups": 5}, False, []):
        with pytest.raises(ValidationError):
            SimulationRequest(workload_id="gqe", gqe=value)
    for workload in ("shors_crypto", "quantum_mips", "skqd"):
        with pytest.raises(ValidationError):
            SimulationRequest(workload_id=workload, gqe={})
    with pytest.raises(ValidationError):
        SimulationRequest(workload_id="gqe", skqd={})


@pytest.mark.parametrize("q,resources", [(4, (42, 40, 46, 4)), (10, (162, 160, 415, 10)), (12, (322, 320, 978, 12))])
def test_representative_resources_and_compact_multiplicities(q, resources, monkeypatch):
    plan = gqe_plan(q)
    spec = plan.circuit_spec
    assert (spec.depth, spec.n_2q, spec.n_1q, spec.n_meas) == resources
    assert spec.stage1_ms == spec.stage3_ms == 0
    assert spec.native_classical_ms is None
    monkeypatch.setattr("backend.workloads.DEPTH_EXPANSION_FACTOR", 1000)
    monkeypatch.setattr("backend.workloads.GATE_COUNT_EXPANSION_FACTOR", 1000)
    assert gqe_plan(q) == plan
    counts = plan.multiplicities()
    assert counts["total_generated_circuits"] == plan.parameters.epochs * 50
    assert counts["total_shots"] == counts["total_circuit_evaluations"] * 1024
    assert GQEExecutionPlan.model_validate_json(plan.model_dump_json()) == plan
    assert len(plan.model_dump_json()) < 1500


def test_plan_revalidates_resources_without_weakening_single_circuit_validation():
    plan = small_plan()
    for extra in ({"epochs": 2}, {"circuits_per_epoch": 50}, {"depth": [1, 2]}, {"depth": 4.0}):
        with pytest.raises(ValidationError):
            CircuitSpec.model_validate({**plan.circuit_spec.model_dump(), **extra})
    for field, value in (("n_2q", 17), ("stage1_ms", 1.0), ("n_meas", 1)):
        altered = plan.model_copy(update={"circuit_spec": plan.circuit_spec.model_copy(update={field: value})})
        with pytest.raises(ValidationError):
            estimate_gqe_qpu(altered, HARDWARE_PROFILES["ideal_sim"], 0.3)
    invalid = plan.model_copy(update={"parameters": plan.parameters.model_copy(update={"epochs": True})})
    with pytest.raises(ValidationError):
        gqe_ai_resources(invalid, "CPU", "GPU")


@pytest.mark.parametrize("profile_id", HARDWARE_PROFILES)
def test_exact_single_shot_survival_is_preserved_for_all_repetition_counts(profile_id):
    profile = HARDWARE_PROFILES[profile_id]
    plan = small_plan()
    single = estimate_qpu(plan.circuit_spec, profile, 1, 0.0)
    for changed in (plan, small_plan(epochs=20), small_plan(circuits_per_epoch=200),
                    small_plan(pauli_measurement_groups=250), small_plan(shots_per_group=100_000)):
        actual = estimate_gqe_qpu(changed, profile, 0.3)
        for key in ("circuit_depth", "n_2q", "t_circuit_us", "coherence_survival", "coherence_survival_pct",
                    "coherence_survival_best", "coherence_survival_worst", "coherence_log_survival", "log_survival_terms"):
            assert actual[key] == single[key]
        counts = changed.multiplicities()
        assert actual["shots"] == counts["total_shots"]
        assert actual["launch_overhead_ms"] == pytest.approx(changed.parameters.epochs * 0.3)
        assert actual["latency_ms"] == pytest.approx(changed.parameters.epochs * 0.3 + counts["total_shots"] * single["latency_ms"])
        assert actual["latency_ms"] == pytest.approx(sum(actual[key] for key in ("gate_execution_ms", "measurement_reset_ms", "launch_overhead_ms")))
        assert actual["survival_scope"] == "representative_per_shot"


def test_per_epoch_launch_and_complete_shot_pacing():
    plan = small_plan()
    result = estimate_gqe_qpu(plan, HARDWARE_PROFILES["ibm_nighthawk_r2"], 0.3)
    assert result["shots"] == 2400
    assert result["circuit_depth"] == 22
    assert result["latency_ms"] == pytest.approx(24.6)  # 2400 * 10 us + 2 * 0.30 ms
    assert result["gate_execution_ms"] == pytest.approx(2.112)
    assert result["launch_count"] == 2
    assert result["repetition_delay_ms"] > 0
    assert result["t_circuit_us"] == pytest.approx(0.88)


def test_link_traffic_and_delays_are_subsets_not_extra_charges():
    plan = gqe_plan(4, small_plan().parameters, interconnect=InterconnectConfig(placement="dual"))
    profile = HARDWARE_PROFILES["ibm_nighthawk_r3_dual"]
    actual = estimate_gqe_qpu(plan, profile, 0.3)
    assert actual["link_execution_ms"] == pytest.approx(0.72)
    assert actual["gate_execution_ms"] == pytest.approx(2.832)
    assert actual["latency_ms"] == pytest.approx(24.6)
    single = estimate_qpu(plan.circuit_spec, profile, 1, 0)
    assert actual["log_survival_terms"] == single["log_survival_terms"]


@pytest.mark.parametrize("launch", [True, -1, None, "0.3", math.nan, math.inf])
def test_launch_validation_is_not_bypassed_by_epoch_multiplication(launch):
    with pytest.raises(ValueError):
        estimate_gqe_qpu(small_plan(), HARDWARE_PROFILES["ideal_sim"], launch)


@pytest.mark.parametrize("node,ns,launch", [("CPU", 2, 0), ("GPU", 0.5, 0.6)])
def test_emulation_reuses_pre_measurement_states_and_peak_RAM(node, ns, launch):
    plan = small_plan()
    actual = estimate_gqe_emulation(plan, node, stage1_ms=2, stage3_ms=3)["circuit_emulation"]
    # 18 prep 1Q + 2*16 2Q amplitude ops; group proxy is 4 rotations + 4 reductions.
    prepare = 6 * 50 * 16 * ns / 1e6
    groups = 6 * 4 * 8 * 16 * ns / 1e6
    assert actual["state_preparation_compute_ms"] == pytest.approx(prepare)
    assert actual["measurement_groups_compute_ms"] == pytest.approx(groups)
    assert actual["kernel_ms"] == pytest.approx(prepare + groups + launch)
    assert actual["total_ms"] == pytest.approx(prepare + groups + launch + 5)
    assert actual["state_preparations"] == 6
    assert actual["memory_required_bytes"] == 16 * 2**4
    more_shots = estimate_gqe_emulation(small_plan(shots_per_group=100_000), node, stage1_ms=2, stage3_ms=3)
    assert more_shots["circuit_emulation"] == actual
    more_groups = estimate_gqe_emulation(small_plan(pauli_measurement_groups=8), node)["circuit_emulation"]
    assert more_groups["state_preparation_compute_ms"] == actual["state_preparation_compute_ms"]
    assert more_groups["measurement_groups_compute_ms"] == 2 * actual["measurement_groups_compute_ms"]
    assert more_groups["memory_required_bytes"] == actual["memory_required_bytes"]


def test_classical_emulation_does_not_consult_QPU_physics():
    with patch("backend.gqe.estimate_qpu", side_effect=AssertionError("Must not call physical estimator")):
        assert estimate_gqe_emulation(small_plan(), "GPU")["circuit_emulation"]["feasible"]
    with pytest.raises(ValueError):
        estimate_gqe_emulation(small_plan(), "QPU")


@pytest.mark.parametrize("first,last", list(itertools.product(("CPU", "GPU"), repeat=2)))
def test_AI_flop_bandwidth_and_sync_equations(first, last):
    plan = small_plan()
    result = gqe_ai_resources(plan, first, last)
    stage1, stage3 = result["stage1"], result["stage3"]
    parameters = 10_812_288
    assert result["transformer_parameters"] == parameters
    assert stage1["generation_flops_per_epoch"] == 259_937_280
    assert stage3["training_flops_per_epoch"] == 2_079_498_240
    assert stage1["generation_compute_ms"] == pytest.approx(2 * 259_937_280 / GQE_AI_PROFILES[first]["flops_per_second"] * 1000)
    assert stage3["training_compute_ms"] == pytest.approx(2 * 2_079_498_240 / GQE_AI_PROFILES[last]["flops_per_second"] * 1000)
    assert stage3["optimizer_bytes_per_epoch"] == parameters * 28
    assert stage3["optimizer_compute_ms"] == pytest.approx(2 * parameters * 28 / GQE_AI_PROFILES[last]["bandwidth_bytes_per_second"] * 1000)
    assert stage3["replay_occupied_records"] == 6
    assert stage3["replay_sort_operations_per_epoch"] == pytest.approx(6 * math.log2(6))
    assert stage3["energy_reduction_operations_per_epoch"] == 12
    assert stage1["gpu_launch_overhead_ms"] == (0.6 if first == "GPU" else 0)
    assert stage3["gpu_launch_overhead_ms"] == (0.6 if last == "GPU" else 0)
    if first != last:
        transfer_bytes = 2 * parameters + 3 * 4 * 8
        assert stage3["cross_device_sync_bytes_per_epoch"] == transfer_bytes
        assert stage3["cross_device_transfer_ms"] == pytest.approx(2 * (transfer_bytes / 16e9 * 1000 + 0.15))
    else:
        assert stage3["cross_device_transfer_ms"] == 0
    assert stage1["latency_ms"] == pytest.approx(stage1["setup_ms"] + stage1["generation_compute_ms"] + stage1["gpu_launch_overhead_ms"])
    assert stage3["latency_ms"] == pytest.approx(stage3["compute_latency_ms"] + stage3["launch_transfer_overhead_ms"])


@pytest.mark.parametrize("node", ["CPU", "GPU"])
def test_checkpoint_and_historical_pretraining_are_separate_from_active_epochs(node):
    scratch = gqe_ai_resources(small_plan(), node, node)
    tuned = gqe_ai_resources(small_plan(training_mode="pretrained_finetune"), node, node)
    assert scratch["stage1"]["checkpoint_load_ms"] == 0
    assert scratch["stage1"]["initialization_ms"] > 0
    assert tuned["stage1"]["initialization_ms"] == 0
    assert tuned["stage1"]["checkpoint_load_ms"] == (12 if node == "CPU" else 4.5)
    history = tuned["stage1"]["historical_offline_pretraining_reference"]
    assert history["included_in_active_latency"] is False and history["latency_ms"] > 0
    assert tuned["stage1"]["latency_ms"] == pytest.approx(tuned["stage1"]["pool_construction_ms"] + tuned["stage1"]["checkpoint_load_ms"] + tuned["stage1"]["generation_compute_ms"] + tuned["stage1"]["gpu_launch_overhead_ms"])
    assert scratch["stage3"] == tuned["stage3"]


@pytest.mark.parametrize("first,last", list(itertools.product(("CPU", "GPU"), repeat=2)))
def test_standalone_and_coexisting_device_memory_equations(first, last):
    result = gqe_ai_resources(small_plan(), first, last)
    memory, p = result["memory"], result["transformer_parameters"]
    kv, activations, replay, pool = 2 * 6 * 384 * 2 * 3 * 4, 8 * 4 * (6 * 384 * 8 + 32 * 4), 100 * (4 * 4 + 16), 32 * 4 * 16
    assert memory["weights_bytes"] == memory["gradients_bytes"] == 2 * p
    assert memory["optimizer_and_master_weights_bytes"] == 12 * p
    assert memory["inference_kv_cache_bytes"] == kv
    assert memory["training_activations_and_logits_bytes"] == activations
    assert memory["replay_buffer_bytes"] == replay
    assert memory["operator_pool_bytes"] == pool
    assert memory["stage1_peak_memory_bytes"] == 2 * p + kv + pool
    assert memory["stage3_peak_memory_bytes"] == 16 * p + activations + replay
    peaks = memory["coexisting_device_peak_memory_bytes"]
    if first == last:
        assert peaks == {first: 16 * p + replay + pool + max(kv, activations)}
    else:
        assert peaks == {first: memory["stage1_peak_memory_bytes"], last: memory["stage3_peak_memory_bytes"]}
    assert memory["shared_classical_device"] == (first == last)


def test_replay_occupancy_saturates_but_memory_reserves_requested_capacity():
    low = gqe_ai_resources(small_plan(epochs=1), "CPU", "CPU")
    high = gqe_ai_resources(small_plan(epochs=100), "CPU", "CPU")
    assert low["stage3"]["replay_occupied_records"] == 3
    assert high["stage3"]["replay_occupied_records"] == 100
    assert low["memory"] == high["memory"]
    assert high["stage1"]["setup_ms"] == low["stage1"]["setup_ms"]
    assert high["stage1"]["generation_compute_ms"] == pytest.approx(100 * low["stage1"]["generation_compute_ms"])


@pytest.mark.parametrize("nodes", list(itertools.product(("CPU", "GPU", "QPU"), repeat=3)))
def test_all_stage_routes_and_closed_loop_preflight(nodes):
    routing = RoutingConfig(**dict(zip(("stage_1_node", "stage_2_node", "stage_3_node"), nodes)))
    result = run_gqe_pipeline(4, "ideal_sim", routing, gqe=small_plan().parameters)
    stages = [result.stages[key] for key in STAGE_KEYS]
    assert [stage.node for stage in stages] == list(nodes)
    blocked = nodes[0] == "QPU" or nodes[2] == "QPU"
    for stage in stages:
        assert stage.metrics["execution_feasible"] is not blocked
        if blocked:
            assert stage.latency_ms == stage.metrics["compute_latency_ms"] == 0
    if not blocked:
        post = stages[2].metrics
        expected = (stages[0].latency_ms + stages[2].latency_ms) / stages[1].metrics["qpu_evaluation_comparison"]["latency_ms"]
        assert post["ai_to_qpu_latency_ratio"] == pytest.approx(expected)
        assert post["bottleneck_regime"] == ("classical_ai_bound" if expected >= 1 else "qpu_evaluation_bound")
    else:
        assert stages[2].metrics["ai_to_qpu_latency_ratio"] is None
    json.dumps(result.model_dump(), allow_nan=False)


def test_classical_emulation_baseline_charges_accumulated_hosts_once():
    plan = small_plan()
    result = run_gqe_pipeline(4, "ideal_sim", RoutingConfig(stage_2_node="CPU"), gqe=plan.parameters)
    baseline = result.stages[STAGE_KEYS[1]].metrics["classical_cpu_baseline"]
    assert baseline["total_ms"] == pytest.approx(sum(stage.latency_ms for stage in result.stages.values()))
    assert baseline["host_preprocessing_ms"] == result.stages[STAGE_KEYS[0]].latency_ms
    assert baseline["host_postprocessing_ms"] == result.stages[STAGE_KEYS[2]].latency_ms


def test_capacity_failure_blocks_all_epochs_but_does_not_block_a_classical_kernel():
    result = run_gqe_pipeline(10, "ideal_sim", available_qubits=9)
    assert result.primary_bottleneck == "INSUFFICIENT QPU QUBIT CAPACITY"
    assert all(stage.latency_ms == 0 for stage in result.stages.values())
    kernel = result.stages[STAGE_KEYS[1]].metrics
    assert kernel["log_survival_terms"] is kernel["coherence_log_survival"] is None
    assert kernel["launch_count"] == 0
    emulated = run_gqe_pipeline(10, "ideal_sim", RoutingConfig(stage_2_node="CPU"), available_qubits=1)
    assert emulated.stages[STAGE_KEYS[1]].metrics["execution_feasible"]
    assert emulated.stages[STAGE_KEYS[2]].metrics["ai_to_qpu_latency_ratio"] is None


@pytest.mark.parametrize("q", [4, 10, 12])
@pytest.mark.parametrize("profile", HARDWARE_PROFILES)
def test_HTTP_response_profiles_presets_and_complete_physical_diagnostics(q, profile):
    with TestClient(app) as client:
        response = client.post("/api/simulate", json={"workload_id": "gqe", "scale_param": q, "hardware_profile": profile})
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["workload_id"] == "gqe"
    assert data["resource_model_version"] == 2 and data["routing_model"] == "CALIBRATED_V2"
    assert data["execution_mode"] == "NISQ_ANALYTICAL_PROFILER"
    metrics = data["stages"][STAGE_KEYS[1]]["metrics"]
    assert metrics["qubits_required"] == q
    assert metrics["log_survival_terms"] is not None
    assert metrics["survival_scope"] == "representative_per_shot"
    assert metrics["coherence_survival_worst"] <= metrics["coherence_survival_best"]
    assert "utilization" not in response.text.lower()


def test_maximum_request_is_compact_and_response_has_no_epoch_or_sample_arrays():
    params = {"epochs": 5000, "circuits_per_epoch": 250, "sequence_length": 200, "vocabulary_size": 2048,
              "pauli_measurement_groups": 250, "shots_per_group": 100_000,
              "gradient_steps_per_epoch": 50, "minibatch_size": 256, "replay_buffer_capacity": 50_000}
    request = {"workload_id": "gqe", "scale_param": 12, "hardware_profile": "ideal_sim", "gqe": params}
    assert len(json.dumps(request)) < 4096
    with TestClient(app) as client, patch("backend.main.execute_live_shors_15", side_effect=AssertionError), patch(
            "backend.main.execute_live_quantum_mips_64", side_effect=AssertionError):
        response = client.post("/api/simulate", json=request)
    assert response.status_code == 200, response.text
    data = response.json()
    assert len(response.content) < 65_536
    counts = data["stages"][STAGE_KEYS[1]]["metrics"]["execution_plan"]
    assert counts["total_shots"] == 31_250_000_000_000
    def no_arrays(value):
        assert not isinstance(value, list)
        if isinstance(value, dict):
            for child in value.values():
                no_arrays(child)
    for stage in data["stages"].values():
        # Existing hardware provenance legitimately has bounded source lists.
        # GQE execution/work diagnostics must not scale into per-epoch arrays.
        for key, value in stage["metrics"].items():
            if key != "qpu_profile":
                no_arrays(value)
    json.dumps(data, allow_nan=False)


def test_public_validation_and_authentication_happen_before_dispatch(monkeypatch):
    with TestClient(app) as client, patch("backend.main.run_gqe_pipeline") as dispatch:
        for body in ({"scale_param": 5}, {"gqe": {"epochs": True}}, {"gqe": {"unknown": 1}}, {"gqe": {"training_mode": "offline"}}):
            assert client.post("/api/simulate", json={"workload_id": "gqe", **body}).status_code == 422
        dispatch.assert_not_called()
        monkeypatch.setenv("ENGINE_SECRET", "gqe-secret")
        assert client.post("/api/simulate", json={"workload_id": "gqe"}).status_code == 401
        dispatch.assert_not_called()


def test_gqe_custom_hardware_is_compatible_with_existing_inverse_design_without_frontend_edits():
    root = Path(__file__).resolve().parents[2]
    if shutil.which("node") is None or not (root / "frontend/node_modules/tsx").exists():
        pytest.skip("Optional existing frontend inverse-design verifier is unavailable")
    fields = HARDWARE_PROFILES["ibm_nighthawk_r3_dual"].model_dump(exclude={"id", "provenance"})
    fields.update(name="GQE inverse-design regression", base_profile_id="ibm_nighthawk_r3_dual")
    request = SimulationRequest(workload_id="gqe", hardware_profile="custom", custom_profile=fields,
                                interconnect={"placement": "dual"})
    from backend.main import simulate_workload
    data = simulate_workload(request)
    run = {"id": "c367fe2e-f083-4996-8cbd-000000000001", "completedAt": "2026-11-18T12:00:00.000Z",
           "request": request.model_dump(), "telemetry": data.model_dump()}
    script = """
import fs from 'node:fs';
import { inverseDesignTargets } from './src/lib/inverse-design.ts';
const result = inverseDesignTargets(JSON.parse(fs.readFileSync(0, 'utf8')));
if (result.status !== 'available') throw new Error(result.reason);
console.log(JSON.stringify({ status: result.status, basis: result.survival_basis }));
"""
    completed = subprocess.run(["node", "--import", "tsx", "--conditions=react-server", "--input-type=module", "-e", script],
        input=json.dumps(run), cwd=root / "frontend", capture_output=True, text=True, timeout=30, check=True)
    assert json.loads(completed.stdout)["status"] == "available"


def test_host_cost_provenance_keeps_effective_hardware_assumptions_explicit():
    resources = gqe_ai_resources(small_plan(), "CPU", "GPU")
    assert resources["ai_model_version"] == 1
    assert GQE_AI_PROFILES["CPU"]["flops_per_second"] == 0.25e12
    assert GQE_AI_PROFILES["GPU"]["flops_per_second"] == 18e12
    assert resources["ai_model_provenance"]["value_type"] == "model_assumption"
    assert resources["ai_model_provenance"]["adamw_bytes_per_parameter"] == 28
    assert GQE_AI_MODEL["attention_heads"] == 6

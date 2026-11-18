"""Versioned analytical GPT-QE costs; no transformer, quantum or chemistry execution.

The serial schedule is setup -> [generate -> evaluate -> update/train] * E.
Stage cards accumulate categories across epochs. A uniform token/basis proxy
keeps physical survival scoped to one representative shot, never a whole run.
All throughput, bandwidth and auxiliary operation coefficients are assumptions,
not device utilization, measured benchmark times, or evidence of convergence.
"""

import math

if __package__:
    from .models import GQEExecutionPlan, QPUProfile
    from .estimation import estimate_qpu, estimate_classical
    from .profiles import execution_profile, profile_metrics
    from .workloads import GQE_SCALES
else:
    from models import GQEExecutionPlan, QPUProfile
    from estimation import estimate_qpu, estimate_classical
    from profiles import execution_profile, profile_metrics
    from workloads import GQE_SCALES


GQE_AI_PROFILES = {
    "CPU": {"flops_per_second": 0.25e12, "bandwidth_bytes_per_second": 50e9,
            "gpu_launch_ms_per_epoch": 0.0, "checkpoint_load_ms": 12.0},
    "GPU": {"flops_per_second": 18e12, "bandwidth_bytes_per_second": 600e9,
            "gpu_launch_ms_per_epoch": 0.30, "checkpoint_load_ms": 4.5},
}
GQE_AI_MODEL = {
    "version": 1, "value_type": "model_assumption", "layers": 6, "d_model": 384, "attention_heads": 6,
    "base_parameters": 10_800_000, "precision": "FP16/BF16 with FP32 master weights",
    "adamw_flops_per_parameter": 12,
    # Read gradients(2) + master/moments(12); write weights(2) + master/moments(12).
    "adamw_bytes_per_parameter": 28,
    "pool_operations_per_entry": 1, "energy_reduction_operations_per_group": 1,
    "replay_sort_operations_per_comparison": 1,
    "pcie_bytes_per_second": 16e9, "sync_ms_per_epoch": 0.15,
    "replay_runtime_policy": "Conservative final occupancy min(R_cap,E*C) sorted each epoch",
    "minibatch_policy": "Requested B samples with replacement if the occupied replay buffer is smaller",
    "memory_policy": "Weights/optimizer/replay/pool persist; generation KV and training activations reuse transient space in serial phases",
    "emulation_group_model": "q rotation + q expectation amplitude operations per group; no shot-dependent full evolution",
}


def _time(value: float, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (float, int)) or not math.isfinite(value) or value < 0:
        raise ValueError(f"{name} must be finite and nonnegative")
    return value


def gqe_ai_resources(plan: GQEExecutionPlan, stage1_node: str, stage3_node: str) -> dict:
    """Exact supplied work formulas with versioned setup/optimizer/buffer proxies.

    Setup pool work uses a compute/bandwidth roofline; random initialization
    writes the low-precision weights once. Checkpoint loading is the supplied
    fixed reference. Replay buffers reserve capacity, even before filling.
    Peak memory is a requirement; no host RAM/VRAM capacity is invented.
    """
    plan = GQEExecutionPlan.model_validate(plan)
    if stage1_node not in GQE_AI_PROFILES or stage3_node not in GQE_AI_PROFILES:
        raise ValueError("GQE classical AI stages require CPU or GPU")
    p, q = plan.parameters, plan.n_qubits
    e, c, tokens, vocab = p.epochs, p.circuits_per_epoch, p.sequence_length, p.vocabulary_size
    parameters = 10_800_000 + vocab * 384
    weights, gradients, optimizer = 2 * parameters, 2 * parameters, 12 * parameters
    kv = 2 * 6 * 384 * 2 * c * tokens
    activations = p.minibatch_size * tokens * (6 * 384 * 8 + vocab * 4)
    replay_record_bytes = tokens * 4 + 16
    replay = p.replay_buffer_capacity * replay_record_bytes
    pool = vocab * q * 16
    occupied = min(p.replay_buffer_capacity, e * c)
    generate_epoch_flops = c * tokens * (2 * parameters + 4 * 6 * 384 * tokens)
    train_epoch_flops = p.gradient_steps_per_epoch * p.minibatch_size * tokens * (
        6 * parameters + 12 * 6 * 384 * tokens)
    optimizer_epoch_flops = p.gradient_steps_per_epoch * parameters * GQE_AI_MODEL["adamw_flops_per_parameter"]
    optimizer_epoch_bytes = p.gradient_steps_per_epoch * parameters * GQE_AI_MODEL["adamw_bytes_per_parameter"]
    pool_ops = vocab * q
    reduction_epoch_ops = c * p.pauli_measurement_groups
    replay_epoch_ops = occupied * math.log2(max(2, occupied))
    # Read/write occupied records for sorting, plus insertion of generated records.
    replay_epoch_bytes = (2 * occupied + c) * replay_record_bytes
    generator, trainer = GQE_AI_PROFILES[stage1_node], GQE_AI_PROFILES[stage3_node]
    pool_ms = 1000 * max(pool_ops / generator["flops_per_second"], pool / generator["bandwidth_bytes_per_second"])
    initialization_ms = 1000 * weights / generator["bandwidth_bytes_per_second"] if p.training_mode == "from_scratch" else 0.0
    checkpoint_ms = generator["checkpoint_load_ms"] if p.training_mode == "pretrained_finetune" else 0.0
    setup_ms = pool_ms + initialization_ms + checkpoint_ms
    generate_ms = 1000 * e * generate_epoch_flops / generator["flops_per_second"]
    training_ms = 1000 * e * train_epoch_flops / trainer["flops_per_second"]
    optimizer_ms = 1000 * e * max(optimizer_epoch_flops / trainer["flops_per_second"],
                                 optimizer_epoch_bytes / trainer["bandwidth_bytes_per_second"])
    reduction_ms = 1000 * e * reduction_epoch_ops / trainer["flops_per_second"]
    replay_ms = 1000 * e * max(replay_epoch_ops / trainer["flops_per_second"],
                              replay_epoch_bytes / trainer["bandwidth_bytes_per_second"])
    gen_launch_ms = e * generator["gpu_launch_ms_per_epoch"]
    train_launch_ms = e * trainer["gpu_launch_ms_per_epoch"]
    synchronization_bytes = 2 * parameters + c * tokens * 8 if stage1_node != stage3_node else 0
    sync_ms = e * (1000 * synchronization_bytes / GQE_AI_MODEL["pcie_bytes_per_second"]
                   + GQE_AI_MODEL["sync_ms_per_epoch"]) if synchronization_bytes else 0.0

    stage1_peak = weights + kv + pool
    stage3_peak = weights + gradients + optimizer + activations + replay
    if stage1_node == stage3_node:
        resident = weights + gradients + optimizer + replay + pool
        residents = {stage1_node: resident}
        peaks = {stage1_node: resident + max(kv, activations)}
    else:
        residents = {stage1_node: weights + pool, stage3_node: weights + gradients + optimizer + replay}
        peaks = {stage1_node: stage1_peak, stage3_node: stage3_peak}
    memory = {"weights_bytes": weights, "gradients_bytes": gradients,
              "optimizer_and_master_weights_bytes": optimizer, "inference_kv_cache_bytes": kv,
              "training_activations_and_logits_bytes": activations, "replay_buffer_bytes": replay,
              "operator_pool_bytes": pool, "stage1_peak_memory_bytes": stage1_peak,
              "stage3_peak_memory_bytes": stage3_peak, "shared_classical_device": stage1_node == stage3_node,
              "coexisting_device_peak_memory_bytes": peaks, "persistent_device_memory_bytes": residents,
              "memory_feasibility": "Not modeled; bytes are required capacity, not measured allocation"}
    historical_epochs = GQE_SCALES[q]["epochs"]
    offline_reference_ms = historical_epochs * ((training_ms + optimizer_ms + train_launch_ms) / e)
    return {
        "transformer_parameters": parameters, "ai_model_version": 1,
        "ai_model_provenance": dict(GQE_AI_MODEL), "memory": memory,
        "stage1": {"pool_construction_operations": pool_ops, "pool_construction_ms": pool_ms,
                   "initialization_ms": initialization_ms, "checkpoint_load_ms": checkpoint_ms,
                   "setup_ms": setup_ms, "generation_flops_per_epoch": generate_epoch_flops,
                   "generation_flops_total": e * generate_epoch_flops,
                   "generation_compute_ms": generate_ms, "compute_latency_ms": setup_ms + generate_ms,
                   "gpu_launch_overhead_ms": gen_launch_ms, "launch_transfer_overhead_ms": gen_launch_ms,
                   "latency_ms": setup_ms + generate_ms + gen_launch_ms,
                   "historical_offline_pretraining_reference": {
                       "latency_ms": offline_reference_ms if p.training_mode == "pretrained_finetune" else None,
                       "included_in_active_latency": False, "reference_training_epochs": historical_epochs,
                       "scope": "Illustrative offline train/optimizer reference; excludes QPU and circuit generation; not an observed prior run"}},
        "stage3": {"energy_reduction_operations_per_epoch": reduction_epoch_ops,
                   "energy_reduction_ms": reduction_ms, "replay_occupied_records": occupied,
                   "replay_sort_operations_per_epoch": replay_epoch_ops,
                   "replay_io_bytes_per_epoch": replay_epoch_bytes, "replay_buffer_management_ms": replay_ms,
                   "training_flops_per_epoch": train_epoch_flops, "training_flops_total": e * train_epoch_flops,
                   "optimizer_flops_per_epoch": optimizer_epoch_flops,
                   "optimizer_bytes_per_epoch": optimizer_epoch_bytes,
                   "training_compute_ms": training_ms, "optimizer_compute_ms": optimizer_ms,
                   "compute_latency_ms": math.fsum([reduction_ms, replay_ms, training_ms, optimizer_ms]),
                   "gpu_launch_overhead_ms": train_launch_ms,
                   "cross_device_sync_bytes_per_epoch": synchronization_bytes,
                   "cross_device_sync_bytes_total": e * synchronization_bytes,
                   "cross_device_transfer_ms": sync_ms,
                   "launch_transfer_overhead_ms": train_launch_ms + sync_ms,
                   "latency_ms": math.fsum([reduction_ms, replay_ms, training_ms, optimizer_ms, train_launch_ms, sync_ms])},
    }


def estimate_gqe_qpu(plan: GQEExecutionPlan, profile: QPUProfile, launch_overhead_ms: float) -> dict:
    """Multiply shots/launches, never per-shot resources or survival log terms."""
    plan = GQEExecutionPlan.model_validate(plan)
    launch_overhead_ms = _time(launch_overhead_ms, "launch_overhead_ms")
    counts = plan.multiplicities()
    estimated = estimate_qpu(plan.circuit_spec, profile, counts["total_shots"],
                             plan.parameters.epochs * launch_overhead_ms)
    return {**estimated, "execution_plan": {"model_version": 1, **counts},
            "launch_policy": "one_batch_per_epoch", "launch_count": plan.parameters.epochs if estimated["execution_feasible"] else 0,
            "uniform_resource_assumption": True, "survival_scope": "representative_per_shot",
            "qpu_io_included_in_latency": True, "io_state_prep_ms": 0.0,
            "compute_latency_ms": estimated["gate_execution_ms"], "circuit_spec": plan.circuit_spec.model_dump()}


def estimate_gqe_emulation(plan: GQEExecutionPlan, node: str, *,
                            stage1_ms: float = 0.0, stage3_ms: float = 0.0) -> dict:
    """E*C state preparations, G lightweight reductions, one reused statevector.

    Shots reuse each distribution, and groups reuse its premeasurement state.
    The amplitude-operation proxy is q rotations + q reductions per group.
    GPU emulation charges one launch per epoch. Host totals are charged once.
    """
    plan = GQEExecutionPlan.model_validate(plan)
    stage1_ms, stage3_ms = _time(stage1_ms, "stage1_ms"), _time(stage3_ms, "stage3_ms")
    spec, p = plan.circuit_spec, plan.parameters
    before_measurement = spec.model_copy(update={"depth": spec.depth - 1,
                                                "n_1q": spec.n_1q - spec.n_qubits, "n_meas": 0})
    preparation = estimate_classical(before_measurement, node)["circuit_emulation"]
    # Reuse the unchanged classical estimator's operation units for the group
    # proxy, rather than importing QPU durations or shot counts into emulation.
    group_spec = spec.model_copy(update={"depth": 1, "n_1q": spec.n_qubits, "n_2q": 0})
    group = estimate_classical(group_spec, node)["circuit_emulation"]
    feasible = preparation["feasible"] and group["feasible"]
    circuits = plan.multiplicities()["total_generated_circuits"]
    prepare_ms = circuits * preparation["compute_latency_ms"] if feasible else None
    group_ms = circuits * p.pauli_measurement_groups * group["compute_latency_ms"] if feasible else None
    compute = prepare_ms + group_ms if feasible else None
    launch_ms = p.epochs * GQE_AI_PROFILES[node]["gpu_launch_ms_per_epoch"] if feasible else 0.0
    kernel_ms = compute + launch_ms if feasible else None
    return {"circuit_emulation": {
        "name": "Classical GQE Circuit Emulation", "node": node, "feasible": feasible,
        "kernel_ms": kernel_ms, "total_ms": kernel_ms + stage1_ms + stage3_ms if feasible else None,
        "compute_latency_ms": compute, "state_preparation_compute_ms": prepare_ms,
        "measurement_groups_compute_ms": group_ms, "launch_transfer_overhead_ms": launch_ms,
        "state_preparations": circuits, "measurement_group_evaluations": circuits * p.pauli_measurement_groups,
        "logical_qubits": spec.n_qubits, "memory_required_bytes": preparation["memory_required_bytes"],
        "memory_budget_gib": preparation["memory_budget_gib"], "memory_budget_bytes": preparation["memory_budget_bytes"],
        "host_preprocessing_ms": stage1_ms, "host_postprocessing_ms": stage3_ms,
        "model": "Distinct circuit states, premeasurement reuse across groups, sequential peak RAM, no full evolution per shot",
    }, "native_algorithm": {"name": "Native Classical Algorithm", "node": node, "available": False,
                              "feasible": None, "kernel_ms": None, "total_ms": None,
                              "model": "Unavailable: transformer overhead is not a task-equivalent classical chemistry baseline"}}


def _host_stage(name: str, node: str, costs: dict, ai: dict) -> dict:
    return {"name": name, "node": node, "latency_ms": costs["latency_ms"], "status": "OPTIMAL",
            "output_summary": "Analytical GPT-QE cost projection; no model training, energy or convergence is computed.",
            "metrics": {**costs, "execution_feasible": node != "QPU", "routing_supported": node != "QPU",
                        "ai_model_version": 1, "transformer_parameters": ai["transformer_parameters"],
                        "ai_accelerator_profile": dict(GQE_AI_PROFILES[node if node != "QPU" else "CPU"]),
                        "ai_model_provenance": ai["ai_model_provenance"], "ai_memory": ai["memory"]}}


def build_gqe_pipeline(plan: GQEExecutionPlan, profile: QPUProfile, capacity: int,
                        routing: dict, launch_overhead_ms: float) -> dict:
    """Preflight an entire closed loop, then accumulate the serial stage costs."""
    plan = GQEExecutionPlan.model_validate(plan)
    if type(capacity) is not int or not 1 <= capacity <= 2_147_483_647:
        raise ValueError("Available qubits must be a positive int32")
    if set(routing) != {"stage_1_node", "stage_2_node", "stage_3_node"} or any(
            node not in ("CPU", "GPU", "QPU") for node in routing.values()):
        raise ValueError("Invalid GQE stage routing")
    first, middle, last = (routing[f"stage_{index}_node"] for index in (1, 2, 3))
    # Unsupported host placements retain planned CPU-reference diagnostics, but
    # fail preflight and do not charge E complete epochs of an impossible loop.
    ai = gqe_ai_resources(plan, first if first != "QPU" else "CPU", last if last != "QPU" else "CPU")
    pre = _host_stage("Molecular Operator Pool & Autoregressive Transformer Generation", first, ai["stage1"], ai)
    post = _host_stage("Energy Reduction, Replay Buffer & Logit-Matching Gradient Steps", last, ai["stage3"], ai)
    cpu_ai = gqe_ai_resources(plan, "CPU", "CPU")
    cpu_baselines = estimate_gqe_emulation(plan, "CPU", stage1_ms=cpu_ai["stage1"]["latency_ms"],
                                          stage3_ms=cpu_ai["stage3"]["latency_ms"])
    qpu = estimate_gqe_qpu(plan, execution_profile(profile, capacity), launch_overhead_ms)
    metrics = {"algorithm": "Generative Quantum Eigensolver / GPT-QE", "gqe_model_version": 1,
               "gqe_parameters": plan.parameters.model_dump(),
               "execution_plan": {"model_version": 1, **plan.multiplicities()},
               "schedule": "setup -> [generate -> evaluate -> update/train] * epochs (serial)",
               "qubits_required": plan.n_qubits, "minimum_qubits_required": plan.n_qubits,
               "circuit_spec": plan.circuit_spec.model_dump(), "routing_supported": True,
               "aer_executed": False, "model_scope": "Analytical uniform-resource and transformer cost assumptions; no circuits, energies or model updates are executed",
               "classical_baselines": cpu_baselines, "classical_cpu_baseline": cpu_baselines["circuit_emulation"]}
    if middle == "QPU":
        metrics.update(profile_metrics(profile, capacity))
        metrics.update(qpu)
        metrics.update(available_qubits=capacity, qubits_allocated=plan.n_qubits if qpu["execution_feasible"] else 0,
                       idle_qubits=capacity - plan.n_qubits if qpu["execution_feasible"] else capacity,
                       parallelization_tier="GQE uniform representative (fixed register width)", parallel_speedup_ceiling_reached=True)
        latency = qpu["latency_ms"]
        survival_pct = qpu["coherence_survival_pct"]
        status = "OPTIMAL" if survival_pct >= 70 else "WARNING" if survival_pct >= 35 else "CRITICAL_BOTTLENECK"
        metrics["coherence_status"] = {"OPTIMAL": "NOMINAL", "WARNING": "DEGRADED", "CRITICAL_BOTTLENECK": "EXCEEDED"}[status]
    else:
        estimates = estimate_gqe_emulation(plan, middle, stage1_ms=pre["latency_ms"], stage3_ms=post["latency_ms"])
        cost = estimates["circuit_emulation"]
        metrics.update(execution_feasible=cost["feasible"], selected_classical_baselines=estimates,
                       compute_latency_ms=cost["compute_latency_ms"] or 0.0,
                       launch_transfer_overhead_ms=cost["launch_transfer_overhead_ms"],
                       state_preparation_compute_ms=cost["state_preparation_compute_ms"],
                       measurement_groups_compute_ms=cost["measurement_groups_compute_ms"],
                       statevector_qubits=plan.n_qubits, statevector_memory_required_bytes=cost["memory_required_bytes"],
                       statevector_memory_budget_gib=cost["memory_budget_gib"],
                       statevector_memory_budget_bytes=cost["memory_budget_bytes"],
                       circuit_depth=plan.circuit_spec.depth, coherence_survival_pct=100.0, coherence_status="NOMINAL")
        latency, status = cost["kernel_ms"] or 0.0, "WARNING"
        # Persistent AI state coexists with emulation; transient KV/activations
        # are released between serial phases. Statevector RAM remains one vector.
        combined = dict(ai["memory"]["coexisting_device_peak_memory_bytes"])
        combined[middle] = max(combined.get(middle, 0), ai["memory"]["persistent_device_memory_bytes"].get(middle, 0)
                               + cost["memory_required_bytes"])
        metrics["coexisting_device_peak_including_emulation_bytes"] = combined
    kernel = {"name": "Iterative Quantum Energy Evaluation Batches", "node": middle,
              "latency_ms": latency, "status": status,
              "output_summary": "Uniform representative-shot survival; evaluation multiplicity changes time, not per-shot fidelity.",
              "metrics": metrics}
    stages = {"stage_1_classical_pre": pre, "stage_2_quantum_kernel": kernel, "stage_3_classical_post": post}
    root = next((key for key, stage in stages.items() if not stage["metrics"]["execution_feasible"]), None)
    if root is not None:
        source = stages[root]
        reason = (f"UNSUPPORTED QPU ROUTING ({source['name']})" if not source["metrics"]["routing_supported"] else
                  "INSUFFICIENT QPU QUBIT CAPACITY" if middle == "QPU" else f"{middle} STATEVECTOR MEMORY LIMIT")
        for stage in stages.values():
            stage.update(latency_ms=0.0, status="CRITICAL_BOTTLENECK", output_summary=f"PREFLIGHT BLOCKED: {reason}; no epoch loop executed.")
            m = stage["metrics"]
            m.update(execution_feasible=False, blocking_reason=reason)
            for key in tuple(m):
                if key.endswith("_ms") and key not in ("historical_offline_pretraining_reference",):
                    m[key] = 0.0
        if middle == "QPU":
            metrics.update(qubits_allocated=0, idle_qubits=capacity, launch_count=0,
                           coherence_survival=0.0, coherence_survival_pct=0.0, coherence_survival_best=0.0,
                           coherence_survival_worst=0.0, coherence_log_survival=None, log_survival_terms=None,
                           coherence_status="EXCEEDED")
    qpu_latency = qpu["latency_ms"] if qpu["execution_feasible"] else None
    ratio = (pre["latency_ms"] + post["latency_ms"]) / qpu_latency if root is None and qpu_latency else None
    post["metrics"].update(ai_to_qpu_latency_ratio=ratio,
        bottleneck_regime=("classical_ai_bound" if ratio >= 1 else "qpu_evaluation_bound") if ratio is not None else "unavailable",
        qpu_evaluation_latency_ms=qpu_latency,
        crossover_basis="Accumulated Stage 1 plus Stage 3 latency divided by modeled QPU evaluation latency")
    metrics["qpu_evaluation_comparison"] = {"comparison_only": middle != "QPU" or root is not None, "latency_ms": qpu_latency,
        "coherence_survival_pct": qpu["coherence_survival_pct"], "survival_scope": "representative_per_shot"}
    if root is not None:
        bottleneck = reason
    elif middle != "QPU":
        bottleneck = f"{middle} STATEVECTOR EMULATION OVERHEAD (GQE representative circuits)"
    elif status != "OPTIMAL":
        bottleneck = "CATASTROPHIC QPU DECOHERENCE" if status == "CRITICAL_BOTTLENECK" else "QPU COHERENCE BUDGET DEGRADED"
    else:
        bottleneck = "CLASSICAL AI TRAINING AND GENERATION" if ratio >= 1 else "QPU ENERGY EVALUATION"
    return {"workload_id": "gqe", "workload_name": "Generative Quantum Eigensolver / GPT-QE",
            "scale_label": GQE_SCALES[plan.n_qubits]["label"], "execution_mode": "NISQ_ANALYTICAL_PROFILER",
            "primary_bottleneck": bottleneck, "stages": stages}

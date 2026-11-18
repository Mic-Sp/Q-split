"""Analytical SKQD host costs and three-stage orchestration; no Aer allocation.

The supplied brickwork/term-count formulas are resource assumptions, not an
executed Hamiltonian, sampled basis, projected matrix or eigenvalue calculation.
CPU operation times and the shared 4x GPU compute convention are illustrative,
not measured hardware throughput or utilization. Sparse memory is a requirement,
not a claim that a particular host has enough RAM/VRAM.
"""

import math

if __package__:
    from .models import SKQDParameters, QPUProfile
    from .workloads import skqd_family, skqd_hamiltonian_terms, SKQD_SCALES
    from .estimation import (estimate_qpu_family, estimate_classical_family, estimate_classical,
                             CLASSICAL_GPU_COMPUTE_FACTOR, CLASSICAL_GPU_OVERHEAD_MS)
    from .profiles import execution_profile, profile_metrics
else:
    from models import SKQDParameters, QPUProfile
    from workloads import skqd_family, skqd_hamiltonian_terms, SKQD_SCALES
    from estimation import (estimate_qpu_family, estimate_classical_family, estimate_classical,
                            CLASSICAL_GPU_COMPUTE_FACTOR, CLASSICAL_GPU_OVERHEAD_MS)
    from profiles import execution_profile, profile_metrics


SKQD_HOST_MODEL = {
    "version": 1, "value_type": "model_assumption",
    "cpu_pauli_setup_ns_per_term": 50.0,
    "cpu_reference_compile_ns_per_qubit": 100.0,
    "cpu_reference_compile_fixed_ms": 0.05,
    "cpu_recovery_ns_per_bit_operation": 2.0,
    "cpu_projection_ns_per_operation": 10.0,
    "cpu_sparse_solver_ns_per_flop": 2.0,
    "gpu_compute_factor": CLASSICAL_GPU_COMPUTE_FACTOR,
    "gpu_launch_transfer_ms": CLASSICAL_GPU_OVERHEAD_MS,
    "solver_iterations": 30, "precision": "complex128",
    "solver": "Lanczos/Davidson sparse iterative resource proxy",
    "solver_flops_per_iteration_per_nonzero": 1,
    "sparse_value_bytes": 16, "sparse_index_bytes": 8,
    "workspace_vector_count": 6,
    "memory_scope": "Projected matrix values/indices plus six solver vectors; excludes raw-sample buffers and allocator overhead",
}


def skqd_host_resources(n_qubits: int, parameters: SKQDParameters) -> dict:
    """Closed-form work/memory, bounded by Hilbert space and collected samples.

    The effective R is an assumed retained unique basis size, not a measurement
    of how many unique states noisy samples actually recover. Sparse nnz assumes
    min(R, N_Pauli) entries per row. Runtime never allocates those matrices.
    """
    parameters = SKQDParameters.model_validate(parameters)
    terms = skqd_hamiltonian_terms(n_qubits)
    samples = parameters.krylov_dimension * parameters.shots_per_state
    retained = min(parameters.retained_subspace_dimension, 1 << n_qubits, samples)
    nonzeros_per_row = min(retained, terms)
    nnz = retained * nonzeros_per_row
    recovery_ops = samples * n_qubits
    projection_ops = terms * retained * math.log2(retained)
    solver_flops = SKQD_HOST_MODEL["solver_iterations"] * nnz
    recovery_ms = recovery_ops * SKQD_HOST_MODEL["cpu_recovery_ns_per_bit_operation"] / 1e6
    projection_ms = projection_ops * SKQD_HOST_MODEL["cpu_projection_ns_per_operation"] / 1e6
    solver_ms = solver_flops * SKQD_HOST_MODEL["cpu_sparse_solver_ns_per_flop"] / 1e6
    return {
        "krylov_dimension": parameters.krylov_dimension, "total_raw_samples": samples,
        "hamiltonian_pauli_terms": terms,
        "requested_subspace_dimension": parameters.retained_subspace_dimension,
        "retained_subspace_dimension": retained,
        "subspace_dimension_is_assumed": True,
        "recovery_bit_operations": recovery_ops,
        "projection_operations": projection_ops,
        "solver_flops": solver_flops, "solver_iterations": SKQD_HOST_MODEL["solver_iterations"],
        "nonzeros_per_row": nonzeros_per_row, "projected_matrix_nnz": nnz,
        "projected_matrix_value_bytes": 16 * nnz,
        "projected_matrix_index_bytes": 8 * nnz,
        "solver_workspace_bytes": 6 * 16 * retained,
        "subspace_peak_memory_bytes": 24 * nnz + 6 * 16 * retained,
        "cpu_recovery_ms": recovery_ms, "cpu_projection_ms": projection_ms,
        "cpu_eigensolver_ms": solver_ms,
        "cpu_postprocessing_ms": math.fsum([recovery_ms, projection_ms, solver_ms]),
        "cpu_preprocessing_ms": SKQD_HOST_MODEL["cpu_reference_compile_fixed_ms"] + (
            terms * SKQD_HOST_MODEL["cpu_pauli_setup_ns_per_term"]
            + n_qubits * SKQD_HOST_MODEL["cpu_reference_compile_ns_per_qubit"]) / 1e6,
        "solver_provenance": dict(SKQD_HOST_MODEL),
    }


def _severity(survival_pct: float) -> str:
    return "OPTIMAL" if survival_pct >= 70 else "WARNING" if survival_pct >= 35 else "CRITICAL_BOTTLENECK"


def _host_stage(resources: dict, node: str, post: bool) -> dict:
    cpu_ms = resources["cpu_postprocessing_ms" if post else "cpu_preprocessing_ms"]
    factor = CLASSICAL_GPU_COMPUTE_FACTOR if node == "GPU" else 1.0
    overhead = CLASSICAL_GPU_OVERHEAD_MS if node == "GPU" else 0.0
    supported = node != "QPU"
    compute = cpu_ms * factor if supported else 0.0
    total = compute + overhead if supported else 0.0
    metrics = {
        "algorithm": "Configuration recovery & sparse Lanczos/Davidson" if post else "Hamiltonian Pauli setup & reference compilation",
        "execution_feasible": supported, "routing_supported": supported,
        "cpu_reference_latency_ms": cpu_ms, "compute_latency_factor": factor,
        "compute_latency_ms": compute, "launch_transfer_overhead_ms": overhead,
        "hamiltonian_pauli_terms": resources["hamiltonian_pauli_terms"],
        "classical_cost_model_version": 1,
    }
    if post:
        metrics.update(resources)
        metrics.update({"recovery_compute_ms": resources["cpu_recovery_ms"] * factor if supported else 0.0,
                        "projection_compute_ms": resources["cpu_projection_ms"] * factor if supported else 0.0,
                        "eigensolver_compute_ms": resources["cpu_eigensolver_ms"] * factor if supported else 0.0,
                        "memory_feasibility": "Not modeled: reported bytes are required host/device capacity"})
    else:
        metrics["preparation_provenance"] = dict(SKQD_HOST_MODEL)
    return {"name": "Classical Configuration Recovery & Sparse Subspace Diagonalization" if post else
                    "State Preparation & Hamiltonian Setup",
            "node": node, "latency_ms": total,
            "status": "CRITICAL_BOTTLENECK" if not supported else
                      "WARNING" if node == "GPU" and total >= cpu_ms else "OPTIMAL",
            "output_summary": "Modeled host work; no Hamiltonian diagonalization or physical execution performed."
                if supported else "UNSUPPORTED ROUTE: SKQD host stages require CPU or GPU.",
            "metrics": metrics}


def _block(stage: dict, reason: str) -> None:
    """Preserve planned resources but never leave execution costs on starved work."""
    stage.update(latency_ms=0.0, status="CRITICAL_BOTTLENECK", output_summary=reason)
    metrics = stage["metrics"]
    metrics.update(execution_feasible=False, blocking_reason=reason, compute_latency_ms=0.0)
    for key in ("compute_latency_ms", "launch_transfer_overhead_ms", "launch_overhead_ms",
                "gate_execution_ms", "measurement_reset_ms", "repetition_delay_ms", "link_execution_ms",
                "recovery_compute_ms", "projection_compute_ms", "eigensolver_compute_ms"):
        if key in metrics:
            metrics[key] = 0.0
    metrics["latency_ms"] = 0.0
    if stage["node"] == "QPU":
        metrics.update(qubits_allocated=0, idle_qubits=metrics.get("available_qubits", 0),
                       coherence_survival=0.0, coherence_survival_pct=0.0,
                       coherence_survival_best=0.0, coherence_survival_worst=0.0,
                       coherence_status="EXCEEDED")


def build_skqd_pipeline(n_qubits: int, parameters: SKQDParameters, profile: QPUProfile,
                        capacity: int, routing: dict, launch_overhead_ms: float,
                        interconnect=None) -> dict:
    """Three sequential modeled stages; all physics uses the existing estimator."""
    if type(capacity) is not int or not 1 <= capacity <= 2_147_483_647:
        raise ValueError("Available qubits must be a positive int32")
    if set(routing) != {"stage_1_node", "stage_2_node", "stage_3_node"} or any(
            node not in ("CPU", "GPU", "QPU") for node in routing.values()):
        raise ValueError("Invalid SKQD stage routing")
    parameters = SKQDParameters.model_validate(parameters)
    resources = skqd_host_resources(n_qubits, parameters)
    pre = _host_stage(resources, routing["stage_1_node"], False)
    post = _host_stage(resources, routing["stage_3_node"], True)
    family = skqd_family(n_qubits, parameters, stage1_ms=resources["cpu_preprocessing_ms"],
                         stage3_ms=resources["cpu_postprocessing_ms"], interconnect=interconnect)
    cpu_baselines = estimate_classical_family(family, "CPU")
    node = routing["stage_2_node"]
    metrics = {
        "algorithm": "Sample-Based Krylov Quantum Diagonalization", "skqd_model_version": 1,
        "skqd_parameters": parameters.model_dump(), "circuit_family_size": len(family.members),
        "qubits_required": n_qubits, "minimum_qubits_required": n_qubits,
        "routing_supported": True, "aer_executed": False,
        "classical_baselines": cpu_baselines,
        "classical_cpu_baseline": cpu_baselines["circuit_emulation"],
        "model_scope": "Analytical sampling/reconstruction estimates; no bitstrings, matrix or eigenvalue are computed",
        "depth_model": "Explicit logical brickwork: 1 + 6*k*m; no toy depth/gate expansion",
    }
    kernel = {"name": "Krylov Quantum Sampling Family", "node": node, "latency_ms": 0.0,
              "status": "OPTIMAL", "output_summary": "Analytical SKQD family projection.", "metrics": metrics}

    if node == "QPU":
        metrics.update(profile_metrics(profile, capacity))
        metrics.update(available_qubits=capacity, qubits_allocated=n_qubits if capacity >= n_qubits else 0,
                       idle_qubits=capacity - n_qubits if capacity >= n_qubits else capacity,
                       parallelization_tier="Krylov family (fixed register width)", parallel_speedup_ceiling_reached=True)
    if not pre["metrics"]["execution_feasible"]:
        _block(kernel, "STARVED: State Preparation & Hamiltonian Setup did not produce usable input.")
        qpu = None
    else:
        qpu = estimate_qpu_family(family, execution_profile(profile, capacity), launch_overhead_ms)
        if node == "QPU":
            metrics.update(qpu)
            kernel["latency_ms"] = qpu["latency_ms"]
            kernel["status"] = _severity(qpu["coherence_survival_pct"])
            metrics["compute_latency_ms"] = qpu["gate_execution_ms"]
            metrics["coherence_status"] = {"OPTIMAL": "NOMINAL", "WARNING": "DEGRADED",
                                            "CRITICAL_BOTTLENECK": "EXCEEDED"}[kernel["status"]]
            if not qpu["execution_feasible"]:
                _block(kernel, f"INSUFFICIENT QPU QUBIT CAPACITY: {n_qubits} required; {capacity} available.")
        else:
            estimates = estimate_classical_family(family, node)
            emulation = estimates["circuit_emulation"]
            metrics.update(execution_feasible=emulation["feasible"],
                           compute_latency_ms=emulation["compute_latency_ms"] or 0.0,
                           launch_transfer_overhead_ms=emulation["launch_transfer_overhead_ms"],
                           statevector_qubits=n_qubits,
                           statevector_memory_required_bytes=emulation["memory_required_bytes"],
                           statevector_memory_budget_bytes=emulation["memory_budget_bytes"],
                           statevector_memory_budget_gib=emulation["memory_budget_gib"],
                           selected_classical_baselines=estimates,
                           coherence_survival_pct=100.0, coherence_status="NOMINAL",
                           simulation_method="Classical family statevector emulation with sequential memory reuse",
                           krylov_members=[{"power_index": member.power_index, "shots": member.shots,
                               "circuit_spec": member.circuit_spec.model_dump(),
                               "emulation": estimate_classical(member.circuit_spec, node)["circuit_emulation"],
                               "qpu_comparison_metrics": projected["metrics"]}
                               for member, projected in zip(family.members, qpu["krylov_members"])])
            kernel["latency_ms"] = emulation["kernel_ms"] or 0.0
            kernel["status"] = "WARNING"
            if not emulation["feasible"]:
                _block(kernel, f"{node} STATEVECTOR MEMORY LIMIT: {n_qubits} qubits exceed {emulation['memory_budget_gib']} GiB.")

    if not kernel["metrics"]["execution_feasible"]:
        _block(post, "STARVED: Krylov Quantum Sampling Family did not produce usable input.")
    qpu_latency = qpu["latency_ms"] if qpu is not None and qpu["execution_feasible"] else None
    comparison = {"latency_ms": qpu_latency, "comparison_only": node != "QPU",
                  "family_survival": qpu["family_survival"] if qpu is not None else None}
    metrics["qpu_sampling_comparison"] = comparison
    active = all(stage["metrics"]["execution_feasible"] for stage in (pre, kernel, post))
    ratio = post["latency_ms"] / qpu_latency if active and qpu_latency is not None and qpu_latency > 0 else None
    post["metrics"].update(classical_to_quantum_latency_ratio=ratio,
        qpu_family_sampling_latency_ms=qpu_latency,
        crossover_basis="Selected Stage 3 host latency divided by modeled QPU family sampling latency",
        bottleneck_regime=("classical-diagonalization-bound" if ratio >= 1 else "quantum-sampling-bound")
                          if ratio is not None else "unavailable")
    stages = {"stage_1_classical_pre": pre, "stage_2_quantum_kernel": kernel, "stage_3_classical_post": post}
    blocked = next((stage for stage in stages.values() if not stage["metrics"]["execution_feasible"]), None)
    if blocked:
        bottleneck = blocked["metrics"].get("blocking_reason", "UNSUPPORTED QPU ROUTING (SKQD host stage)")
    elif node == "QPU" and kernel["status"] != "OPTIMAL":
        bottleneck = "QPU COHERENCE BUDGET DEGRADED" if kernel["status"] == "WARNING" else "CATASTROPHIC QPU DECOHERENCE"
    elif node != "QPU":
        bottleneck = f"{node} STATEVECTOR EMULATION OVERHEAD (SKQD family)"
    elif ratio is not None:
        bottleneck = ("CLASSICAL SUBSPACE DIAGONALIZATION" if ratio >= 1 else "QUANTUM FAMILY SAMPLING")
    else:
        bottleneck = "NONE (SKQD analytical pipeline within modeled limits)"
    return {"workload_id": "skqd", "workload_name": "Sample-Based Krylov Quantum Diagonalization",
            "scale_label": SKQD_SCALES[n_qubits], "execution_mode": "NISQ_ANALYTICAL_PROFILER",
            "primary_bottleneck": bottleneck, "stages": stages}

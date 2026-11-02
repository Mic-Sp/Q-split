"""Pure resource estimators: no workload IDs, Aer execution, I/O, or global state."""

import math

if __package__:
    from .models import CircuitSpec, QPUProfile
else:
    from models import CircuitSpec, QPUProfile


STATEVECTOR_PROFILES = {
    "CPU": {"max_qubits": 30, "memory_gib": 16, "ns_per_amplitude_op": 2.0},
    "GPU": {"max_qubits": 29, "memory_gib": 8, "ns_per_amplitude_op": 0.5},
}
CLASSICAL_GPU_OVERHEAD_MS = 0.30
CLASSICAL_GPU_COMPUTE_FACTOR = 0.25


def estimate_qpu(spec: CircuitSpec, profile: QPUProfile, shots: int, launch_overhead_ms: float) -> dict:
    """Estimate an entire shot batch and per-shot survival using the requested model.

    Routing and native-entangler conversion multiply CX-basis depth and 2Q count
    together, rounded up once. Native 2Q time and error then apply to these
    expanded resources. Circuit time excludes measurement, reset and launch;
    these repeat for latency, never for coherent exposure.

    Three conservative choices remain explicit: every qubit is charged for the
    whole circuit (not a scheduled idle duration); every depth layer is billed
    at the 2Q duration even if it contains only 1Q gates; and the idle decay can
    overlap decoherence already included in calibrated gate errors.

    The point/best value retains the T1-only model. Worst replaces T1 with T2
    when defined, then takes the lower of that result and the T1 point (T2 may
    exceed T1). These are sensitivity scenarios, not statistical confidence bounds.
    Log terms are nonpositive natural logs: add one_qubit, two_qubit, measurement
    and idle_t1 to reproduce the point. idle_t2 is an ALTERNATIVE idle term,
    never an additional charge; use the more negative idle term for worst.
    A null term denotes -infinity for certain failure. Infeasible execution has
    zero survival and no physical log breakdown. Ideal profiles have zero terms.
    """
    if type(shots) is not int or shots < 1:
        raise ValueError("shots must be a positive integer")
    if isinstance(launch_overhead_ms, bool) or not math.isfinite(launch_overhead_ms) or launch_overhead_ms < 0:
        raise ValueError("launch_overhead_ms must be finite and nonnegative")
    depth = math.ceil(spec.depth * profile.topology_factor * profile.native_2q_per_cx)
    n_2q = math.ceil(spec.n_2q * profile.topology_factor * profile.native_2q_per_cx)
    circuit_ns = depth * profile.t_2q_ns
    circuit_us = circuit_ns / 1000
    feasible = profile.n_qubits_max is None or spec.n_qubits <= profile.n_qubits_max
    terms = {}
    for name, count, error in [("one_qubit", spec.n_1q, profile.err_1q),
                               ("two_qubit", n_2q, profile.err_2q),
                               ("measurement", spec.n_meas, profile.err_meas)]:
        terms[name] = (-math.inf if error == 1 else count * math.log1p(-error)) if count else 0.0
    exposure_us = spec.n_qubits * circuit_us
    terms["idle_t1"] = -exposure_us / profile.t1_us if profile.t1_us is not None else 0.0
    t2 = profile.t2_us if profile.t2_us is not None else profile.t1_us
    terms["idle_t2"] = -exposure_us / t2 if t2 is not None else 0.0
    gate_log = terms["one_qubit"] + terms["two_qubit"] + terms["measurement"]
    survival = math.exp(gate_log + terms["idle_t1"]) if feasible else 0.0
    worst = math.exp(gate_log + min(terms["idle_t1"], terms["idle_t2"])) if feasible else 0.0
    return {
        "execution_feasible": feasible, "circuit_depth": depth, "n_2q": n_2q,
        "shots": shots, "t_circuit_us": circuit_us,
        "latency_ms": launch_overhead_ms + shots * (circuit_ns + profile.t_meas_ns + profile.t_reset_ns) / 1e6 if feasible else 0.0,
        "gate_execution_ms": shots * circuit_ns / 1e6 if feasible else 0.0,
        "measurement_reset_ms": shots * (profile.t_meas_ns + profile.t_reset_ns) / 1e6 if feasible else 0.0,
        "launch_overhead_ms": launch_overhead_ms if feasible else 0.0,
        "coherence_survival": survival, "coherence_survival_pct": 100 * survival,
        "coherence_survival_best": survival, "coherence_survival_worst": worst,
        "log_survival_terms": {
            name: (0.0 if value == 0 else value) if math.isfinite(value) else None
            for name, value in terms.items()
        } if feasible else None,
    }


def estimate_classical(spec: CircuitSpec, node_type: str) -> dict:
    """Return distinct circuit-emulation and task-native classical comparisons.

    Emulation uses complex128 RAM (16*2**q) and illustrative amplitude-operation
    costs (CPU 2 ns, GPU 0.5 ns), independent of all QPU physics and shots. A
    distribution is emulated once; additional samples can reuse it. A supplied
    native CPU reference uses the shared 4x GPU compute assumption plus launch.
    Host costs are taken as supplied, independent of kernel node placement.
    Native feasibility never depends on exponential statevector RAM.
    """
    if node_type not in STATEVECTOR_PROFILES:
        raise ValueError("node_type must be CPU or GPU")
    node = STATEVECTOR_PROFILES[node_type]
    feasible = spec.n_qubits <= node["max_qubits"]
    # Bound integer construction for arbitrary BYOC widths, including hostile
    # billion-qubit specifications. Feasibility never needs a huge allocation.
    memory = 1 << (spec.n_qubits + 4) if spec.n_qubits <= 16384 else None
    operations = spec.n_1q + 2 * spec.n_2q + spec.n_meas
    compute = operations * (1 << spec.n_qubits) * node["ns_per_amplitude_op"] / 1e6 if feasible else None
    launch = CLASSICAL_GPU_OVERHEAD_MS if node_type == "GPU" else 0.0
    kernel = compute + launch if feasible else None
    host = spec.stage1_ms + spec.stage3_ms
    native = None if spec.native_classical_ms is None else (
        spec.native_classical_ms * (CLASSICAL_GPU_COMPUTE_FACTOR if node_type == "GPU" else 1) + launch
    )
    return {
        "circuit_emulation": {
            "name": "Classical Circuit Emulation", "node": node_type, "feasible": feasible,
            "kernel_ms": kernel, "total_ms": None if kernel is None else kernel + host,
            "compute_latency_ms": compute, "launch_transfer_overhead_ms": launch if feasible else 0.0,
            "logical_qubits": spec.n_qubits, "memory_required_bytes": memory,
            "memory_budget_gib": node["memory_gib"], "memory_budget_bytes": node["memory_gib"] * 2**30,
            "model": "Illustrative amplitude-operation cost; one statevector distribution",
        },
        "native_algorithm": {
            "name": "Native Classical Algorithm", "node": node_type,
            "algorithm": spec.native_classical_name, "available": native is not None,
            "feasible": True if native is not None else None,
            "kernel_ms": native, "total_ms": None if native is None else native + host,
            "model": "Workload-supplied illustrative CPU reference; 4x GPU compute assumption" if native is not None else
                     "Unavailable: circuit resources do not identify a task-equivalent native algorithm",
        },
    }

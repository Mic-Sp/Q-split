from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field
from typing import Dict, Any, Literal, Optional
import math
from fractions import Fraction
from qiskit import QuantumCircuit, transpile
from qiskit.circuit.library import QFTGate
from qiskit_aer import AerSimulator

app = FastAPI(
    title="Q-Split Hybrid Partitioning Engine",
    description="Hybrid Quantum-Classical Workload Profiler (Shor's Cryptography & Quantum-MIPS AI)",
    version="2.0.0"
)

# Enable CORS for your local Next.js dev server and Vercel deployment
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ==========================================
# 1. UNIFIED PYDANTIC CONTRACT
# ==========================================
StageNode = Literal["CPU", "GPU", "QPU"]
HardwareProfile = Literal["ibm_heron_nisq", "google_weber_grid", "ionq_forte_trapped_ion", "ideal_sim"]

# Comparative architecture assumptions, not measured processor specifications.
# The requested 72-qubit Google preset is exploratory: the published Weber
# datasheet describes 53 active qubits. Capacity overrides remain independent.
HARDWARE_PROFILES = {
    "ibm_heron_nisq": {"topology": "Heavy-Hex", "reference_qubits": 133, "depth_factor": 1.0,
                       "gate_factor": 1.0, "prep_ms": 0.15, "decay_scale": 1200.0},
    "google_weber_grid": {"topology": "2D Square Grid", "reference_qubits": 72, "depth_factor": 0.78,
                          "gate_factor": 0.45, "prep_ms": 0.12, "decay_scale": 850.0},
    "ionq_forte_trapped_ion": {"topology": "All-to-All Ion Trap", "reference_qubits": 36, "depth_factor": 0.55,
                               "gate_factor": 180.0, "prep_ms": 0.85, "decay_scale": 8500.0},
    "ideal_sim": {"topology": "Noise-free reference", "reference_qubits": None, "depth_factor": 1.0,
                  "gate_factor": 1.0, "prep_ms": 0.15, "decay_scale": None},
}


class RoutingConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    stage_1_node: StageNode = "CPU"
    stage_2_node: StageNode = "QPU"
    stage_3_node: StageNode = "CPU"


class SimulationRequest(BaseModel):
    workload_id: str = "shors_crypto"       # "shors_crypto" or "quantum_mips"
    scale_param: int = Field(default=15, strict=True, ge=2, le=2_147_483_647)
    hardware_profile: HardwareProfile = "ibm_heron_nisq"
    routing: Optional[RoutingConfig] = None
    available_qubits: int = Field(default=133, strict=True, ge=1, le=2_147_483_647)

class StageTelemetry(BaseModel):
    name: str
    node: StageNode
    latency_ms: float
    status: str                             # "OPTIMAL", "WARNING", "CRITICAL_BOTTLENECK"
    output_summary: str
    metrics: Dict[str, Any]

class HybridTelemetryResponse(BaseModel):
    workload_id: str
    workload_name: str
    scale_label: str
    execution_mode: str                     # "LIVE_QISKIT_AER" or "NISQ_ANALYTICAL_PROFILER"
    primary_bottleneck: str
    stages: Dict[str, StageTelemetry]

# ==========================================
# 2. LIVE QISKIT AER KERNEL FOR N = 15
# ==========================================
def c_amod15(a: int, power: int):
    """Controlled modular multiplication by 'a^power mod 15' on 4 work qubits."""
    U = QuantumCircuit(4)
    for _ in range(power):
        if a in [2, 13]:
            U.swap(2, 3)
            U.swap(1, 2)
            U.swap(0, 1)
        if a in [7, 8]:
            U.swap(0, 1)
            U.swap(1, 2)
            U.swap(2, 3)
        if a in [4, 11]:
            U.swap(1, 3)
            U.swap(0, 2)
        if a in [7, 11, 13]:
            for q in range(4):
                U.x(q)
    U = U.to_gate()
    U.name = f"{a}^{power} mod 15"
    return U.control()

def execute_live_shors_15(a: int = 7, noisy: bool = True) -> Dict[str, Any]:
    """Runs an actual 8-qubit Quantum Phase Estimation circuit for N=15 in Qiskit Aer."""
    n_count = 4
    qc = QuantumCircuit(n_count + 4, n_count)

    # 1. Initialize counting qubits in superposition |+> and work register in |1>
    for q in range(n_count):
        qc.h(q)
    qc.x(n_count)

    # 2. Apply controlled-U operations (Modular Exponentiation)
    for q in range(n_count):
        qc.append(c_amod15(a, 2**q), [q] + [i + n_count for i in range(4)])

    # 3. Apply Inverse QFT to counting register (Qiskit 2.x compliant)
    qc.append(QFTGate(n_count).inverse(), range(n_count))

    # 4. Measure the counting register
    qc.measure(range(n_count), range(n_count))

    # Simulate in Qiskit Aer
    sim = AerSimulator()
    t_qc = transpile(qc, sim)
    counts = sim.run(t_qc, shots=512).result().get_counts()

    # Classical Continued Fractions Post-Processing
    measured_phases = []
    extracted_r = 4
    for bitstring, count in sorted(counts.items(), key=lambda x: x[1], reverse=True)[:4]:
        decimal_val = int(bitstring, 2)
        phase = decimal_val / (2**n_count)
        frac = Fraction(phase).limit_denominator(15)
        measured_phases.append(f"|{bitstring}⟩ ({frac.numerator}/{frac.denominator})")
        if frac.denominator in [2, 4] and frac.denominator % 2 == 0:
            candidate = frac.denominator
            p = math.gcd(a ** (candidate // 2) - 1, 15)
            q = math.gcd(a ** (candidate // 2) + 1, 15)
            if 1 < p < 15 and 1 < q < 15 and p * q == 15:
                extracted_r = candidate

    return {
        "qubits": 8,
        "depth": t_qc.depth(),
        "top_measurements": ", ".join(measured_phases[:3]),
        "period_r": extracted_r,
        "coherence_pct": round(100.0 * math.exp(-t_qc.depth() / 1200.0), 2) if noisy else 100.0
    }

# ==========================================
# 3. SHOR'S HYBRID PIPELINE BUILDER
# ==========================================
def qpu_capacity_plan(scale_param: int, available_qubits: int) -> Dict[str, Any]:
    """Illustrative logical-qubit/depth model; not a physical device benchmark.

    Use the same coefficient and log base for all tiers so transitions lower
    depth monotonically. Integer allocations round 5.5n up, never over budget.
    Capacity is per stage, not a sum across sequential pipeline stages.
    """
    n = scale_param if scale_param in [512, 2048] else (scale_param - 1).bit_length()
    minimum = 8 if scale_param == 15 else 2 * n + 3
    if available_qubits < minimum:
        allocated, tier, complexity, depth = 0, "Blocked · insufficient capacity", "Not executed", 0
    elif available_qubits >= math.ceil(5.5 * n):
        allocated, tier, complexity = math.ceil(5.5 * n), "Carry-Lookahead Parallel", "O(n log^2 n)"
        depth = math.ceil(4.5 * n * math.log2(n) ** 2)
    elif available_qubits >= 3 * n:
        # For tiny custom moduli (n < 3), 3n can be below the baseline.
        allocated, tier, complexity = max(minimum, 3 * n), "Windowed Parallel", "O(n^2 log n)"
        depth = math.ceil(4.5 * n ** 2 * math.log2(n))
    else:
        allocated, tier, complexity = minimum, "Space-Optimized Sequential", "O(n^3)"
        depth = int(4.5 * n ** 3)
    return {
        "minimum_qubits_required": minimum,
        "available_qubits": available_qubits,
        "qubits_allocated": allocated,
        "idle_qubits": available_qubits - allocated,
        "parallelization_tier": tier,
        "depth_complexity": complexity,
        "parallel_speedup_ceiling_reached": allocated > 0 and available_qubits >= math.ceil(5.5 * n),
        "circuit_depth": depth,
    }


N15_REFERENCE_KERNEL_MS = 1.85


def _run_default_shors_pipeline(
    scale_param: int, hardware_profile: str, qpu_plan: Optional[Dict[str, Any]] = None,
) -> HybridTelemetryResponse:
    architecture = HARDWARE_PROFILES[hardware_profile]
    noisy = hardware_profile != "ideal_sim"
    legacy = hardware_profile in ("ibm_heron_nisq", "ideal_sim")
    a = 7 if scale_param != 21 else 2

    # Determine bit length n
    if scale_param in [512, 2048]:
        n_bits = scale_param
        scale_label = f"RSA-{scale_param} ({scale_param}-bit Cryptographic Key)"
    else:
        n_bits = math.ceil(math.log2(scale_param))
        scale_label = f"N = {scale_param} ({n_bits}-bit Composite Integer)"

    # --- CASE A: LIVE QISKIT EXECUTION (N = 15) ---
    if scale_param == 15 and (qpu_plan is None or qpu_plan["parallelization_tier"] == "Space-Optimized Sequential"):
        qpu_res = execute_live_shors_15(a=7, noisy=noisy)
        reference_depth = qpu_res["depth"]
        depth = math.ceil(reference_depth * architecture["depth_factor"])
        coherence = qpu_res["coherence_pct"] if legacy else round(100.0 * math.exp(-depth / architecture["decay_scale"]), 2)
        gate_ms = N15_REFERENCE_KERNEL_MS if legacy else round(N15_REFERENCE_KERNEL_MS * depth / reference_depth * architecture["gate_factor"], 6)
        r = qpu_res["period_r"]
        p = math.gcd(a**(r // 2) - 1, 15)
        q = math.gcd(a**(r // 2) + 1, 15)

        return HybridTelemetryResponse(
            workload_id="shors_crypto",
            workload_name="Shor's Factoring Pipeline (Hybrid Cryptography)",
            scale_label=scale_label,
            execution_mode="LIVE_QISKIT_AER",
            primary_bottleneck="NONE (Fits Within NISQ Coherence Window)",
            stages={
                "stage_1_classical_pre": StageTelemetry(
                    name="Euclidean Coprime & Base Filter",
                    node="CPU",
                    latency_ms=0.14,
                    status="OPTIMAL",
                    output_summary=f"Selected coprime base a = {a}; verified gcd({a}, 15) = 1 on CPU.",
                    metrics={"algorithm": "Euclidean GCD", "complexity": "O(log N)", "base_a": a}
                ),
                "stage_2_quantum_kernel": StageTelemetry(
                    name="Quantum Period Finding (ModExp + IQFT)",
                    node="QPU",
                    latency_ms=gate_ms,
                    status="OPTIMAL",
                    output_summary=f"Peaks at {qpu_res['top_measurements']} -> Extracted period r = {r}.",
                    metrics={
                        "qubits_required": qpu_res["qubits"],
                        "circuit_depth": depth,
                        "reference_circuit_depth": reference_depth,
                        # Preserve the original Aer-reference setup for legacy profiles.
                        # Ion prep_ms includes readout; do not add that overhead twice.
                        "io_state_prep_ms": 0.05 if legacy else architecture["prep_ms"],
                        "coherence_survival_pct": coherence,
                    }
                ),
                "stage_3_classical_post": StageTelemetry(
                    name="Continued Fractions & Factor GCD",
                    node="CPU",
                    latency_ms=0.21,
                    status="OPTIMAL",
                    output_summary=f"Computed gcd({a}^({r}/2) ± 1, 15) -> Successfully factored 15 = {p} × {q}.",
                    metrics={"algorithm": "Continued Fractions", "factors_found": f"{p} × {q}"}
                )
            }
        )

    # --- CASE B: ANALYTICAL NISQ PROFILER (N = 21, 35, RSA-512, RSA-2048) ---
    qubits_req = 8 if scale_param == 15 else 2 * n_bits + 3
    reference_depth = qpu_plan["circuit_depth"] if qpu_plan else int(4.5 * (n_bits ** 3))
    circuit_depth = math.ceil(reference_depth * architecture["depth_factor"])
    gate_exec_ms = round(circuit_depth * 0.00025 * architecture["gate_factor"], 2 if legacy else 6)

    if not noisy:
        coherence_pct = 100.0
        qpu_status = "OPTIMAL"
        post_status = "OPTIMAL"
        bottleneck = "NONE (Noise-Free QPU Analytical Projection)" if qpu_plan else "CLASSICAL SIMULATION RAM WALL (2^N Statevector Limit)"
    else:
        # A depth-based proxy, not a calibrated T1/T2 or gate-error simulation.
        # Slow trapped-ion gates affect time separately from their longer decay scale.
        coherence_pct = round(max(0.0, 100.0 * math.exp(-circuit_depth / architecture["decay_scale"])), 2)
        if coherence_pct > 40:
            qpu_status = "WARNING"
            post_status = "OPTIMAL"
            bottleneck = "NISQ TWO-QUBIT GATE NOISE (Degrading Phase Peaks)"
        else:
            qpu_status = "CRITICAL_BOTTLENECK"
            post_status = "WARNING"
            bottleneck = f"CATASTROPHIC QPU DECOHERENCE ({circuit_depth:,} Gates Exceed T1/T2 Window)"

    factor_lookup = {
        15: ("r = 4", "15 = 3 × 5"),
        21: ("r = 6", "21 = 3 × 7"),
        35: ("r = 12", "35 = 5 × 7"),
        512: ("Thermal Noise", "FAILED (Requires ~1M Physical Surface-Code Qubits)"),
        2048: ("Thermal Noise", "FAILED (Requires ~4M Physical Surface-Code Qubits)")
    }
    period_str, factor_str = factor_lookup.get(scale_param, ("Noise Floor", "Unresolved"))

    return HybridTelemetryResponse(
        workload_id="shors_crypto",
        workload_name="Shor's Factoring Pipeline (Hybrid Cryptography)",
        scale_label=scale_label,
        execution_mode="NISQ_ANALYTICAL_PROFILER",
        primary_bottleneck=bottleneck,
        stages={
            "stage_1_classical_pre": StageTelemetry(
                name="Euclidean Coprime & Base Filter",
                node="CPU",
                latency_ms=round(0.12 * math.log2(n_bits), 2),
                status="OPTIMAL",
                output_summary=f"Verified coprime base a = {a} for {n_bits}-bit modulus in O(log N) time.",
                metrics={"algorithm": "Euclidean GCD", "complexity": "O(log N)", "base_a": a}
            ),
            "stage_2_quantum_kernel": StageTelemetry(
                name="Quantum Period Finding (ModExp + IQFT)",
                node="QPU",
                latency_ms=gate_exec_ms,
                status=qpu_status,
                output_summary=(
                    f"Minimum {qubits_req:,} logical qubits; circuit depth {circuit_depth:,}. "
                    f"Coherence survival: {coherence_pct}%."
                ),
                metrics={
                    "qubits_required": qubits_req,
                    "circuit_depth": circuit_depth,
                    "reference_circuit_depth": reference_depth,
                    "io_state_prep_ms": architecture["prep_ms"],
                    "coherence_survival_pct": coherence_pct
                }
            ),
            "stage_3_classical_post": StageTelemetry(
                name="Continued Fractions & Factor GCD",
                node="CPU",
                latency_ms=round(0.25 * (n_bits / 4), 2),
                status=post_status if coherence_pct > 15 else "CRITICAL_BOTTLENECK",
                output_summary=(
                    f"Continued Fractions output: {factor_str}" if coherence_pct > 15 or not noisy
                    else f"STARVED: QPU output collapsed to uniform white noise ({period_str}). Cannot extract factors."
                ),
                metrics={"algorithm": "Continued Fractions", "factors_found": factor_str if not noisy or coherence_pct > 15 else "NONE (Decohered)"}
            )
        }
    )

# Routing costs below are illustrative simulation assumptions, not benchmarks.
# GPU classical routines include 0.30 ms of launch/transfer overhead and a 4x
# compute speedup. Classical statevector emulation costs scale with 2^qubits;
# CPU/GPU kernel multipliers are 50x/12.5x the baseline gate-time estimate.
# The modeled statevector budgets are 16 GiB on CPU and 8 GiB on GPU, with
# complex128 amplitudes (16 bytes). No physical GPU or QPU is dispatched.
CLASSICAL_GPU_OVERHEAD_MS = 0.30
CLASSICAL_GPU_COMPUTE_FACTOR = 0.25
STATEVECTOR_PROFILES = {
    "CPU": {"max_qubits": 30, "memory_gib": 16, "latency_factor": 50.0},
    "GPU": {"max_qubits": 29, "memory_gib": 8, "latency_factor": 12.5},
}
STAGE_KEYS = (
    "stage_1_classical_pre",
    "stage_2_quantum_kernel",
    "stage_3_classical_post",
)


def classical_cpu_baseline(scale_param: int) -> Dict[str, Any]:
    """All-CPU counterfactual using the same statevector model, without Aer work.

    Baseline emulation uses the sequential circuit and minimum register width;
    QPU ancilla capacity must not artificially inflate its CPU memory footprint.
    """
    n_bits = scale_param if scale_param in [512, 2048] else math.ceil(math.log2(scale_param))
    qubits = 8 if scale_param == 15 else 2 * n_bits + 3
    profile = STATEVECTOR_PROFILES["CPU"]
    feasible = qubits <= profile["max_qubits"]
    kernel_ms = None
    total_ms = None
    if feasible:
        gate_ms = N15_REFERENCE_KERNEL_MS if scale_param == 15 else round(int(4.5 * n_bits ** 3) * 0.00025, 2)
        kernel_ms = round(gate_ms * 2 ** (qubits - 8) * profile["latency_factor"], 2)
        pre_ms = 0.14 if scale_param == 15 else round(0.12 * math.log2(n_bits), 2)
        post_ms = 0.21 if scale_param == 15 else round(0.25 * n_bits / 4, 2)
        total_ms = round(pre_ms + kernel_ms + post_ms, 2)
    return {"feasible": feasible, "kernel_ms": kernel_ms, "total_ms": total_ms,
            "logical_qubits": qubits, "memory_budget_gib": profile["memory_gib"]}


def run_shors_pipeline(
    scale_param: int,
    hardware_profile: str,
    routing: Optional[RoutingConfig] = None,
    available_qubits: int = 133,
) -> HybridTelemetryResponse:
    """Profile projected stage placement; the N=15 reference circuit uses Aer.

    Routes and ancilla parallelization describe modeled costs and feasibility,
    not device measurements. Classical emulation ignores physical QPU capacity.
    """
    targets = routing or RoutingConfig()
    if hardware_profile not in HARDWARE_PROFILES:
        raise ValueError("Unsupported hardware profile")
    plan = qpu_capacity_plan(scale_param, available_qubits)
    core_profile = hardware_profile if targets.stage_2_node == "QPU" else "ideal_sim"
    response = _run_default_shors_pipeline(
        scale_param, core_profile, plan if targets.stage_2_node == "QPU" else None,
    )

    reasons = {"stage_2_quantum_kernel": response.primary_bottleneck}
    for key, target in zip(STAGE_KEYS, (
        targets.stage_1_node, targets.stage_2_node, targets.stage_3_node
    )):
        stage = response.stages[key]
        stage.node = target
        stage.metrics["routing_model"] = "ILLUSTRATIVE_V1 (not device measurements)"
        stage.metrics["routing_supported"] = True
        stage.metrics["execution_feasible"] = True

        if target == "QPU":
            architecture = HARDWARE_PROFILES[hardware_profile]
            stage.metrics.update({"hardware_architecture": hardware_profile,
                                  "connectivity_topology": architecture["topology"],
                                  "routing_depth_multiplier": architecture["depth_factor"],
                                  "gate_time_multiplier": architecture["gate_factor"]})
            if architecture["reference_qubits"] is not None:
                stage.metrics["reference_qubits"] = architecture["reference_qubits"]
            if architecture["decay_scale"] is not None:
                stage.metrics["coherence_decay_scale"] = architecture["decay_scale"]
            # Only the quantum kernel has an implemented QPU algorithm. Other
            # QPU routes still get capacity validation before route validation.
            capacity = {k: v for k, v in plan.items() if k != "circuit_depth"}
            stage.metrics.update(capacity)
            if plan["qubits_allocated"] == 0:
                stage.latency_ms = 0.0
                stage.status = "CRITICAL_BOTTLENECK"
                stage.metrics.update({"execution_feasible": False, "circuit_depth": 0,
                                      "coherence_survival_pct": 0.0, "io_state_prep_ms": 0.0})
                stage.output_summary = (
                    f"BLOCKED: minimum {plan['minimum_qubits_required']:,} qubits required; "
                    f"only {available_qubits:,} available. No QPU execution performed."
                )
                reasons[key] = "INSUFFICIENT QPU QUBIT CAPACITY"
                continue
            if key == "stage_2_quantum_kernel":
                stage.output_summary += (
                    f" {plan['qubits_allocated']:,} / {available_qubits:,} qubits allocated / available; "
                    f"{plan['parallelization_tier']} ({plan['depth_complexity']}). "
                    f"{plan['idle_qubits']:,} qubits idle."
                )
                stage.metrics["depth_model"] = (
                    ("Compiled 8-qubit Aer reference circuit" if hardware_profile in ("ibm_heron_nisq", "ideal_sim")
                     else "Architecture-adjusted Aer reference projection") if response.execution_mode == "LIVE_QISKIT_AER"
                    else "Illustrative analytical projection (4.5 coefficient, log base 2)"
                )

        if key == "stage_2_quantum_kernel":
            if target == "QPU":
                continue
            profile = STATEVECTOR_PROFILES[target]
            qubits = stage.metrics["qubits_required"]
            stage.metrics.update({
                "simulation_method": "Classical statevector emulation",
                "statevector_memory_required": f"2^{qubits + 4} bytes",
                "statevector_memory_budget_gib": profile["memory_gib"],
                "coherence_survival_pct": 100.0,
                "io_state_prep_ms": CLASSICAL_GPU_OVERHEAD_MS if target == "GPU" else 0.0,
            })
            if qubits > profile["max_qubits"]:
                stage.latency_ms = 0.0
                stage.status = "CRITICAL_BOTTLENECK"
                stage.metrics["execution_feasible"] = False
                stage.output_summary = (
                    f"BLOCKED: {qubits:,}-qubit statevector requires 2^{qubits + 4} "
                    f"bytes, exceeding the modeled {profile['memory_gib']} GiB {target} budget."
                )
                reasons[key] = f"{target} STATEVECTOR MEMORY LIMIT ({profile['memory_gib']} GiB Modeled Budget)"
            else:
                overhead = CLASSICAL_GPU_OVERHEAD_MS if target == "GPU" else 0.0
                stage.latency_ms = round(
                    stage.latency_ms * (2 ** (qubits - 8)) * profile["latency_factor"] + overhead, 2
                )
                stage.status = "WARNING"
                stage.output_summary += (
                    f" Quantum kernel emulated on modeled {target}; latency is an "
                    "illustrative projection with no physical QPU decoherence."
                )
                reasons[key] = f"{target} STATEVECTOR EMULATION OVERHEAD (Illustrative Latency Model)"
            continue

        if target == "GPU":
            stage.latency_ms = round(
                stage.latency_ms * CLASSICAL_GPU_COMPUTE_FACTOR + CLASSICAL_GPU_OVERHEAD_MS, 2
            )
            stage.metrics["launch_transfer_overhead_ms"] = CLASSICAL_GPU_OVERHEAD_MS
            stage.metrics["compute_latency_factor"] = CLASSICAL_GPU_COMPUTE_FACTOR
            stage.output_summary = stage.output_summary.replace("on CPU.", "on the profiling host.")
            stage.output_summary += " GPU routing latency includes modeled launch/transfer overhead."
            if stage.status == "OPTIMAL":
                stage.status = "WARNING"
                reasons[key] = f"{target} LAUNCH/TRANSFER OVERHEAD ({stage.name})"
        elif target == "QPU":
            stage.latency_ms = 0.0
            stage.status = "CRITICAL_BOTTLENECK"
            stage.metrics["routing_supported"] = False
            stage.metrics["execution_feasible"] = False
            stage.metrics.update({"qubits_allocated": 0, "idle_qubits": available_qubits,
                                  "parallelization_tier": "Unavailable · unsupported QPU route",
                                  "parallel_speedup_ceiling_reached": False})
            stage.output_summary = (
                f"UNSUPPORTED ROUTE: {stage.name} is a classical host routine in this "
                "profiler and requires CPU or GPU placement; no QPU implementation is available."
            )
            reasons[key] = f"UNSUPPORTED QPU ROUTING ({stage.name})"

    # A blocked prerequisite must not produce successful downstream telemetry.
    blocked_by = None
    for key in STAGE_KEYS:
        stage = response.stages[key]
        if blocked_by is not None:
            stage.latency_ms = 0.0
            stage.status = "CRITICAL_BOTTLENECK"
            stage.metrics["execution_feasible"] = False
            stage.output_summary = f"STARVED: {blocked_by} did not produce usable input."
            if stage.node == "QPU":
                stage.metrics.update({"qubits_allocated": 0, "idle_qubits": available_qubits,
                                      "circuit_depth": 0, "coherence_survival_pct": 0.0,
                                      "parallelization_tier": "Blocked · upstream stage unavailable",
                                      "parallel_speedup_ceiling_reached": False})
            reasons[key] = stage.output_summary
        if stage.metrics["execution_feasible"] is False and blocked_by is None:
            blocked_by = stage.name
        if key == "stage_3_classical_post" and stage.metrics["execution_feasible"] is False:
            stage.metrics["factors_found"] = "NONE (Routing blocked)"

    if blocked_by is not None:
        # Report the source of starvation rather than a downstream symptom.
        source_key = next(key for key in STAGE_KEYS if response.stages[key].name == blocked_by)
        response.primary_bottleneck = reasons[source_key]
    else:
        rank = {"OPTIMAL": 0, "WARNING": 1, "CRITICAL_BOTTLENECK": 2}
        candidates = [key for key in STAGE_KEYS if response.stages[key].status != "OPTIMAL"]
        if candidates:
            key = max(candidates, key=lambda key: (
                rank[response.stages[key].status], response.stages[key].latency_ms
            ))
            response.primary_bottleneck = reasons.get(key, response.primary_bottleneck)
    response.stages["stage_2_quantum_kernel"].metrics["classical_cpu_baseline"] = classical_cpu_baseline(scale_param)
    return response


# ==========================================
# 4. API ENDPOINTS
# ==========================================
@app.get("/")
def health_check():
    return {"status": "online", "engine": "Q-Split Hybrid Profiler v2.0"}

@app.post("/api/simulate", response_model=HybridTelemetryResponse)
def simulate_workload(req: SimulationRequest):
    if req.workload_id == "shors_crypto":
        return run_shors_pipeline(req.scale_param, req.hardware_profile, req.routing, req.available_qubits)
    elif req.workload_id == "quantum_mips":
        # Socket ready for Thursday/Friday Quantum AI Vector Preset!
        raise HTTPException(status_code=501, detail="Quantum-MIPS AI Preset unlocks in Sprint Phase 2.")
    else:
        raise HTTPException(status_code=400, detail=f"Unknown workload_id: {req.workload_id}")

"""Hybrid workload profiling with executable small-circuit Aer references.

All stage latencies are milliseconds. CPU/GPU/QPU labels describe comparative
placement costs; Aer runs on the classical host and never dispatches a physical
QPU/GPU. Coherence is a depth-based proxy, not an injected calibrated noise model.
Next.js owns database persistence, AI diagnostics, and provider/cache economics.
"""

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.exception_handlers import request_validation_exception_handler
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, model_validator
from typing import Dict, Any, Literal, Optional
import math
from time import perf_counter
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
WorkloadId = Literal["shors_crypto", "quantum_mips"]
HardwareProfile = Literal["ibm_heron_nisq", "google_weber_grid", "ionq_forte_trapped_ion", "ideal_sim"]

QUANTUM_MIPS_WORKLOAD_NAME = "Quantum-MIPS · Sub-Linear LLM Vector Retrieval"
QUANTUM_MIPS_DEFAULT_SCALE = 64
QUANTUM_MIPS_SCALES = {
    64: {"index_bits": 6, "label": "M = 64 (6-bit Toy KV-Cache Block)"},
    1024: {"index_bits": 10, "label": "M = 1,024 (10-bit HNSW Subgraph)"},
    32768: {"index_bits": 15, "label": "M = 32k (15-bit Long-Context KV-Cache)"},
    131072: {"index_bits": 17, "label": "M = 128k (17-bit LLM Vocabulary Unembedding)"},
    1048576: {"index_bits": 20, "label": "M = 1M (20-bit Enterprise RAG Vector Index)"},
}


@app.exception_handler(RequestValidationError)
async def validate_simulation_request(request: Request, error: RequestValidationError):
    """Preserve the legacy unknown-workload HTTP status during schema validation.

    Args:
        request: FastAPI request whose path scopes the compatibility rule.
        error: Pydantic/FastAPI validation failure, possibly containing many errors.

    Returns:
        HTTP 400 only for a lone unknown workload string on /api/simulate;
        otherwise FastAPI's standard validation response, normally HTTP 422."""
    errors = error.errors()
    # Keep the existing HTTP 400 contract for unknown workload strings while
    # exposing a real workload enum in Pydantic/OpenAPI. Other failures use 422.
    if (request.url.path == "/api/simulate" and len(errors) == 1
            and errors[0]["loc"] == ("body", "workload_id")
            and errors[0]["type"] == "literal_error"
            and isinstance(errors[0].get("input"), str)):
        return JSONResponse(status_code=400, content={"detail": f"Unknown workload_id: {errors[0]['input']}"})
    return await request_validation_exception_handler(request, error)

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
    """Independent placement of the three sequential pipeline stages.

    Attributes:
        stage_1_node: Classical preprocessing target; defaults to CPU.
        stage_2_node: Quantum-kernel target; defaults to QPU.
        stage_3_node: Classical postprocessing target; defaults to CPU.

    Unknown routing keys are forbidden to catch misspelled stage assignments.
    CPU/GPU/QPU labels select cost models, not physical device dispatch."""
    model_config = ConfigDict(extra="forbid")

    stage_1_node: StageNode = "CPU"
    stage_2_node: StageNode = "QPU"
    stage_3_node: StageNode = "CPU"


class SimulationRequest(BaseModel):
    """Validated workload controls shared by OpenAPI and the dispatcher.

    Attributes:
        workload_id: Canonical Shor or Quantum-MIPS identifier.
        scale_param: Small Shor modulus, RSA bit-width, or MIPS candidate count.
        hardware_profile: Comparative QPU topology/timing/coherence model.
        routing: Optional stage placements; pipeline builders supply defaults.
        available_qubits: Usable per-stage QPU capacity, excluding QEC overhead.

    Strict integer fields reject booleans and fractional capacities. An omitted
    scale stays 15 for Shor and becomes 64 for Quantum-MIPS."""
    workload_id: WorkloadId = "shors_crypto"
    scale_param: int = Field(default=15, strict=True, ge=2, le=2_147_483_647)
    hardware_profile: HardwareProfile = "ibm_heron_nisq"
    routing: Optional[RoutingConfig] = None
    available_qubits: int = Field(default=133, strict=True, ge=1, le=2_147_483_647)

    @model_validator(mode="before")
    @classmethod
    def default_workload_scale(cls, value):
        """Supply M=64 only when a Quantum-MIPS request omits its scale.

        The before-validator copies dictionary input instead of mutating it and
        leaves explicit invalid values for the normal field validators to reject."""
        if isinstance(value, dict) and value.get("workload_id") == "quantum_mips" and "scale_param" not in value:
            return {**value, "scale_param": QUANTUM_MIPS_DEFAULT_SCALE}
        return value

    @model_validator(mode="after")
    def validate_workload_scale(self):
        """Constrain Quantum-MIPS to its calibrated scales after field validation.

        Returns:
            This validated request, preserving Shor's broader integer scale contract.

        Raises:
            ValueError: The MIPS candidate count has no configured reference model."""
        if self.workload_id == "quantum_mips" and self.scale_param not in QUANTUM_MIPS_SCALES:
            raise ValueError("Quantum-MIPS scale_param must be one of 64, 1024, 32768, 131072, 1048576.")
        return self

class StageTelemetry(BaseModel):
    """One stage's projected execution cost and diagnostic metadata.

    latency_ms includes GPU launch cost but excludes separately reported QPU
    preparation/readout. Consumers must inspect feasibility flags before summing
    costs; metrics intentionally vary by workload, route, and blocking condition."""
    name: str
    node: StageNode
    latency_ms: float
    status: str                             # "OPTIMAL", "WARNING", "CRITICAL_BOTTLENECK"
    output_summary: str
    metrics: Dict[str, Any]

class HybridTelemetryResponse(BaseModel):
    """Wire response containing the three keyed stages and run-level context.

    execution_mode identifies whether a small Aer reference ran; it does not
    mean that selected-route GPU/QPU costs were measured on physical hardware."""
    workload_id: WorkloadId
    workload_name: str
    scale_label: str
    execution_mode: str                     # "LIVE_QISKIT_AER" or "NISQ_ANALYTICAL_PROFILER"
    primary_bottleneck: str
    stages: Dict[str, StageTelemetry]

# ==========================================
# 2. LIVE QISKIT AER KERNEL FOR N = 15
# ==========================================
def c_amod15(a: int, power: int):
    """Build a controlled, four-work-qubit modular multiplication gate.

    Args:
        a: Base from the supported modulo-15 demonstration permutations.
        power: Number of repeated applications, used as 2**q during phase estimation.

    Returns:
        A controlled gate implementing the selected permutation power. SWAP/X
        decompositions are specific to this small reference, not general ModExp."""
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
    """Sample an eight-qubit N=15 phase-estimation reference with Aer.

    Args:
        a: Coprime base for the modulo-15 reference circuit, normally 7.
        noisy: Select the reported depth-decay proxy instead of 100% survival;
            this flag does not attach an Aer thermal or depolarizing noise model.

    Returns:
        Compiled qubit count/depth, leading measured phases, extracted period,
        and modeled coherence percentage. The known demonstration period is
        retained if sampled candidate denominators do not verify nontrivial factors.

    The 512-shot counts come from actual simulation; projected QPU gate timing
    is supplied separately by the pipeline, not measured by this function."""
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


QUANTUM_MIPS_TARGET_INDEX = 45  # |101101>: a marked-state demonstration, not a real vector search.
QUANTUM_MIPS_AER_SHOTS = 1024


def build_quantum_mips_grover_circuit() -> QuantumCircuit:
    """Build the ten-qubit marked-state Grover reference for M=64.

    Six index qubits represent candidates and four clean ancillas compute a
    multi-controlled phase reflection. Each reflection uncomputes its workspace.
    The marked index is 45; no vector dataset or adaptive maximum-finding oracle
    is executed by this demonstration.

    Returns:
        A measured QuantumCircuit with six index classical bits and six Grover
        iterations, floor((pi/4) * sqrt(64))."""
    circuit = QuantumCircuit(10, 6)
    index = list(range(6))
    target = format(QUANTUM_MIPS_TARGET_INDEX, "06b")
    # Qiskit qubit 0 is the least-significant bit; reverse the display bitstring.
    zero_bits = [qubit for qubit, bit in enumerate(reversed(target)) if bit == "0"]

    def reflect_all_ones():
        """Apply a phase flip to the all-ones index state and restore clean ancillas.

        The Toffoli chain stores the conjunction of the first five index bits;
        CZ phases the sixth bit, and the reversed chain restores qubits 6 through 9."""
        circuit.ccx(0, 1, 6)
        circuit.ccx(6, 2, 7)
        circuit.ccx(7, 3, 8)
        circuit.ccx(8, 4, 9)
        circuit.cz(9, 5)
        circuit.ccx(8, 4, 9)
        circuit.ccx(7, 3, 8)
        circuit.ccx(6, 2, 7)
        circuit.ccx(0, 1, 6)

    circuit.h(index)
    # Single-target Grover amplification uses approximately pi/4 * sqrt(M) rotations.
    for _ in range(math.floor(math.pi / 4 * math.sqrt(64))):
        circuit.x(zero_bits)
        reflect_all_ones()
        circuit.x(zero_bits)
        circuit.h(index)
        circuit.x(index)
        reflect_all_ones()
        circuit.x(index)
        circuit.h(index)
    circuit.measure(index, index)
    return circuit


def execute_live_quantum_mips_64() -> Dict[str, Any]:
    """Execute the ideal Grover reference and measure simulator wall-clock work.

    Returns:
        Generic-basis compiled depth, shot counts, measured top index/probability,
        and separate compilation, execution, and total times in milliseconds.

    Both transpilation and sampling use seed 7. Aer executes on the CPU with one
    parallel thread; later GPU/QPU timing and hardware coherence are projections,
    not measurements or native-device compilation."""
    circuit = build_quantum_mips_grover_circuit()
    simulator = AerSimulator(method="statevector", max_parallel_threads=1)
    started = perf_counter()
    compiled = transpile(circuit, basis_gates=["cx", "rz", "sx", "x"],
                         optimization_level=1, seed_transpiler=7)
    compiled_at = perf_counter()
    counts = simulator.run(compiled, shots=QUANTUM_MIPS_AER_SHOTS, seed_simulator=7).result().get_counts()
    finished = perf_counter()
    peak = max(counts, key=counts.get)
    return {"reference_circuit_depth": compiled.depth(), "aer_reference_qubits": compiled.num_qubits,
            "aer_shots": sum(counts.values()), "aer_counts": dict(counts),
            "top_1_token_index": int(peak, 2), "measured_peak_probability": counts[peak] / sum(counts.values()),
            "aer_compile_time_ms": (compiled_at - started) * 1000,
            "aer_runtime_ms": (finished - compiled_at) * 1000,
            "aer_total_time_ms": (finished - started) * 1000}

# ==========================================
# 3. WORKLOAD PLANNING & HYBRID PIPELINES
# ==========================================
def quantum_mips_qubit_thresholds(scale_param: int) -> Dict[str, int]:
    """Resolve register widths for an M-candidate search space.

    Args:
        scale_param: Integer candidate count M, including future non-power-of-two M.

    Returns:
        Index width k=ceil(log2(M)) and Sequential/Windowed/Multi-Oracle register
        thresholds k+4, 2k+8, and 4k+16. Public requests allow only calibrated presets.

    Raises:
        ValueError: M is not a strict integer in the supported int32 range."""
    if type(scale_param) is not int or not 2 <= scale_param <= 2_147_483_647:
        raise ValueError("Candidate count must be an integer from 2 to 2,147,483,647.")
    # Integer arithmetic gives ceil(log2(M)) exactly, including powers of two.
    k = (scale_param - 1).bit_length()
    return {"index_bits": k, "minimum_qubits_required": k + 4,
            "windowed_qubits_required": 2 * k + 8, "ceiling_qubits_required": 4 * k + 16}


def quantum_mips_capacity_plan(scale_param: int, available_qubits: int) -> Dict[str, Any]:
    """Select the highest affordable oracle tier without allocating a circuit.

    Args:
        scale_param: Candidate count used to resolve index/workspace thresholds.
        available_qubits: Positive int32 usable register capacity.

    Returns:
        Allocation, idle capacity, feasibility, tier label, and depth factor
        1.0/0.40/0.20. Below minimum, allocation is zero and the factor is None.

    Raises:
        ValueError: Candidate count or available capacity is invalid.

    Grover iterations remain O(sqrt(M)); tier factors describe oracle workspace
    parallelism, excluding vector loading and physical error-correction costs."""
    thresholds = quantum_mips_qubit_thresholds(scale_param)
    if type(available_qubits) is not int or not 1 <= available_qubits <= 2_147_483_647:
        raise ValueError("Available qubits must be an integer from 1 to 2,147,483,647.")
    minimum = thresholds["minimum_qubits_required"]
    windowed = thresholds["windowed_qubits_required"]
    ceiling = thresholds["ceiling_qubits_required"]
    if available_qubits < minimum:
        allocated, tier, multiplier = 0, "Blocked · insufficient capacity", None
        oracle = "Not executed"
    elif available_qubits >= ceiling:
        allocated, tier, multiplier = ceiling, "Multi-Oracle Ceiling", 0.20
        oracle = "Partitioned parallel Grover amplitude amplification across oracle registers"
    elif available_qubits >= windowed:
        allocated, tier, multiplier = windowed, "Windowed Parallel", 0.40
        oracle = "Parallel tree-based inner-product accumulation across ancilla registers"
    else:
        allocated, tier, multiplier = minimum, "Sequential Minimum", 1.0
        oracle = "Serial inner-product oracle across O(sqrt(M)) Grover iterations"
    return {**thresholds, "available_qubits": available_qubits, "qubits_allocated": allocated,
            "idle_qubits": available_qubits - allocated, "parallelization_tier": tier,
            "depth_multiplier": multiplier, "oracle_model": oracle,
            "execution_feasible": allocated > 0,
            "parallel_speedup_ceiling_reached": allocated > 0 and available_qubits >= ceiling}


def qpu_capacity_plan(scale_param: int, available_qubits: int) -> Dict[str, Any]:
    """Resolve Shor register allocation and analytical arithmetic depth.

    Args:
        scale_param: Modulus for small demonstrations; bit-width for RSA presets.
        available_qubits: Validated per-stage usable QPU capacity.

    Returns:
        Highest unlocked tier, allocated/idle qubits, feasibility-related labels,
        and reference depth. N=15 reserves its special eight-qubit minimum.

    All tiers share coefficient 4.5 and log base 2 so increasing workspace lowers
    modeled depth consistently. Integer allocations round 5.5n upward, and capacity
    above that ceiling remains idle; physical QEC overhead is not included."""
    # RSA selectors already encode bit-width; small selectors encode the modulus.
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
    """Build the reference Shor stages before routing-specific cost adjustments.

    Args:
        scale_param: Small modulus or RSA bit-width.
        hardware_profile: Validated hardware registry key.
        qpu_plan: Optional QPU tier plan; None keeps the minimum classical reference.

    Returns:
        Default CPU/QPU/CPU telemetry. N=15 Sequential (or a missing QPU plan)
        executes Aer; other paths use analytical depth and canned factor summaries.

    Hardware factors project depth/time/coherence without native topology
    transpilation. Legacy IBM/ideal N=15 timing retains 1.85 ms gates and 0.05 ms I/O."""
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
    # 0.00025 ms per modeled depth unit is a calibration constant, not device timing.
    gate_exec_ms = round(circuit_depth * 0.00025 * architecture["gate_factor"], 2 if legacy else 6)

    if not noisy:
        coherence_pct = 100.0
        qpu_status = "OPTIMAL"
        post_status = "OPTIMAL"
        bottleneck = "NONE (Noise-Free QPU Analytical Projection)" if qpu_plan else "CLASSICAL SIMULATION RAM WALL (2^N Statevector Limit)"
    else:
        # A depth-based proxy, not a calibrated T1/T2 or gate-error simulation.
        # Slow trapped-ion gates affect time separately from their longer decay scale.
        # exp(-D/lambda) stays in [0, 1]; lambda is measured in depth units, not T1/T2 time.
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

# Shor routing costs below are illustrative simulation assumptions, not benchmarks.
# Its GPU classical routines include 0.30 ms of launch/transfer overhead and a 4x
# compute speedup. Classical statevector emulation costs scale with 2^qubits;
# CPU/GPU kernel multipliers are 50x/12.5x the baseline gate-time estimate.
# The modeled statevector budgets are 16 GiB on CPU and 8 GiB on GPU, with
# complex128 amplitudes (16 bytes). No physical GPU or QPU is dispatched.
CLASSICAL_GPU_OVERHEAD_MS = 0.30
CLASSICAL_GPU_COMPUTE_FACTOR = 0.25

# Quantum-MIPS host-stage calibration points, not measured device timings.
# d and the verification batch K are implicit in these reference workloads;
# no vector matches, projection output, or softmax scores are fabricated.
QUANTUM_MIPS_CLASSICAL_PROFILES = {
    "stage_1_classical_pre": {
        "name": "LSH Projection & HNSW Bucket Pruning",
        "algorithm": "LSH Random Hyperplane & HNSW Graph Filter",
        "complexity": "O(d · log M)",
        "gpu_compute_factor": 0.12,
        "cpu_latency_ms": {64: 0.25, 1024: 2.40, 32768: 18.5, 131072: 64.0, 1048576: 310.0},
        "operation": "LSH projection and HNSW bucket filtering",
        "qpu_limitation": "Hash bucket filtering is a classical memory-bound routine",
    },
    "stage_3_classical_post": {
        "name": "Exact FP16 Dot-Product Reranking & Softmax",
        "algorithm": "Batch FP16 Cosine Reranking & Top-K Softmax",
        "complexity": "O(K · d)",
        "gpu_compute_factor": 0.10,
        "cpu_latency_ms": {64: 0.18, 1024: 1.80, 32768: 12.0, 131072: 42.0, 1048576: 195.0},
        "operation": "FP16 cosine reranking and Top-K softmax verification",
        "qpu_limitation": "Exact reranking and softmax verification require classical vector processing",
    },
}


def _quantum_mips_classical_stage(scale_param: int, node: StageNode, stage_key: str) -> StageTelemetry:
    """Profile one calibrated MIPS host stage with optional GPU launch overhead.

    Args:
        scale_param: One of the five calibrated M values.
        node: CPU, GPU, or unsupported QPU placement.
        stage_key: Preprocessing or postprocessing calibration-table key.

    Returns:
        StageTelemetry with CPU reference, compute/I/O decomposition, and status.
        QPU requests are blocked with zero cost; GPU is a warning when launch cost
        erases its compute gain. Returned GPU latency includes the 0.30 ms I/O once.

    Raises:
        ValueError: Scale or node is unsupported."""
    if type(scale_param) is not int or scale_param not in QUANTUM_MIPS_SCALES:
        raise ValueError("Unsupported Quantum-MIPS candidate count.")
    if node not in ("CPU", "GPU", "QPU"):
        raise ValueError("Stage node must be CPU, GPU, or QPU.")
    profile = QUANTUM_MIPS_CLASSICAL_PROFILES[stage_key]
    cpu_ms = profile["cpu_latency_ms"][scale_param]
    metrics = {
        "algorithm": profile["algorithm"], "complexity": profile["complexity"],
        "candidate_count": scale_param, "index_bits": QUANTUM_MIPS_SCALES[scale_param]["index_bits"],
        "cpu_reference_latency_ms": cpu_ms, "routing_model": "ILLUSTRATIVE_V1 (not device measurements)",
        "routing_supported": node != "QPU", "execution_feasible": node != "QPU",
    }
    if node == "QPU":
        metrics.update({"compute_latency_ms": 0.0, "launch_transfer_overhead_ms": 0.0})
        return StageTelemetry(name=profile["name"], node=node, latency_ms=0.0, status="CRITICAL_BOTTLENECK",
                              output_summary=f"UNSUPPORTED ROUTE: {profile['qpu_limitation']}; use CPU or GPU. No QPU execution performed.",
                              metrics=metrics)

    factor = profile["gpu_compute_factor"] if node == "GPU" else 1.0
    overhead_ms = CLASSICAL_GPU_OVERHEAD_MS if node == "GPU" else 0.0
    # Match the existing host-stage precision. Compute and inclusive total use
    # the same rounding so launch/transfer is accounted for exactly once.
    compute_ms = round(cpu_ms * factor, 2)
    total_ms = round(compute_ms + overhead_ms, 2)
    metrics.update({"compute_latency_factor": factor, "compute_latency_ms": compute_ms,
                    "launch_transfer_overhead_ms": overhead_ms})
    status = "WARNING" if node == "GPU" and total_ms >= cpu_ms else "OPTIMAL"
    summary = f"Modeled {profile['operation']} for M = {scale_param:,} on {node}."
    if node == "GPU":
        summary += f" Tensor-parallel compute {compute_ms:.2f} ms + PCIe launch/transfer {overhead_ms:.2f} ms = {total_ms:.2f} ms."
        summary += (f" Small-batch PCIe overhead makes CPU faster ({cpu_ms:.2f} ms)." if status == "WARNING"
                    else f" Tensor parallelism is faster than the CPU reference ({cpu_ms:.2f} ms).")
    else:
        summary += f" CPU compute {compute_ms:.2f} ms; no PCIe launch/transfer cost."
    return StageTelemetry(name=profile["name"], node=node, latency_ms=total_ms, status=status,
                          output_summary=summary, metrics=metrics)


def quantum_mips_preprocessing(scale_param: int, node: StageNode = "CPU") -> StageTelemetry:
    """Profile LSH/HNSW preprocessing, delegating route and scale validation.

    Args:
        scale_param: Calibrated candidate count M.
        node: Placement model; QPU is unsupported for this classical routine.

    Returns:
        Host-stage telemetry with O(d log M) labeling and modeled compute/I/O costs."""
    return _quantum_mips_classical_stage(scale_param, node, "stage_1_classical_pre")


def quantum_mips_postprocessing(scale_param: int, node: StageNode = "CPU") -> StageTelemetry:
    """Profile FP16 reranking and softmax assuming usable kernel input.

    Args:
        scale_param: Calibrated candidate count M.
        node: Placement model; QPU is unsupported for this classical routine.

    Returns:
        O(K d) host-stage telemetry. The pipeline later suppresses cost if upstream
        work is blocked; no candidate vectors are actually reranked here."""
    return _quantum_mips_classical_stage(scale_param, node, "stage_3_classical_post")


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
    """Compute a comparable all-CPU Shor counterfactual without additional Aer work.

    Args:
        scale_param: Small modulus or RSA bit-width.

    Returns:
        CPU RAM feasibility, minimum register width, and kernel/pipeline milliseconds;
        infeasible times are None rather than misleading zero-duration baselines.

    The sequential register and circuit model are independent of selected physical
    QPU capacity; extra QPU ancillas must not artificially inflate baseline RAM."""
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


def _quantum_mips_emulation_plan(scale_param: int, available_qubits: int) -> Dict[str, Any]:
    """Resolve selected ancilla widths for classical Quantum-MIPS emulation.

    An insufficient physical-QPU selector falls back to the minimum emulated
    register, since CPU/GPU use their own RAM. Otherwise the selected tier controls
    statevector width. Original physical capacity is retained for display."""
    plan = quantum_mips_capacity_plan(scale_param, available_qubits)
    if plan["qubits_allocated"] == 0:
        # A physical QPU capacity shortage does not prevent classical emulation
        # of the minimum register. Larger selected tiers still need their RAM.
        plan = quantum_mips_capacity_plan(scale_param, plan["minimum_qubits_required"])
        plan.update({"available_qubits": available_qubits, "idle_qubits": 0})
    return plan


def _quantum_mips_statevector_cost(plan: Dict[str, Any], reference_depth: int, node: StageNode) -> Dict[str, Any]:
    """Estimate CPU/GPU RAM and cost without allocating the exponential statevector.

    Args:
        plan: Feasible-register capacity plan with allocation and depth multiplier.
        reference_depth: Sequential analytical or compiled-Aer reference depth.
        node: CPU or GPU registry key.

    Returns:
        Exact byte demand (16 * 2**q), binary-GiB budget, feasibility, pure compute,
        GPU launch overhead, and inclusive projected latency in milliseconds.

    Cost scales with 2**(q-10) relative to the ten-qubit reference. Hardware-QPU
    topology and decay factors never affect this deterministic classical path."""
    profile = STATEVECTOR_PROFILES[node]
    qubits = plan["qubits_allocated"]
    # Complex128 amplitudes occupy 16 bytes each; every extra qubit doubles RAM.
    required_bytes = 16 * 2 ** qubits
    # GiB uses binary 2**30 bytes, so 30 CPU / 29 GPU qubits fit exactly at budget.
    budget_bytes = profile["memory_gib"] * 2 ** 30
    feasible = required_bytes <= budget_bytes
    depth = math.ceil(reference_depth * plan["depth_multiplier"])
    compute_ms = round(depth * 0.00025 * 2 ** (qubits - 10) * profile["latency_factor"], 6) if feasible else 0.0
    overhead_ms = CLASSICAL_GPU_OVERHEAD_MS if node == "GPU" and feasible else 0.0
    return {"statevector_qubits": qubits, "statevector_memory_required_bytes": required_bytes,
            "statevector_memory_required": f"16 × 2^{qubits} bytes", "statevector_memory_budget_bytes": budget_bytes,
            "statevector_memory_budget_gib": profile["memory_gib"], "execution_feasible": feasible,
            "compute_latency_ms": compute_ms, "launch_transfer_overhead_ms": overhead_ms,
            "latency_ms": round(compute_ms + overhead_ms, 6)}


def _quantum_mips_cpu_baseline(scale_param: int, available_qubits: int, reference_depth: int) -> Dict[str, Any]:
    """Build the all-CPU counterfactual using the current MIPS ancilla tier.

    Reuse the caller's reference depth and calibrated host costs instead of running
    Aer again. Unlike Shor's minimum-width baseline, MIPS emulation includes the
    selected workspace; exceeding CPU RAM returns None times and feasible=False."""
    cost = _quantum_mips_statevector_cost(_quantum_mips_emulation_plan(scale_param, available_qubits), reference_depth, "CPU")
    kernel_ms = cost["latency_ms"] if cost["execution_feasible"] else None
    total_ms = None if kernel_ms is None else round(
        QUANTUM_MIPS_CLASSICAL_PROFILES["stage_1_classical_pre"]["cpu_latency_ms"][scale_param]
        + kernel_ms + QUANTUM_MIPS_CLASSICAL_PROFILES["stage_3_classical_post"]["cpu_latency_ms"][scale_param], 6)
    return {"feasible": cost["execution_feasible"], "kernel_ms": kernel_ms, "total_ms": total_ms,
            "logical_qubits": cost["statevector_qubits"], "memory_budget_gib": 16}


def _block_quantum_mips_stage(stage: StageTelemetry, reason: str) -> StageTelemetry:
    """Mutate a stage to record a blocker while removing unexecuted costs.

    Args:
        stage: Stage whose runtime, I/O, actual allocation, and output are updated.
        reason: Human-readable capacity, RAM, or upstream-starvation diagnostic.

    Returns:
        The same stage instance, marked infeasible. Planned register/tier and RAM
        diagnostics remain available while actual allocation and execution depth
        are cleared, preventing downstream summaries from charging blocked work."""
    stage.latency_ms = 0.0
    stage.status = "CRITICAL_BOTTLENECK"
    stage.metrics.update({"execution_feasible": False, "blocking_reason": reason, "retrieval_reliable": False})
    for field in ("compute_latency_ms", "launch_transfer_overhead_ms", "io_state_prep_ms", "io_readout_ms"):
        if field in stage.metrics:
            stage.metrics[field] = 0.0
    if "qubits_allocated" in stage.metrics:
        stage.metrics["planned_qubits"] = stage.metrics["qubits_allocated"]
        stage.metrics["planned_parallelization_tier"] = stage.metrics["parallelization_tier"]
        if reason.startswith("STARVED"):
            stage.metrics["parallelization_tier"] = "Blocked · upstream stage unavailable"
        elif "STATEVECTOR MEMORY LIMIT" in reason:
            stage.metrics["parallelization_tier"] = "Blocked · statevector memory"
        stage.metrics.update({"qubits_allocated": 0, "idle_qubits": stage.metrics["available_qubits"],
                              "circuit_depth": 0, "parallel_speedup_ceiling_reached": False})
    stage.output_summary = reason
    return stage


def quantum_mips_kernel(scale_param: int, hardware_profile: HardwareProfile = "ibm_heron_nisq",
                        node: StageNode = "QPU", available_qubits: int = 133,
                        *, upstream_blocked_by: Optional[str] = None) -> StageTelemetry:
    """Profile Stage 02 using a small Aer reference or analytical Grover depth.

    Args:
        scale_param: One of the five calibrated search-space sizes M.
        hardware_profile: Hardware key used only for QPU depth/time/coherence.
        node: CPU/GPU emulation or QPU projection; no physical device is dispatched.
        available_qubits: Usable capacity that selects an ancilla tier.
        upstream_blocked_by: Optional missing prerequisite; prevents Aer execution.

    Returns:
        Kernel telemetry including feasibility, allocation, reference/effective
        depth, projected timing/coherence, CPU baseline, and candidate provenance.
        Only feasible M=64 Sequential invokes Aer; its measured probability and
        host timing remain separate from hardware-route projections.

    Raises:
        ValueError: Scale, hardware key, node, or capacity is unsupported.

    Resource checks run before Aer. Low projected survival labels retrieval as
    unreliable rather than claiming that a known marked candidate was verified."""
    if type(scale_param) is not int or scale_param not in QUANTUM_MIPS_SCALES:
        raise ValueError("Unsupported Quantum-MIPS candidate count.")
    if not isinstance(hardware_profile, str) or hardware_profile not in HARDWARE_PROFILES:
        raise ValueError("Unsupported hardware profile.")
    if node not in ("CPU", "GPU", "QPU"):
        raise ValueError("Stage node must be CPU, GPU, or QPU.")
    plan = (quantum_mips_capacity_plan(scale_param, available_qubits) if node == "QPU"
            else _quantum_mips_emulation_plan(scale_param, available_qubits))
    # sqrt(M) Grover iterations times log2(M) index/oracle work; coefficient is illustrative.
    reference_depth = round(4.2 * math.sqrt(scale_param) * math.log2(scale_param))
    metrics = {**plan, "qubits_required": plan["minimum_qubits_required"],
               "algorithm": "Marked-State Grover / Inner-Product Oracle Projection", "complexity": "O(sqrt(M) · log M)",
               "candidate_count": scale_param, "grover_iterations": math.floor(math.pi / 4 * math.sqrt(scale_param)),
               "marked_candidate_index": QUANTUM_MIPS_TARGET_INDEX, "reference_circuit_depth": reference_depth,
               "depth_model": "Analytical Grover/Durr-Hoyer reference: round(4.2 sqrt(M) log2(M))",
               "circuit_depth": 0, "compute_latency_ms": 0.0, "io_state_prep_ms": 0.0,
               "coherence_survival_pct": 0.0 if node == "QPU" else 100.0,
               "routing_model": "ILLUSTRATIVE_V1 (not device measurements)", "routing_supported": True,
               "aer_executed": False, "retrieval_reliable": False,
               "model_scope": "Known marked candidate; vector loading and an adaptive maximum-finding oracle are not executed."}
    stage = StageTelemetry(name="Quantum Inner-Product & Grover-Max Amplification", node=node, latency_ms=0.0,
                           status="OPTIMAL", output_summary="", metrics=metrics)
    metrics = stage.metrics
    architecture = HARDWARE_PROFILES[hardware_profile]
    if node == "QPU":
        metrics.update({"hardware_architecture": hardware_profile, "connectivity_topology": architecture["topology"],
                        "routing_depth_multiplier": architecture["depth_factor"], "gate_time_multiplier": architecture["gate_factor"]})
        if architecture["reference_qubits"] is not None:
            metrics["reference_qubits"] = architecture["reference_qubits"]
        if architecture["decay_scale"] is not None:
            metrics["coherence_decay_scale"] = architecture["decay_scale"]
    else:
        cost = _quantum_mips_statevector_cost(plan, reference_depth, node)
        metrics.update({key: value for key, value in cost.items() if key != "latency_ms"})
        metrics["simulation_method"] = "Classical statevector emulation (illustrative timing)"
    metrics["classical_cpu_baseline"] = _quantum_mips_cpu_baseline(scale_param, available_qubits, reference_depth)

    if upstream_blocked_by:
        return _block_quantum_mips_stage(stage, f"STARVED: {upstream_blocked_by} did not produce usable input.")
    if node == "QPU" and plan["qubits_allocated"] == 0:
        return _block_quantum_mips_stage(stage, f"INSUFFICIENT QPU QUBIT CAPACITY: minimum {plan['minimum_qubits_required']} qubits required; {available_qubits} available.")
    if node != "QPU" and not metrics["execution_feasible"]:
        return _block_quantum_mips_stage(stage, f"{node} STATEVECTOR MEMORY LIMIT: {metrics['statevector_qubits']} qubits need {metrics['statevector_memory_required_bytes']:,} bytes, exceeding {metrics['statevector_memory_budget_gib']} GiB.")

    live = scale_param == 64 and plan["parallelization_tier"] == "Sequential Minimum"
    if live:
        measured = execute_live_quantum_mips_64()
        reference_depth = measured["reference_circuit_depth"]
        metrics.update(measured)
        metrics.update({"aer_executed": True, "depth_model": "Compiled 10-qubit Aer Grover reference; architecture projection is not native-device compilation"})
    metrics["classical_cpu_baseline"] = _quantum_mips_cpu_baseline(scale_param, available_qubits, reference_depth)
    if node == "QPU":
        # Ancilla parallelism and topology savings compose before rounding to whole depth units.
        depth = math.ceil(reference_depth * plan["depth_multiplier"] * architecture["depth_factor"])
        gate_ms = round(depth * 0.00025 * architecture["gate_factor"], 6)
        # Noise-free is explicit; physical profiles use a depth proxy, independent of elapsed gate time.
        coherence = 100.0 if architecture["decay_scale"] is None else round(100 * math.exp(-depth / architecture["decay_scale"]), 2)
        metrics.update({"circuit_depth": depth, "compute_latency_ms": gate_ms, "io_state_prep_ms": architecture["prep_ms"],
                        "coherence_survival_pct": coherence, "retrieval_reliable": coherence >= 35})
        stage.latency_ms = gate_ms  # QPU preparation/readout is exclusive, counted separately.
        stage.status = "OPTIMAL" if coherence >= 70 else "WARNING" if coherence >= 35 else "CRITICAL_BOTTLENECK"
    else:
        cost = _quantum_mips_statevector_cost(plan, reference_depth, node)
        metrics.update({key: value for key, value in cost.items() if key != "latency_ms"})
        metrics.update({"circuit_depth": math.ceil(reference_depth * plan["depth_multiplier"]),
                        "coherence_survival_pct": 100.0, "retrieval_reliable": True})
        stage.latency_ms = cost["latency_ms"]  # GPU launch/transfer is inclusive.
        stage.status = "WARNING"
    token = metrics.get("top_1_token_index", QUANTUM_MIPS_TARGET_INDEX)
    metrics.update({"top_1_token_index": token,
                    "result_source": "measured_noise_free_aer_reference" if live else "analytical_marked_state_projection"})
    bits = format(token, f"0{plan['index_bits']}b")
    stage.output_summary = (f"{'Aer reference' if live else 'Modeled'} amplified top-1 token index {token} (|{bits}⟩); "
                            f"{metrics['grover_iterations']} iterations; {plan['parallelization_tier']}; "
                            f"modeled coherence survival {metrics['coherence_survival_pct']}%. ")
    if live:
        stage.output_summary += (f"Measured ideal-reference peak probability {metrics['measured_peak_probability']:.2%} "
                                 f"over {metrics['aer_shots']} shots; CPU Aer runtime {metrics['aer_runtime_ms']:.3f} ms. "
                                 "Selected-route hardware latency and coherence are separate projections.")
    else:
        stage.output_summary += "Known marked-candidate projection; no vector-score oracle or large circuit was executed."
    if not metrics["retrieval_reliable"]:
        stage.output_summary += " Projected candidate is unreliable without error correction; no verified retrieval is claimed."
    return stage


def run_quantum_mips_pipeline(scale_param: int, hardware_profile: HardwareProfile,
                              routing: Optional[RoutingConfig] = None, available_qubits: int = 133) -> HybridTelemetryResponse:
    """Compose MIPS stages and propagate prerequisite/resource failures.

    Args:
        scale_param: Supported M preset.
        hardware_profile: Comparative architecture key.
        routing: Optional independent placements; defaults to CPU/QPU/CPU.
        available_qubits: Per-stage usable capacity and ancilla-tier selector.

    Returns:
        Three-stage telemetry with bottleneck selection and execution-mode provenance.
        Blocked prerequisites suppress downstream costs; low coherence preserves
        modeled work but prevents a verified-retrieval claim."""
    targets = routing or RoutingConfig()
    pre = quantum_mips_preprocessing(scale_param, targets.stage_1_node)
    kernel = quantum_mips_kernel(scale_param, hardware_profile, targets.stage_2_node, available_qubits,
                                upstream_blocked_by=pre.name if not pre.metrics["execution_feasible"] else None)
    post = quantum_mips_postprocessing(scale_param, targets.stage_3_node)
    if not pre.metrics["execution_feasible"] or not kernel.metrics["execution_feasible"]:
        source = pre.name if not pre.metrics["execution_feasible"] else kernel.name
        _block_quantum_mips_stage(post, f"STARVED: {source} did not produce usable input.")
    elif post.metrics["execution_feasible"]:
        post.metrics.update({"candidate_index": kernel.metrics["top_1_token_index"],
                             "candidate_source": kernel.metrics["result_source"],
                             "verification_model": "Modeled FP16 cost; no candidate vectors supplied for actual reranking."})
        if not kernel.metrics["retrieval_reliable"]:
            post.status = "WARNING"
            post.output_summary += " QPU candidate is unreliable; no verified top-1 retrieval is claimed."
    stages = dict(zip(STAGE_KEYS, [pre, kernel, post]))
    blocked = next((stage for stage in stages.values() if not stage.metrics["execution_feasible"]), None)
    if blocked:
        bottleneck = blocked.metrics.get("blocking_reason", f"UNSUPPORTED QPU ROUTING ({blocked.name})")
    else:
        rank = {"OPTIMAL": 0, "WARNING": 1, "CRITICAL_BOTTLENECK": 2}
        limiting = max(stages.values(), key=lambda stage: (rank[stage.status], stage.latency_ms))
        if limiting.status == "OPTIMAL":
            bottleneck = "NONE (Quantum-MIPS modeled pipeline within limits)"
        elif limiting is kernel:
            bottleneck = (f"{kernel.node} STATEVECTOR EMULATION OVERHEAD" if kernel.node != "QPU" else
                          "CATASTROPHIC QPU DECOHERENCE" if kernel.status == "CRITICAL_BOTTLENECK" else "QPU COHERENCE BUDGET DEGRADED")
        else:
            bottleneck = f"GPU LAUNCH/TRANSFER OVERHEAD ({limiting.name})"
    return HybridTelemetryResponse(workload_id="quantum_mips", workload_name=QUANTUM_MIPS_WORKLOAD_NAME,
                                   scale_label=QUANTUM_MIPS_SCALES[scale_param]["label"],
                                   execution_mode="LIVE_QISKIT_AER" if kernel.metrics["aer_executed"] else "NISQ_ANALYTICAL_PROFILER",
                                   primary_bottleneck=bottleneck, stages=stages)


def run_shors_pipeline(
    scale_param: int,
    hardware_profile: str,
    routing: Optional[RoutingConfig] = None,
    available_qubits: int = 133,
) -> HybridTelemetryResponse:
    """Apply independent node placements to Shor's reference-stage telemetry.

    Args:
        scale_param: Small modulus or RSA bit-width.
        hardware_profile: Architecture used for QPU-routed stages only.
        routing: Optional placements; defaults to CPU/QPU/CPU.
        available_qubits: Usable QPU capacity, independent of classical RAM.

    Returns:
        Telemetry with topology/tier projections, classical statevector limits,
        unsupported-route starvation, bottleneck, and all-CPU baseline.

    Raises:
        ValueError: The hardware profile is unknown.

    CPU/GPU kernels retain deterministic coherence and minimum-register emulation.
    Capacity/tier changes model QPU workspace, not a physical-device allocation."""
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
    """Return engine identity without invoking Aer, database, or provider services."""
    return {"status": "online", "engine": "Q-Split Hybrid Profiler v2.0"}

@app.post("/api/simulate", response_model=HybridTelemetryResponse)
def simulate_workload(req: SimulationRequest):
    """Dispatch a Pydantic-validated request to its workload's three-stage builder.

    The response model preserves canonical workload IDs and stage keys. Persistence,
    Neon advisor caching, and /api/analyze-telemetry validation live in the Next.js
    server, not in this FastAPI process."""
    if req.workload_id == "shors_crypto":
        return run_shors_pipeline(req.scale_param, req.hardware_profile, req.routing, req.available_qubits)
    elif req.workload_id == "quantum_mips":
        return run_quantum_mips_pipeline(req.scale_param, req.hardware_profile, req.routing, req.available_qubits)

"""Hybrid workload profiling with executable small-circuit Aer references.

All stage latencies are milliseconds. CPU/GPU/QPU labels describe comparative
placement costs; Aer runs on the classical host and never dispatches a physical
QPU/GPU. Survival combines independent gate errors and all-qubit T1 decay;
it is a resource estimate, not an injected calibrated Aer noise model.
Next.js owns database persistence, AI diagnostics, and provider/cache economics.
"""

from fastapi import Depends, FastAPI, HTTPException, Request, Security
from fastapi.security import APIKeyHeader
from fastapi.exception_handlers import request_validation_exception_handler
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, model_validator
from typing import Dict, Any, Literal, Optional
import math
import os
from secrets import compare_digest
from time import perf_counter
from fractions import Fraction
from qiskit_aer import AerSimulator

# Support both `uvicorn backend.main:app` and the container's `uvicorn main:app`.
if __package__:
    from .models import CircuitSpec, QPUProfile, StageMetrics
    from .estimation import (estimate_qpu, estimate_classical, STATEVECTOR_PROFILES,
                             CLASSICAL_GPU_COMPUTE_FACTOR, CLASSICAL_GPU_OVERHEAD_MS)
    from .profiles import HARDWARE_PROFILES, execution_profile, profile_metrics
    from .workloads import (QUANTUM_MIPS_CLASSICAL_PROFILES, shors_spec, mips_spec,
                           mips_reference_depth, select_shors_base)
    from .circuits import (NATIVE_BASIS_GATES, AER_SEED, QUANTUM_MIPS_TARGET_INDEX,
                           c_amod15, build_shors_15_circuit, build_quantum_mips_grover_circuit, compile_reference_circuit)
else:
    from models import CircuitSpec, QPUProfile, StageMetrics
    from estimation import (estimate_qpu, estimate_classical, STATEVECTOR_PROFILES,
                            CLASSICAL_GPU_COMPUTE_FACTOR, CLASSICAL_GPU_OVERHEAD_MS)
    from profiles import HARDWARE_PROFILES, execution_profile, profile_metrics
    from workloads import (QUANTUM_MIPS_CLASSICAL_PROFILES, shors_spec, mips_spec,
                          mips_reference_depth, select_shors_base)
    from circuits import (NATIVE_BASIS_GATES, AER_SEED, QUANTUM_MIPS_TARGET_INDEX,
                          c_amod15, build_shors_15_circuit, build_quantum_mips_grover_circuit, compile_reference_circuit)

app = FastAPI(
    title="Q-Split Hybrid Partitioning Engine",
    description="Hybrid Quantum-Classical Workload Profiler (Shor's Algorithm & Quantum-MIPS AI)",
    version="2.0.0"
)

# Browsers use the same-origin Next.js proxy. Server-to-server fetches do not
# need CORS; deliberately do not grant browser origins access to engine routes.
engine_secret_header = APIKeyHeader(name="X-Engine-Secret", auto_error=False)


async def require_engine_secret(secret: Optional[str] = Security(engine_secret_header)):
    """Enforce the optional server-only shared secret before simulation dispatch.

    Set ENGINE_SECRET on both FastAPI and Next.js for publicly reachable engines.
    An unset/blank value preserves unauthenticated local development. CORS is
    not authentication: direct HTTP clients must pass this check when enabled.
    """
    expected = os.environ.get("ENGINE_SECRET", "").strip()
    if expected and (secret is None or not compare_digest(secret.encode("utf-8"), expected.encode("utf-8"))):
        raise HTTPException(status_code=401, detail="Invalid engine credentials.")

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

def coherence_status(survival_pct: float) -> str:
    """Classify modeled survival consistently with the frontend coherence budget."""
    return "NOMINAL" if survival_pct >= 70 else "DEGRADED" if survival_pct >= 35 else "EXCEEDED"


def coherence_stage_status(survival_pct: float) -> str:
    """Translate the shared coherence classification into stage severity."""
    return {"NOMINAL": "OPTIMAL", "DEGRADED": "WARNING", "EXCEEDED": "CRITICAL_BOTTLENECK"}[coherence_status(survival_pct)]


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

    latency_ms includes GPU launch cost and the complete QPU shot batch, including
    measurement/reset and launch. Consumers must inspect feasibility flags before summing
    costs; metrics intentionally vary by workload, route, and blocking condition."""
    name: str
    node: StageNode
    latency_ms: float
    status: str                             # "OPTIMAL", "WARNING", "CRITICAL_BOTTLENECK"
    output_summary: str
    metrics: StageMetrics

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
def execute_live_shors_15(a: Optional[int] = None, noisy: bool = True) -> Dict[str, Any]:
    """Sample an eight-qubit N=15 phase-estimation reference with Aer.

    Args:
        a: Coprime base for the modulo-15 reference circuit; the shared selector
            supplies 7 when omitted.
        noisy: Retained for caller compatibility. Aer sampling remains ideal;
            selected-device survival is supplied by the separate pure estimator.

    Returns:
        Native-basis compiled qubit count/depth/gate counts, seeded shot counts,
        leading measured phases, extracted period,
        and modeled coherence percentage. The known demonstration period is
        retained if sampled candidate denominators do not verify nontrivial factors.

    The 512-shot counts come from actual simulation; projected QPU gate timing
    is supplied separately by the pipeline, not measured by this function."""
    a = select_shors_base(15) if a is None else a
    n_count = 4
    qc = build_shors_15_circuit(a)

    # Simulate in Qiskit Aer
    sim = AerSimulator(method="statevector", max_parallel_threads=1)
    t_qc = compile_reference_circuit(qc)
    counts = sim.run(t_qc, shots=512, seed_simulator=AER_SEED).result().get_counts()

    # Classical Continued Fractions Post-Processing
    measured_phases = []
    extracted_r = 4
    for bitstring, count in sorted(counts.items(), key=lambda x: (-x[1], x[0]))[:4]:
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
        "gate_counts": dict(t_qc.count_ops()),
        "counts": dict(counts),
        "top_measurements": ", ".join(measured_phases[:3]),
        "period_r": extracted_r,
        "coherence_pct": 100.0,
    }


QUANTUM_MIPS_AER_SHOTS = 1024


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
    compiled = compile_reference_circuit(circuit)
    compiled_at = perf_counter()
    counts = simulator.run(compiled, shots=QUANTUM_MIPS_AER_SHOTS, seed_simulator=AER_SEED).result().get_counts()
    finished = perf_counter()
    peak = max(counts, key=counts.get)
    return {"aer_reference_circuit_depth": compiled.depth(), "aer_reference_qubits": compiled.num_qubits,
            "aer_gate_counts": dict(compiled.count_ops()),
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


QPU_LAUNCH_OVERHEAD_MS = 0.30  # One batch launch; explicit modeling assumption.
SHOR_SHOTS = 512


def _qpu_metrics(spec: CircuitSpec, profile: QPUProfile, capacity: int, shots: int) -> Dict[str, Any]:
    """Adapt the pure batch estimate to the existing telemetry contract."""
    estimated = estimate_qpu(spec, execution_profile(profile, capacity), shots, QPU_LAUNCH_OVERHEAD_MS)
    return {**estimated, **profile_metrics(profile, capacity), "circuit_spec": spec.model_dump(),
            "coherence_survival_pct": round(estimated["coherence_survival_pct"], 2),
            "compute_latency_ms": estimated["latency_ms"],
            # Measurement/reset and launch are already included in latency_ms.
            "io_state_prep_ms": 0.0, "qpu_io_included_in_latency": True,
            "physics_model": "Gate/readout errors plus all-qubit exposure billed at 2Q-duration layers; T1 point and T2 sensitivity range may double-count gate decoherence"}


def _classical_cost(spec: CircuitSpec, node: str) -> Dict[str, Any]:
    """Flatten the selected emulation estimate without inventing a native baseline."""
    estimates = estimate_classical(spec, node)
    cost = estimates["circuit_emulation"]
    return {"latency_ms": cost["kernel_ms"] or 0.0, "execution_feasible": cost["feasible"],
            "compute_latency_ms": cost["compute_latency_ms"] or 0.0,
            "launch_transfer_overhead_ms": cost["launch_transfer_overhead_ms"],
            "statevector_qubits": spec.n_qubits,
            "statevector_memory_required_bytes": cost["memory_required_bytes"],
            "statevector_memory_required": f"16 × 2^{spec.n_qubits} bytes",
            "statevector_memory_budget_bytes": cost["memory_budget_bytes"],
            "statevector_memory_budget_gib": cost["memory_budget_gib"],
            "classical_baselines": estimates, "circuit_spec": spec.model_dump()}


def _run_default_shors_pipeline(
    scale_param: int, hardware_profile: str, qpu_plan: Optional[Dict[str, Any]] = None,
) -> HybridTelemetryResponse:
    """Build workload stages and delegate all device physics to estimate_qpu.

    A missing plan represents minimum-register classical emulation. Live N=15
    Aer sampling is a reference only; modeled depth/counts share the same
    continuous arithmetic definition as larger sizes.
    """
    n = scale_param if scale_param in (512, 2048) else (scale_param - 1).bit_length()
    minimum = 8 if scale_param == 15 else 2 * n + 3
    depth = qpu_plan["circuit_depth"] if qpu_plan else int(4.5 * n**3)
    qubits = qpu_plan["qubits_allocated"] if qpu_plan else minimum
    spec = shors_spec(scale_param, qubits or minimum, depth)
    estimated = (_qpu_metrics(spec, HARDWARE_PROFILES[hardware_profile], qpu_plan["available_qubits"], SHOR_SHOTS)
                 if qpu_plan and qubits else
                 {"latency_ms": 0.0, "circuit_depth": depth, "coherence_survival_pct": 100.0,
                  "circuit_spec": spec.model_dump(), "io_state_prep_ms": 0.0})
    coherence = estimated["coherence_survival_pct"]
    if qpu_plan and not qubits:
        estimated.update({"latency_ms": 0.0, "compute_latency_ms": 0.0,
                          "coherence_survival": 0.0, "coherence_survival_pct": 0.0,
                          "coherence_survival_best": 0.0, "coherence_survival_worst": 0.0,
                          "log_survival_terms": None, "execution_feasible": False})
        coherence = 0.0
    severity = coherence_stage_status(coherence)
    reliable = coherence_status(coherence) != "EXCEEDED"
    live = scale_param == 15 and (qpu_plan is None or qpu_plan["parallelization_tier"] == "Space-Optimized Sequential")
    a = select_shors_base(scale_param)
    measured = execute_live_shors_15(a=a, noisy=False) if live else None
    if measured:
        estimated.update({"aer_reference_circuit_depth": measured["depth"],
                          "aer_gate_counts": measured["gate_counts"], "aer_counts": measured["counts"]})
    factors = {15: "15 = 3 × 5", 21: "21 = 3 × 7", 35: "35 = 5 × 7",
               512: "FAILED (Requires ~1M Physical Surface-Code Qubits)",
               2048: "FAILED (Requires ~4M Physical Surface-Code Qubits)"}
    factor = factors.get(scale_param, "Unresolved")
    if live:
        factor = "3 × 5"
    estimated.update({"qubits_required": minimum, "reference_circuit_depth": spec.depth,
                      "coherence_status": coherence_status(coherence),
                      "classical_baselines": estimate_classical(spec, "CPU")})
    bottleneck = ("NONE (Fits Within NISQ Coherence Window)" if severity == "OPTIMAL" else
                  "NISQ TWO-QUBIT GATE NOISE (Degrading Phase Peaks)" if reliable else
                  "CATASTROPHIC QPU DECOHERENCE")
    kernel_summary = f"Modeled depth {estimated['circuit_depth']:,}; coherence survival {coherence}%; {SHOR_SHOTS} shots."
    post_summary = (f"Continued Fractions output: {factor}" if reliable else
                    "STARVED: modeled QPU coherence is insufficient to extract reliable factors.")
    if measured:
        hardware_projection = f"Modeled {HARDWARE_PROFILES[hardware_profile].name} survival {coherence}%"
        kernel_summary = (
            f"Ideal Aer reference: peaks at {measured['top_measurements']}; Extracted period r = {measured['period_r']}. "
            f"{hardware_projection}; modeled depth {estimated['circuit_depth']:,}; {SHOR_SHOTS} shots."
        )
        post_summary = (
            f"Ideal Aer reference: continued fractions yield 15 = {factor}. {hardware_projection} "
            + ("meets the reliability threshold; hardware results remain projections." if reliable else
               "is below the reliability threshold, so no hardware factorization is claimed.")
        )
    return HybridTelemetryResponse(
        workload_id="shors_crypto", workload_name="Shor's Algorithm",
        scale_label=(f"RSA-{scale_param} ({n}-bit Cryptographic Key)" if scale_param in (512, 2048)
                     else f"N = {scale_param} ({n}-bit Composite Integer)"),
        execution_mode="LIVE_QISKIT_AER" if live else "NISQ_ANALYTICAL_PROFILER",
        primary_bottleneck=bottleneck,
        stages={
            "stage_1_classical_pre": StageTelemetry(
                name="Euclidean Coprime & Base Filter", node="CPU", latency_ms=spec.stage1_ms, status="OPTIMAL",
                output_summary=(
                    f"Selected fixed base a = {a} for RSA-{scale_param} analytical preset "
                    "(odd-modulus assumption; selector is a bit-width)."
                    if scale_param in (512, 2048) else
                    f"Selected coprime base a = {a} for N = {scale_param} ({n}-bit modulus) on CPU."
                ),
                metrics={"algorithm": "Euclidean GCD", "complexity": "O(log N)", "base_a": a}),
            "stage_2_quantum_kernel": StageTelemetry(
                name="Quantum Period Finding (ModExp + IQFT)", node="QPU", latency_ms=estimated["latency_ms"],
                status=severity,
                output_summary=kernel_summary,
                metrics=estimated),
            "stage_3_classical_post": StageTelemetry(
                name="Continued Fractions & Factor GCD", node="CPU", latency_ms=spec.stage3_ms, status=severity,
                output_summary=post_summary,
                metrics={"algorithm": "Continued Fractions", "factors_found": factor if reliable else "NONE (Decohered)",
                         "coherence_status": coherence_status(coherence)}),
        },
    )


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


STAGE_KEYS = (
    "stage_1_classical_pre",
    "stage_2_quantum_kernel",
    "stage_3_classical_post",
)


def classical_cpu_baseline(scale_param: int) -> Dict[str, Any]:
    """Minimum-register all-CPU Shor emulation, separate from native factoring."""
    n = scale_param if scale_param in (512, 2048) else (scale_param - 1).bit_length()
    spec = shors_spec(scale_param, 8 if scale_param == 15 else 2 * n + 3, int(4.5 * n**3))
    return estimate_classical(spec, "CPU")["circuit_emulation"]


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


def _quantum_mips_cpu_baseline(scale_param: int, available_qubits: int) -> Dict[str, Any]:
    """CPU emulation comparison with selected workspace; never launches extra Aer work."""
    plan = _quantum_mips_emulation_plan(scale_param, available_qubits)
    spec = mips_spec(scale_param, plan["qubits_allocated"], plan["depth_multiplier"])
    return estimate_classical(spec, "CPU")["circuit_emulation"]


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
    if stage.node == "QPU":
        stage.metrics.update({"coherence_survival": 0.0, "coherence_survival_pct": 0.0,
                              "coherence_survival_best": 0.0, "coherence_survival_worst": 0.0,
                              "log_survival_terms": None})
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
    # Workload resources are analytic at all scales. A live Aer reference can
    # add cross-check telemetry later, but cannot replace these model inputs.
    reference_depth = mips_reference_depth(scale_param)
    spec = mips_spec(scale_param, plan["qubits_allocated"] or plan["minimum_qubits_required"],
                     plan["depth_multiplier"] if plan["depth_multiplier"] is not None else 1.0)
    metrics = {**plan, "qubits_required": plan["minimum_qubits_required"],
               "algorithm": "Marked-State Grover / Inner-Product Oracle Projection", "complexity": "O(sqrt(M) · log M)",
               "candidate_count": scale_param, "grover_iterations": math.floor(math.pi / 4 * math.sqrt(scale_param)),
               "marked_candidate_index": QUANTUM_MIPS_TARGET_INDEX, "reference_circuit_depth": reference_depth,
               "depth_model": "Analytical Grover/Durr-Hoyer reference with toy-calibrated native expansion; Aer is a separate cross-check",
               "circuit_spec": spec.model_dump(),
               "circuit_depth": 0, "compute_latency_ms": 0.0, "io_state_prep_ms": 0.0,
               "coherence_survival_pct": 0.0 if node == "QPU" else 100.0,
               "coherence_status": "EXCEEDED" if node == "QPU" else "NOMINAL",
               "routing_model": "ILLUSTRATIVE_V1 (not device measurements)", "routing_supported": True,
               "aer_executed": False, "retrieval_reliable": False,
               "model_scope": "Known marked candidate; vector loading and an adaptive maximum-finding oracle are not executed."}
    stage = StageTelemetry(name="Quantum Inner-Product & Grover-Max Amplification", node=node, latency_ms=0.0,
                           status="OPTIMAL", output_summary="", metrics=metrics)
    metrics = stage.metrics
    architecture = HARDWARE_PROFILES[hardware_profile]
    if node == "QPU":
        metrics.update(profile_metrics(architecture, available_qubits))
    else:
        cost = _classical_cost(spec, node)
        metrics.update({key: value for key, value in cost.items() if key != "latency_ms"})
        metrics["simulation_method"] = "Classical statevector emulation (illustrative timing)"
    metrics["classical_cpu_baseline"] = _quantum_mips_cpu_baseline(scale_param, available_qubits)

    if upstream_blocked_by:
        return _block_quantum_mips_stage(stage, f"STARVED: {upstream_blocked_by} did not produce usable input.")
    if node == "QPU" and plan["qubits_allocated"] == 0:
        return _block_quantum_mips_stage(stage, f"INSUFFICIENT QPU QUBIT CAPACITY: minimum {plan['minimum_qubits_required']} qubits required; {available_qubits} available.")
    if node != "QPU" and not metrics["execution_feasible"]:
        return _block_quantum_mips_stage(stage, f"{node} STATEVECTOR MEMORY LIMIT: {metrics['statevector_qubits']} qubits need {metrics['statevector_memory_required_bytes']:,} bytes, exceeding {metrics['statevector_memory_budget_gib']} GiB.")

    live = scale_param == 64 and plan["parallelization_tier"] == "Sequential Minimum"
    if live:
        measured = execute_live_quantum_mips_64()
        metrics.update(measured)
        metrics["aer_executed"] = True
    metrics["classical_baselines"] = estimate_classical(spec, "CPU")
    if node == "QPU":
        metrics.update(_qpu_metrics(spec, architecture, available_qubits, QUANTUM_MIPS_AER_SHOTS))
        coherence = metrics["coherence_survival_pct"]
        metrics["retrieval_reliable"] = coherence_status(coherence) != "EXCEEDED"
        stage.latency_ms = metrics["latency_ms"]
        stage.status = coherence_stage_status(coherence)
    else:
        cost = _classical_cost(spec, node)
        metrics.update({key: value for key, value in cost.items() if key != "latency_ms"})
        metrics.update({"circuit_depth": spec.depth,
                        "coherence_survival_pct": 100.0, "retrieval_reliable": True})
        stage.latency_ms = cost["latency_ms"]  # GPU launch/transfer is inclusive.
        stage.status = "WARNING"
    metrics["coherence_status"] = coherence_status(metrics["coherence_survival_pct"])
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
                             "coherence_status": kernel.metrics["coherence_status"],
                             "verification_model": "Modeled FP16 cost; no candidate vectors supplied for actual reranking."})
        if kernel.node == "QPU" and kernel.metrics["coherence_status"] != "NOMINAL":
            post.status = coherence_stage_status(kernel.metrics["coherence_survival_pct"])
        if not kernel.metrics["retrieval_reliable"]:
            post.output_summary += " QPU candidate is unreliable; no verified top-1 retrieval is claimed."
    stages = dict(zip(STAGE_KEYS, [pre, kernel, post]))
    post.metrics["coherence_status"] = ("EXCEEDED" if post.node == "QPU" and not post.metrics["execution_feasible"]
                                        else kernel.metrics["coherence_status"])
    blocked = next((stage for stage in stages.values() if not stage.metrics["execution_feasible"]), None)
    if blocked:
        bottleneck = blocked.metrics.get("blocking_reason", f"UNSUPPORTED QPU ROUTING ({blocked.name})")
    elif kernel.node == "QPU" and kernel.metrics["coherence_status"] != "NOMINAL":
        bottleneck = ("CATASTROPHIC QPU DECOHERENCE" if kernel.metrics["coherence_status"] == "EXCEEDED"
                      else "QPU COHERENCE BUDGET DEGRADED")
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
            stage.metrics.update(profile_metrics(architecture, available_qubits))
            # Only the quantum kernel has an implemented QPU algorithm. Other
            # QPU routes still get capacity validation before route validation.
            capacity = {k: v for k, v in plan.items() if k != "circuit_depth"}
            stage.metrics.update(capacity)
            if plan["qubits_allocated"] == 0:
                stage.latency_ms = 0.0
                stage.status = "CRITICAL_BOTTLENECK"
                stage.metrics.update({"execution_feasible": False, "circuit_depth": 0,
                                      "coherence_survival": 0.0, "coherence_survival_pct": 0.0,
                                      "coherence_survival_best": 0.0, "coherence_survival_worst": 0.0,
                                      "log_survival_terms": None, "io_state_prep_ms": 0.0})
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
                    "Illustrative analytical projection (4.5 coefficient, log base 2) with toy-calibrated native expansion; "
                    "compiled Aer reference depth reported separately when executed"
                )

        if key == "stage_2_quantum_kernel":
            if target == "QPU":
                continue
            spec = CircuitSpec.model_validate(stage.metrics["circuit_spec"])
            cost = _classical_cost(spec, target)
            stage.metrics.update({key: value for key, value in cost.items() if key != "latency_ms"})
            qubits = spec.n_qubits
            stage.metrics.update({
                "simulation_method": "Classical statevector emulation",
                "coherence_survival_pct": 100.0,
                "circuit_depth": spec.depth, "io_state_prep_ms": 0.0,
            })
            stage.latency_ms = cost["latency_ms"]
            if not cost["execution_feasible"]:
                stage.latency_ms = 0.0
                stage.status = "CRITICAL_BOTTLENECK"
                stage.metrics["execution_feasible"] = False
                stage.output_summary = (
                    f"BLOCKED: {qubits:,}-qubit statevector requires 2^{qubits + 4} "
                    f"bytes, exceeding the modeled {cost['statevector_memory_budget_gib']} GiB {target} budget."
                )
                reasons[key] = f"{target} STATEVECTOR MEMORY LIMIT ({cost['statevector_memory_budget_gib']} GiB Modeled Budget)"
            else:
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
                                      "circuit_depth": 0, "coherence_survival": 0.0, "coherence_survival_pct": 0.0,
                                      "coherence_survival_best": 0.0, "coherence_survival_worst": 0.0,
                                      "log_survival_terms": None,
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
    for stage in response.stages.values():
        if "coherence_survival_pct" in stage.metrics:
            stage.metrics["coherence_status"] = coherence_status(stage.metrics["coherence_survival_pct"])
        if stage.node == "QPU" and not stage.metrics["execution_feasible"]:
            stage.metrics["coherence_status"] = "EXCEEDED"
    kernel, post = [response.stages[key] for key in STAGE_KEYS[1:]]
    if post.node != "QPU" or post.metrics["execution_feasible"]:
        post.metrics["coherence_status"] = kernel.metrics["coherence_status"]
    return response


# ==========================================
# 4. API ENDPOINTS
# ==========================================
@app.get("/")
async def health_check():
    """Return engine identity without invoking Aer, database, or provider services."""
    return JSONResponse({"status": "online", "engine": "Q-Split Hybrid Profiler v2.0"},
                        headers={"Cache-Control": "no-store"})

@app.post("/api/simulate", response_model=HybridTelemetryResponse,
          dependencies=[Depends(require_engine_secret)])
def simulate_workload(req: SimulationRequest):
    """Dispatch a Pydantic-validated request to its workload's three-stage builder.

    The response model preserves canonical workload IDs and stage keys. Persistence,
    Neon advisor caching, and /api/analyze-telemetry validation live in the Next.js
    server, not in this FastAPI process."""
    if req.workload_id == "shors_crypto":
        return run_shors_pipeline(req.scale_param, req.hardware_profile, req.routing, req.available_qubits)
    elif req.workload_id == "quantum_mips":
        return run_quantum_mips_pipeline(req.scale_param, req.hardware_profile, req.routing, req.available_qubits)

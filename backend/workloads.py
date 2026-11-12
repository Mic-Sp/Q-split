"""Workload resource definitions, deliberately independent of QPU profiles."""

import math

if __package__:
    from .models import CircuitSpec
else:
    from models import CircuitSpec


DEPTH_EXPANSION_FACTOR = 5.45
"""First-order native-depth correction; model_assumption, not a scaling law.

Measured 2026-11-02 by backend/scripts/calibrate_depth.py with Qiskit 2.6.1,
Aer 0.18.0, basis {cx, rz, sx, x}, optimization level 1 and seed 7:
Shor N=15: depth 1594 / logical 288 = 5.534722222222222.
MIPS M=64: depth 1084 / logical 202 = 5.366336633663367.
Statistic type: arithmetic mean of those depth ratios (5.4505294279427945),
rounded to two decimals. This factor applies only to depth, not gate counts.
Both expansion factors were measured only on sequential-tier toy circuits.
They are applied unchanged to windowed/carry-lookahead (and MIPS multi-oracle)
tiers and large scales, with no evidence supporting that extrapolation.
N=15 is a specialized swap permutation, not general ModExp.
"""

GATE_COUNT_EXPANSION_FACTOR = 2.85
"""First-order native-gate-count correction; model_assumption, not a scaling law.

Measured 2026-11-02 by backend/scripts/calibrate_depth.py with Qiskit 2.6.1,
Aer 0.18.0, basis {cx, rz, sx, x}, optimization level 1 and seed 7:
Shor N=15: 1Q 1635 / proxy 576 = 2.8385416666666665;
           2Q 798 / proxy 288 = 2.7708333333333335.
MIPS M=64: 1Q 1161 / proxy 404 = 2.873762376237624;
           2Q 588 / proxy 202 = 2.910891089108911.
Statistic type: arithmetic mean of all four ratios (2.848507116336634), rounded
to two decimals. This factor applies to 1Q/2Q counts, independently of depth.
Both expansion factors were measured only on sequential-tier toy circuits.
They are applied unchanged to windowed/carry-lookahead (and MIPS multi-oracle)
tiers and large scales, with no evidence supporting that extrapolation.
N=15 is a specialized swap permutation, not general ModExp.
"""


def partition_transfer_count(n_qubits: int, n_2q: int, qubits_per_module: int, *, force_dual: bool = False) -> tuple[int, int]:
    """Deterministic V1 traffic approximation, independent of hardware routing.

    Auto packs the first module before spilling; explicit dual placement balances
    the register. Assume uniformly mixed CX operand pairs, so 2*left*right /
    (q*(q-1)) cross the partition. Each remote CX uses two state transfers
    (out and back). Round the remote CX count up once. Existing local gate
    resources remain charged; transfers add communication only. This is not a
    compiler-derived interaction graph or a dependency-aware network schedule.
    """
    if n_qubits <= qubits_per_module and not force_dual:
        return 1, 0
    if n_qubits < 2:
        raise ValueError("Dual placement requires at least two active qubits")
    left = (n_qubits + 1) // 2 if force_dual else qubits_per_module
    right = n_qubits - left
    # Integer ceiling avoids floating-point drift at large resource counts.
    denominator = n_qubits * (n_qubits - 1)
    remote_cx = (n_2q * 2 * left * right + denominator - 1) // denominator
    return 2, 2 * remote_cx


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


def select_shors_base(scale_param: int) -> int:
    """Choose a coprime toy base or a documented RSA reference base.

    N=15 keeps a=7 for the supported live modular-multiplication circuit.
    RSA selectors 512/2048 are bit-widths, not moduli: use fixed a=2 under
    the analytical preset's conventional odd-RSA-modulus assumption, without
    claiming to check an unspecified modulus. Other toy moduli use the smallest
    a>=2 coprime to N (a=3 for N=2).
    """
    if type(scale_param) is not int or scale_param < 2:
        raise ValueError("Shor scale must be an integer at least 2.")
    if scale_param == 15:
        return 7
    if scale_param in (512, 2048):
        return 2
    a = 2
    while math.gcd(a, scale_param) != 1:
        a += 1
    return a


def _expanded_gate_counts(logical_depth: int) -> tuple[int, int]:
    """Expand the same logical 1Q/2Q proxies for both workloads, independently of depth."""
    return (math.ceil(2 * logical_depth * GATE_COUNT_EXPANSION_FACTOR),
            math.ceil(logical_depth * GATE_COUNT_EXPANSION_FACTOR))


def shors_spec(scale: int, n_qubits: int, depth: int) -> CircuitSpec:
    """Shor arithmetic projection with explicit, illustrative gate-count proxies.

    Input depth is the logical workspace-tier depth. Separate toy-calibrated
    factors expand depth and gate counts at every scale, independently of whether
    Aer executes. Workspace changes depth, not total logical work. Both factors
    extrapolate from sequential-tier toys to other tiers/large scales without evidence.
    Compiled N=15 resources remain a separate cross-check, not model inputs.
    Native toy factoring uses a 10 ns/division trial-division cost assumption;
    RSA has no calibrated native factoring estimate and is left unavailable.
    """
    n = scale if scale in (512, 2048) else (scale - 1).bit_length()
    sequential_depth = int(4.5 * n**3)
    n_1q, n_2q = _expanded_gate_counts(sequential_depth)
    return CircuitSpec(
        n_qubits=n_qubits, depth=math.ceil(depth * DEPTH_EXPANSION_FACTOR),
        n_1q=n_1q, n_2q=n_2q,
        n_meas=min(n, n_qubits), stage1_ms=0.14 if scale == 15 else round(0.12 * math.log2(n), 2),
        stage3_ms=0.21 if scale == 15 else round(0.25 * n / 4, 2),
        native_classical_ms=None if scale in (512, 2048) else math.isqrt(scale) * 0.00001,
        native_classical_name="Trial division (illustrative 10 ns/division)" if scale not in (512, 2048) else None,
    )


def mips_reference_depth(scale: int) -> int:
    """Toy-calibrated native sequential depth from the same analytic law at every M."""
    logical_depth = round(4.2 * math.sqrt(scale) * math.log2(scale))
    return math.ceil(logical_depth * DEPTH_EXPANSION_FACTOR)


def mips_spec(scale: int, n_qubits: int, depth_multiplier: float = 1) -> CircuitSpec:
    """Analytic Grover resources at every scale, including live-reference M=64.

    Logical proxies assume two 1Q gates and one 2Q gate per sequential depth
    unit. The depth factor expands depth; the separate gate-count factor expands
    both gate counts, so 2Q count is not equated to expanded reference depth.
    Both factors extrapolate from sequential-tier toys to other tiers/large scales
    unchanged, with no evidence supporting that extrapolation.
    Oracle parallelism reduces depth without removing logical gates. Aer depth
    and gate counts are cross-checks only and never enter this specification.
    Native exhaustive MIPS assumes 768 dimensions and 2 ns per vector component,
    independent of the circuit's ancilla allocation; it is not a device benchmark.
    """
    logical_depth = round(4.2 * math.sqrt(scale) * math.log2(scale))
    reference_depth = mips_reference_depth(scale)
    n_1q, n_2q = _expanded_gate_counts(logical_depth)
    return CircuitSpec(
        n_qubits=n_qubits, depth=math.ceil(reference_depth * depth_multiplier),
        n_1q=n_1q, n_2q=n_2q,
        n_meas=(scale - 1).bit_length(),
        stage1_ms=QUANTUM_MIPS_CLASSICAL_PROFILES["stage_1_classical_pre"]["cpu_latency_ms"][scale],
        stage3_ms=QUANTUM_MIPS_CLASSICAL_PROFILES["stage_3_classical_post"]["cpu_latency_ms"][scale],
        native_classical_ms=scale * 768 * 2 / 1e6,
        native_classical_name="Exhaustive MIPS (illustrative d=768, 2 ns/component)",
    )

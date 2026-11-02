"""Compile toy references and measure separate depth and gate-count expansion, without FastAPI.

Run from the repository root:
    backend/venv/bin/python backend/scripts/calibrate_depth.py

This reports observations, not asserted reference counts. Measurements cover
sequential-tier toy circuits only. Applying either factor unchanged to windowed,
carry-lookahead or large-scale circuits has no supporting evidence. N=15 is a
specialized swap permutation, not general ModExp.
"""

import json
import math
from importlib.metadata import version
from pathlib import Path
import sys

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backend.circuits import (
    AER_SEED, NATIVE_BASIS_GATES, NATIVE_OPTIMIZATION_LEVEL,
    build_shors_15_circuit, build_quantum_mips_grover_circuit, compile_reference_circuit,
)


def calibrate() -> dict:
    """Return compiled statistics and independent depth/gate-count ratio means."""
    references = []
    for name, circuit, logical_depth in [
        ("Shor N=15", build_shors_15_circuit(), int(4.5 * 4**3)),
        ("MIPS M=64", build_quantum_mips_grover_circuit(), round(4.2 * math.sqrt(64) * math.log2(64))),
    ]:
        compiled = compile_reference_circuit(circuit)
        counts = compiled.count_ops()
        one_qubit_count = sum(counts.get(gate, 0) for gate in NATIVE_BASIS_GATES if gate != "cx")
        two_qubit_count = counts.get("cx", 0)
        analytic_one_qubit_count = 2 * logical_depth
        analytic_two_qubit_count = logical_depth
        references.append({
            "reference": name, "compiled_depth": compiled.depth(),
            "cx_count": two_qubit_count, "one_qubit_count": one_qubit_count,
            "analytic_depth": logical_depth, "depth_ratio": compiled.depth() / logical_depth,
            "analytic_one_qubit_count": analytic_one_qubit_count,
            "analytic_two_qubit_count": analytic_two_qubit_count,
            "one_qubit_ratio": one_qubit_count / analytic_one_qubit_count,
            "two_qubit_ratio": two_qubit_count / analytic_two_qubit_count,
        })
    mean_depth_ratio = sum(reference["depth_ratio"] for reference in references) / len(references)
    gate_count_ratios = [reference[key] for reference in references for key in ("one_qubit_ratio", "two_qubit_ratio")]
    mean_gate_count_ratio = sum(gate_count_ratios) / len(gate_count_ratios)
    return {
        "qiskit_version": version("qiskit"), "qiskit_aer_version": version("qiskit-aer"),
        "basis_gates": NATIVE_BASIS_GATES, "optimization_level": NATIVE_OPTIMIZATION_LEVEL,
        "seed_transpiler": AER_SEED, "references": references,
        "statistic_types": {
            "recommended_depth_expansion_factor": "Arithmetic mean of the two compiled/logical depth ratios, rounded to two decimals",
            "recommended_gate_count_expansion_factor": "Arithmetic mean of all four compiled/proxy gate-count ratios (1Q and 2Q for both references), rounded to two decimals",
        },
        "mean_depth_ratio": mean_depth_ratio, "mean_gate_count_ratio": mean_gate_count_ratio,
        "recommended_depth_expansion_factor": round(mean_depth_ratio, 2),
        "recommended_gate_count_expansion_factor": round(mean_gate_count_ratio, 2),
        "limitation": "Measured only on two sequential-tier toy circuits; applying either factor unchanged to windowed/carry-lookahead tiers or large scales has no supporting evidence. N=15 is a specialized swap permutation, not general ModExp. Not a validated scaling law.",
    }


if __name__ == "__main__":
    print(json.dumps(calibrate(), indent=2))

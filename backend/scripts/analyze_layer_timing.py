"""Inspect toy reference layers separately from production latency estimation.

Run: backend/venv/bin/python backend/scripts/analyze_layer_timing.py

Counts are observed compiler outputs. Timing is a model_assumption using stored
profile durations, the longest gate in each dependency layer, and the existing
native_2q_per_cx assumption. No routing, shots, measurement/reset or launch are
included. This is not a calibrated hardware schedule or a scaling law.
"""

import json
from importlib.metadata import version
from pathlib import Path
import sys

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from qiskit.converters import circuit_to_dag

from backend.circuits import (
    AER_SEED, NATIVE_BASIS_GATES, NATIVE_OPTIMIZATION_LEVEL,
    build_shors_15_circuit, build_quantum_mips_grover_circuit, compile_reference_circuit,
)
from backend.profiles import HARDWARE_PROFILES


def reference_layer_counts(compiled) -> dict:
    """Count disjoint gate-layer categories; measurement-only layers are separate.

    Only the declared reference basis is supported. Unknown operations require
    explicit timing semantics rather than silently receiving a made-up duration.
    Measurements overlapping a gate layer do not add gate exposure here.
    """
    counts = dict(one_qubit_only_layers=0, two_qubit_only_layers=0,
                  mixed_gate_layers=0, measurement_only_layers=0)
    for layer in circuit_to_dag(compiled).layers():
        nodes = list(layer["graph"].op_nodes())
        if any(node.name not in {*NATIVE_BASIS_GATES, "measure"} for node in nodes):
            raise ValueError("Layer diagnostic requires a compiled {cx, rz, sx, x} reference.")
        one = any(node.name in {"rz", "sx", "x"} for node in nodes)
        two = any(node.name == "cx" for node in nodes)
        category = ("mixed_gate_layers" if one and two else "two_qubit_only_layers" if two else
                    "one_qubit_only_layers" if one else "measurement_only_layers")
        counts[category] += 1
    return counts


def reference_layer_timing(counts: dict, profile) -> dict:
    """Compare gate-layer duration with the current all-2Q billing convention."""
    cx_ns = profile.t_2q_ns * profile.native_2q_per_cx
    gate_ns = (counts["one_qubit_only_layers"] * profile.t_1q_ns
               + counts["two_qubit_only_layers"] * cx_ns
               + counts["mixed_gate_layers"] * max(profile.t_1q_ns, cx_ns))
    return {
        "layer_gate_ns": gate_ns,
        "all_depth_at_2q_ns": sum(counts.values()) * cx_ns,
        "value_type": "model_assumption",
        "statistic_type": "Derived sum of maximum stored gate durations per dependency layer",
        "note": "Longest operation per dependency layer; native CX conversion is assumed. Unrouted, per shot, excludes readout/reset/launch.",
        "source_url": profile.provenance["source_url"],
        "retrieval_date": profile.provenance["retrieval_date"],
    }


def analyze() -> dict:
    references = []
    for name, circuit in [("Shor N=15", build_shors_15_circuit()),
                          ("MIPS M=64", build_quantum_mips_grover_circuit())]:
        compiled = compile_reference_circuit(circuit)
        counts = reference_layer_counts(compiled)
        references.append({
            "reference": name, "compiled_depth": compiled.depth(), "layer_counts": counts,
            "statistic_type": "Observed dependency-layer counts from the compiled toy reference",
            "profile_timing": {key: reference_layer_timing(counts, profile)
                               for key, profile in HARDWARE_PROFILES.items()},
        })
    return {
        "qiskit_version": version("qiskit"), "basis_gates": NATIVE_BASIS_GATES,
        "optimization_level": NATIVE_OPTIMIZATION_LEVEL, "seed_transpiler": AER_SEED,
        "production_model_changed": False, "references": references,
    }


if __name__ == "__main__":
    print(json.dumps(analyze(), indent=2))

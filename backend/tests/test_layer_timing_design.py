"""Reference scheduling diagnostics must not silently change production physics."""

import pytest
from qiskit import QuantumCircuit

from backend.estimation import estimate_qpu
from backend.models import CircuitSpec
from backend.profiles import HARDWARE_PROFILES
from backend.scripts.analyze_layer_timing import analyze, reference_layer_counts, reference_layer_timing


def test_mixed_layer_uses_longest_duration_and_excludes_terminal_readout():
    circuit = QuantumCircuit(3, 3)
    circuit.x(0)
    circuit.cx(1, 2)
    circuit.measure(range(3), range(3))
    counts = reference_layer_counts(circuit)
    assert counts == {"one_qubit_only_layers": 0, "two_qubit_only_layers": 0,
                      "mixed_gate_layers": 1, "measurement_only_layers": 1}
    profile = HARDWARE_PROFILES["ionq_forte_trapped_ion"]
    timing = reference_layer_timing(counts, profile)
    assert timing["layer_gate_ns"] == max(profile.t_1q_ns, profile.t_2q_ns)
    assert timing["all_depth_at_2q_ns"] == 2 * profile.t_2q_ns
    # BYOC profiles need max(), even if their 1Q duration exceeds their 2Q time.
    slower_1q = profile.model_copy(update={"t_1q_ns": 2 * profile.t_2q_ns})
    assert reference_layer_timing(counts, slower_1q)["layer_gate_ns"] == slower_1q.t_1q_ns


def test_one_qubit_layers_use_1q_duration_without_changing_estimator_fallback():
    circuit = QuantumCircuit(2)
    circuit.x(0)
    circuit.x(0)
    circuit.cx(0, 1)
    counts = reference_layer_counts(circuit)
    profile = HARDWARE_PROFILES["ionq_forte_trapped_ion"]
    timing = reference_layer_timing(counts, profile)
    assert timing["layer_gate_ns"] == 2 * profile.t_1q_ns + profile.t_2q_ns
    spec = CircuitSpec(n_qubits=2, depth=3, n_1q=2, n_2q=1, n_meas=0, stage1_ms=0, stage3_ms=0)
    assert estimate_qpu(spec, profile, 1, 0)["t_circuit_us"] == 3 * profile.t_2q_ns / 1000


def test_unsupported_operation_requires_explicit_timing_semantics():
    circuit = QuantumCircuit(1)
    circuit.h(0)
    with pytest.raises(ValueError, match="compiled"):
        reference_layer_counts(circuit)


def test_actual_reference_layers_partition_compiled_depth_for_both_workloads():
    result = analyze()
    assert result["production_model_changed"] is False
    for reference in result["references"]:
        assert sum(reference["layer_counts"].values()) == reference["compiled_depth"]
        for timing in reference["profile_timing"].values():
            assert 0 < timing["layer_gate_ns"] <= timing["all_depth_at_2q_ns"]
            assert timing["value_type"] == "model_assumption"

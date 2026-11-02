"""Production reference circuits and compilation settings, independent of FastAPI."""

import math
from typing import Optional

from qiskit import QuantumCircuit, transpile
from qiskit.circuit.library import QFTGate

if __package__:
    from .workloads import select_shors_base
else:
    from workloads import select_shors_base


NATIVE_BASIS_GATES = ["cx", "rz", "sx", "x"]
AER_SEED = 7
SHOR_SHOTS = 512
QUANTUM_MIPS_AER_SHOTS = 1024
NATIVE_OPTIMIZATION_LEVEL = 1
QUANTUM_MIPS_TARGET_INDEX = 45  # Marked-state demonstration, not a vector search.


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


def build_shors_15_circuit(a: Optional[int] = None) -> QuantumCircuit:
    """Build the eight-qubit swap-permutation period-finding reference for N=15.

    This reference is not a general modular-exponentiation implementation.
    The default base is the shared selector's supported a=7.
    """
    a = select_shors_base(15) if a is None else a
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
    return qc


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


def compile_reference_circuit(circuit: QuantumCircuit) -> QuantumCircuit:
    """Use exactly the same basis, optimization and seed for calibration and Aer."""
    return transpile(circuit, basis_gates=NATIVE_BASIS_GATES,
                     optimization_level=NATIVE_OPTIMIZATION_LEVEL, seed_transpiler=AER_SEED)

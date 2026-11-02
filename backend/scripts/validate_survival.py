"""Compare noisy toy-circuit observations with analytic survival, outside FastAPI.

Run: backend/venv/bin/python backend/scripts/validate_survival.py [--shots COUNT]

Uses the production compiler, seeds and default shot counts. The noise channels
are explicit approximations derived from QPUProfile, not vendor calibrations:
uniform nonidentity Pauli errors, symmetric readout flips and gate-local thermal
relaxation. Output probabilities are not no-error survival or factoring success,
so the analytic best/worst scenarios are not bounds on the sampled metric.

Aer references:
https://qiskit.github.io/qiskit-aer/stubs/qiskit_aer.noise.depolarizing_error.html
https://qiskit.github.io/qiskit-aer/stubs/qiskit_aer.noise.thermal_relaxation_error.html
"""

import argparse
from importlib.metadata import version
from pathlib import Path
import sys

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from qiskit_aer import AerSimulator
from qiskit_aer.noise import NoiseModel, ReadoutError, depolarizing_error, thermal_relaxation_error

from backend.circuits import (
    AER_SEED, NATIVE_BASIS_GATES, SHOR_SHOTS, QUANTUM_MIPS_AER_SHOTS, QUANTUM_MIPS_TARGET_INDEX,
    build_shors_15_circuit, build_quantum_mips_grover_circuit, compile_reference_circuit,
)
from backend.estimation import estimate_qpu
from backend.models import QPUProfile, RESOURCE_MODEL_VERSION, ROUTING_MODEL
from backend.profiles import HARDWARE_PROFILES
from backend.workloads import shors_spec, mips_spec


def build_noise_model(profile: QPUProfile) -> NoiseModel:
    """Map the stored error probabilities and durations onto the CX reference basis.

    Interpret err_1q/err_2q as total nonidentity Pauli probability p. Aer uses
    lambda in E(rho)=(1-lambda)rho+lambda*I/2**n, so lambda=p*4**n/(4**n-1).
    Apply that channel followed by thermal relaxation on participating qubits.
    All 1Q basis gates, including rz, use the stored representative t_1q_ns;
    this is not a device-specific virtual-Z schedule. CX receives one native
    noise channel per native_2q_per_cx, without pretending to compile sqrt(iSWAP).
    No topology routing, unscheduled idle exposure or reset-after-readout is
    inserted. Readout uses err_meas; gate-local relaxation excludes measurement.
    """
    profile = QPUProfile.model_validate(profile)
    native_count = int(profile.native_2q_per_cx)
    if native_count != profile.native_2q_per_cx:
        raise ValueError("Aer CX noise proxy requires an integer native_2q_per_cx.")
    t1 = profile.t1_us
    t2 = profile.t2_us if profile.t2_us is not None else t1
    if t1 is not None and t2 is not None and t2 > 2 * t1:
        raise ValueError("Aer thermal relaxation requires T2 <= 2*T1; profile was not clamped.")

    def gate_error(qubits: int, probability: float, duration_ns: float):
        paulis = 4 ** qubits
        error = depolarizing_error(probability * paulis / (paulis - 1), qubits)
        if t1 is not None or t2 is not None:
            relaxation = thermal_relaxation_error(
                t1 if t1 is not None else float("inf"),
                t2 if t2 is not None else float("inf"), duration_ns / 1000,
            )
            error = error.compose(relaxation if qubits == 1 else relaxation.tensor(relaxation))
        return error

    noise = NoiseModel(basis_gates=NATIVE_BASIS_GATES)
    one = gate_error(1, profile.err_1q, profile.t_1q_ns)
    two = gate_error(2, profile.err_2q, profile.t_2q_ns)
    native = two
    for _ in range(native_count - 1):
        two = two.compose(native)
    noise.add_all_qubit_quantum_error(one, [gate for gate in NATIVE_BASIS_GATES if gate != "cx"])
    noise.add_all_qubit_quantum_error(two, "cx")
    error = profile.err_meas
    noise.add_all_qubit_readout_error(ReadoutError([[1 - error, error], [error, 1 - error]]))
    return noise


def validation_rows(shots: int | None = None):
    """Yield actual seeded counts and the separate sequential-tier analytic model."""
    if shots is not None and (type(shots) is not int or shots < 1):
        raise ValueError("shots must be a positive integer")
    for label, circuit, default_shots in [
        ("N=15", build_shors_15_circuit(), SHOR_SHOTS),
        ("MIPS-64", build_quantum_mips_grover_circuit(), QUANTUM_MIPS_AER_SHOTS),
    ]:
        compiled = compile_reference_circuit(circuit)
        # Reuse the production workload laws; compiled counts are a cross-check,
        # not a replacement for the toy-calibrated analytic resources.
        spec = (shors_spec(15, compiled.num_qubits, int(4.5 * (15 - 1).bit_length() ** 3))
                if label == "N=15" else mips_spec(64, compiled.num_qubits))
        batch_shots = default_shots if shots is None else shots
        for profile_id, profile in HARDWARE_PROFILES.items():
            if profile_id == "ideal_sim":
                continue
            simulator = AerSimulator(method="density_matrix", noise_model=build_noise_model(profile),
                                     max_parallel_threads=1)
            result = simulator.run(compiled, shots=batch_shots, seed_simulator=AER_SEED).result()
            if not result.success:
                raise RuntimeError(f"Aer failed for {label}/{profile_id}: {result.status}")
            counts = dict(result.get_counts())
            observed_shots = sum(counts.values())
            if observed_shots != batch_shots:
                raise RuntimeError("Aer returned an incomplete shot batch.")
            if label == "N=15":
                success_count = max(counts.values())
                metric = "peak probability"
            else:
                marked = format(QUANTUM_MIPS_TARGET_INDEX, f"0{compiled.num_clbits}b")
                success_count = counts.get(marked, 0)
                metric = f"P({marked})"
            # Launch costs do not enter per-shot analytic survival.
            analytic = estimate_qpu(spec, profile, batch_shots, launch_overhead_ms=0)
            yield {
                "workload": label, "profile": profile_id, "metric": metric,
                "shots": observed_shots, "counts": counts, "success_count": success_count,
                "measured_probability": success_count / observed_shots,
                "analytic_best": analytic["coherence_survival_best"],
                "analytic_point": analytic["coherence_survival"],
                "analytic_worst": analytic["coherence_survival_worst"],
                "compiled_depth": compiled.depth(), "gate_counts": dict(compiled.count_ops()),
            }


def main(argv=None) -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--shots", type=int, help="Override both existing default shot counts (512 Shor / 1024 MIPS).")
    args = parser.parse_args(argv)
    if args.shots is not None and args.shots < 1:
        parser.error("--shots must be positive")
    print(f"{ROUTING_MODEL} / resource_model_version={RESOURCE_MODEL_VERSION}; "
          f"Qiskit {version('qiskit')}, Aer {version('qiskit-aer')}; seed={AER_SEED}")
    print("Basis: " + ", ".join(NATIVE_BASIS_GATES) + "; sequential toy circuits; probabilities in [0,1].")
    print("Noise assumptions: uniform nonidentity Pauli errors + gate-local T1/T2 relaxation, "
          "symmetric readout flips; all 1Q gates use profile t_1q_ns, including rz.")
    print("CX noise repeats native_2q_per_cx times (a proxy, not native-entangler compilation). "
          "Aer has no topology routing, unscheduled idle noise or post-readout reset; "
          "analytic survival includes routing and all-qubit circuit exposure.")
    print("Gate errors plus thermal relaxation can double-count decoherence; "
          "ground-state equilibrium is assumed. Sampled output probabilities are not no-error survival, "
          "factoring success, or required to lie between analytic scenarios.")
    print(f"{'Circuit':<9} {'Profile':<23} {'Metric':<18} {'Shots':>6} {'Observed':>12} "
          f"{'Best':>12} {'Point (T1)':>12} {'Worst':>12}", flush=True)
    for row in validation_rows(args.shots):
        print(f"{row['workload']:<9} {row['profile']:<23} {row['metric']:<18} {row['shots']:>6} "
              f"{row['measured_probability']:>12.5e} {row['analytic_best']:>12.5e} "
              f"{row['analytic_point']:>12.5e} {row['analytic_worst']:>12.5e}", flush=True)


if __name__ == "__main__":
    main()

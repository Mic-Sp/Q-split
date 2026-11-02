"""Independent channel checks and a real CLI run, kept outside the API path."""

import math
from pathlib import Path
import subprocess
import sys

import pytest
from qiskit import QuantumCircuit
from qiskit_aer import AerSimulator

from backend.profiles import HARDWARE_PROFILES
from backend.scripts.validate_survival import build_noise_model, validation_rows


def density_after(circuit, profile):
    circuit.save_density_matrix()
    simulator = AerSimulator(method="density_matrix", noise_model=build_noise_model(profile), max_parallel_threads=1)
    return simulator.run(circuit, shots=1).result().data(0)["density_matrix"]


@pytest.mark.parametrize("profile_id", HARDWARE_PROFILES)
def test_noise_models_use_the_declared_profiles_without_mutating_them(profile_id):
    profile = HARDWARE_PROFILES[profile_id]
    original = profile.model_dump()
    noise = build_noise_model(profile)
    assert profile.model_dump() == original
    if profile_id == "ideal_sim":
        assert noise.is_ideal()
    else:
        assert set(noise.noise_instructions) == {"cx", "rz", "sx", "x", "measure"}
        readout, = [error for error in noise.to_dict()["errors"] if error["type"] == "roerror"]
        assert readout["probabilities"] == [[1 - profile.err_meas, profile.err_meas],
                                             [profile.err_meas, 1 - profile.err_meas]]


@pytest.mark.parametrize("profile_id", ["ibm_heron_nisq", "google_weber_grid", "ionq_forte_trapped_ion"])
def test_thermal_channels_reproduce_t1_population_and_t2_coherence_in_microseconds(profile_id):
    profile = HARDWARE_PROFILES[profile_id].model_copy(update={"err_1q": 0, "err_2q": 0, "err_meas": 0})
    circuit = QuantumCircuit(1)
    circuit.sx(0)  # Excited-state population = 1/2, off-diagonal magnitude = 1/2.
    density = density_after(circuit, profile).data
    duration_us = profile.t_1q_ns / 1000
    assert density[1, 1].real == pytest.approx(math.exp(-duration_us / profile.t1_us) / 2)
    assert abs(density[0, 1]) == pytest.approx(math.exp(-duration_us / profile.t2_us) / 2)


@pytest.mark.parametrize("native_count", [1, 2])
def test_cx_proxy_repeats_native_pauli_channel_without_treating_pauli_probability_as_lambda(native_count):
    error = HARDWARE_PROFILES["google_weber_grid"].err_2q
    profile = HARDWARE_PROFILES["ideal_sim"].model_copy(update={"err_2q": error, "native_2q_per_cx": native_count})
    circuit = QuantumCircuit(2)
    circuit.cx(0, 1)
    density = density_after(circuit, profile).data
    # A uniform nonidentity Pauli channel on two qubits contracts traceless
    # components by (1-16p/15); repeated native channels multiply contractions.
    expected_zero_probability = 1 / 4 + 3 / 4 * (1 - 16 * error / 15) ** native_count
    assert density[0, 0].real == pytest.approx(expected_zero_probability)


def test_unsupported_thermal_or_fractional_native_parameters_are_not_silently_clamped():
    profile = HARDWARE_PROFILES["ibm_heron_nisq"]
    with pytest.raises(ValueError, match="T2 <= 2"):
        build_noise_model(profile.model_copy(update={"t2_us": 3 * profile.t1_us}))
    with pytest.raises(ValueError, match="integer native_2q_per_cx"):
        build_noise_model(profile.model_copy(update={"native_2q_per_cx": 1.5}))


@pytest.mark.parametrize("shots", [True, False, 0, -1, 1.5, math.nan, math.inf])
def test_validation_cli_helper_rejects_invalid_shots(shots):
    with pytest.raises(ValueError, match="shots"):
        list(validation_rows(shots))


def test_cli_runs_real_native_circuits_for_all_nonideal_profiles_without_importing_fastapi():
    root = Path(__file__).resolve().parents[2]
    result = subprocess.run([
        sys.executable, "-c",
        "import runpy, sys; sys.modules['fastapi'] = None; "
        "sys.argv = ['validate_survival.py']; "
        "runpy.run_path('backend/scripts/validate_survival.py', run_name='__main__')",
    ], cwd=root, capture_output=True, text=True, check=True, timeout=60)
    assert "CALIBRATED_V2" in result.stdout
    assert "not no-error survival" in result.stdout
    assert "topology routing" in result.stdout
    lines = [line.split() for line in result.stdout.splitlines() if line.startswith(("N=15 ", "MIPS-64 "))]
    assert len(lines) == 2 * (len(HARDWARE_PROFILES) - 1)
    assert {fields[1] for fields in lines} == set(HARDWARE_PROFILES) - {"ideal_sim"}
    for fields in lines:
        # The four probabilities are the final columns; formatting retains tiny bounds.
        observed, best, point, worst = map(float, fields[-4:])
        assert 0 <= observed <= 1
        assert 0 <= worst <= point == best <= 1
        assert int(fields[-5]) == (512 if fields[0] == "N=15" else 1024)


def test_noise_cli_is_not_imported_by_api_or_pure_estimators():
    root = Path(__file__).resolve().parents[2]
    subprocess.run([
        sys.executable, "-c",
        "import sys; import backend.main; import backend.estimation; "
        "assert 'backend.scripts.validate_survival' not in sys.modules",
    ], cwd=root, capture_output=True, text=True, check=True, timeout=60)

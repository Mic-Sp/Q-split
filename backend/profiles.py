"""Literature-grounded approximations; never substitute for current calibrations."""

if __package__:
    from .models import QPUProfile
else:
    from models import QPUProfile


RETRIEVED_ON = "2026-11-01"
IBM_NOISE = "https://eu-de.quantum.cloud.ibm.com/learning/en/courses/tools-for-quantum-advantage/noise-and-errors"
IBM_PROCESSORS = "https://quantum.cloud.ibm.com/docs/en/guides/processor-types"
WEBER_DATASHEET = "https://quantumai.google/hardware/datasheet/weber.pdf"
FORTE_SPECS = "https://www.ionq.com/quantum-systems/forte"
FORTE_PAPER = "https://arxiv.org/html/2308.05071v2"


def _provenance(source_url, sources, published, notes):
    fields = ["n_qubits_max", "t1_us", "t2_us", "t_1q_ns", "t_2q_ns", "t_meas_ns",
              "t_reset_ns", "err_1q", "err_2q", "err_meas", "topology_factor"]
    return {"source_url": source_url, "sources": sources, "retrieval_date": RETRIEVED_ON,
            "value_types": {field: "vendor_or_literature_approximation" if field in published else "model_assumption"
                            for field in fields}, "notes": notes}


HARDWARE_PROFILES = {
    "ibm_heron_nisq": QPUProfile(
        id="ibm_heron_nisq", name="IBM Heron r1 (representative)", n_qubits_max=133,
        t1_us=200, t2_us=150, t_1q_ns=32, t_2q_ns=68,
        t_meas_ns=1500, t_reset_ns=200_000,
        err_1q=0.0003, err_2q=0.003, err_meas=0.01, topology_factor=1.5,
        provenance=_provenance(IBM_NOISE, [IBM_NOISE, IBM_PROCESSORS],
                               {"n_qubits_max", "t1_us", "t_2q_ns"},
            "133 qubits selects Heron r1. T1=200 us is a family-scale approximation; 68 ns is an "
            "IBM Boston example, not a measured r1 calibration. Remaining timing/error values and "
            "the Heavy-Hex routing multiplier are explicit modeling assumptions.")),
    "google_weber_grid": QPUProfile(
        id="google_weber_grid", name="Google Weber / Sycamore (representative)", n_qubits_max=53,
        t1_us=15, t2_us=20, t_1q_ns=25, t_2q_ns=12,
        t_meas_ns=4000, t_reset_ns=200_000,
        err_1q=0.001, err_2q=0.009, err_meas=0.04, topology_factor=1.2,
        provenance=_provenance(WEBER_DATASHEET, [WEBER_DATASHEET],
                               {"n_qubits_max", "t1_us", "t_1q_ns", "t_2q_ns", "t_meas_ns"},
            "2021 datasheet: 53 active Weber qubits, median T1=15 us, 25 ns 1Q, 12 ns Sycamore "
            "entangler, 4 us readout. Error rates are rounded proxies across differing gate/SPAM "
            "benchmarks; 12 ns Sycamore is not a CX duration. Reset, T2 and square-grid topology "
            "overhead are assumptions; generic CX-based circuits are not device-natively scheduled.")),
    "ionq_forte_trapped_ion": QPUProfile(
        id="ionq_forte_trapped_ion", name="IonQ Forte (representative)", n_qubits_max=36,
        t1_us=100_000_000, t2_us=1_000_000, t_1q_ns=110_000, t_2q_ns=900_000,
        t_meas_ns=250_000, t_reset_ns=1_000_000,
        err_1q=0.0002, err_2q=0.004, err_meas=0.005, topology_factor=1.0,
        provenance=_provenance(FORTE_SPECS, [FORTE_SPECS, FORTE_PAPER],
                               {"n_qubits_max", "t1_us", "t2_us", "t_1q_ns", "t_2q_ns", "err_1q", "err_2q", "err_meas"},
            "T1=100 s uses the upper end of the vendor's 10–100 s range; T2 is about 1 s. "
            "110 us 1Q and 900 us 2Q timings are from the 30-qubit Forte paper, approximated "
            "for this 36-qubit preset. Vendor SPAM error proxies measurement error. Readout/reset "
            "times are assumptions. All-to-all connectivity uses no routing expansion.")),
    "ideal_sim": QPUProfile(
        id="ideal_sim", name="Ideal noise-free reference", n_qubits_max=None,
        t1_us=None, t2_us=None, t_1q_ns=32, t_2q_ns=250, t_meas_ns=1500, t_reset_ns=0,
        err_1q=0, err_2q=0, err_meas=0, topology_factor=1,
        provenance=_provenance(None, [], set(),
            "Theoretical reference: unlimited capacity, no gate/SPAM errors or T1 decay. Finite "
            "gate/readout durations are illustrative, so shot repetition still costs time.")),
}

TOPOLOGIES = {"ibm_heron_nisq": "Heavy-Hex", "google_weber_grid": "2D Square Grid",
              "ionq_forte_trapped_ion": "All-to-All Ion Trap", "ideal_sim": "Noise-free reference"}


def execution_profile(profile: QPUProfile, available_qubits: int) -> QPUProfile:
    """Preserve the cockpit's explicit capacity override as an exploratory device.

    The pure estimator enforces n_qubits_max. Pipeline users may independently
    choose a hypothetical capacity; telemetry keeps the published reference and
    marks overrides. This never mutates the stored vendor characterization.
    """
    return profile.model_copy(update={"n_qubits_max": available_qubits})


def profile_metrics(profile: QPUProfile, available_qubits: int) -> dict:
    """Serialize provenance and units in one shared adapter for both workloads."""
    return {"hardware_architecture": profile.id, "connectivity_topology": TOPOLOGIES[profile.id],
            "resource_model_version": 1,
            **({"reference_qubits": profile.n_qubits_max} if profile.n_qubits_max is not None else {}),
            "capacity_override": profile.n_qubits_max is not None and available_qubits > profile.n_qubits_max,
            "routing_depth_multiplier": profile.topology_factor,
            "qpu_profile": profile.model_dump(mode="json")}

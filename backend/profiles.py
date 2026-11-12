"""Literature-grounded approximations; never substitute for current calibrations."""

if __package__:
    from .models import QPUProfile, RESOURCE_MODEL_VERSION
else:
    from models import QPUProfile, RESOURCE_MODEL_VERSION


RETRIEVED_ON = "2026-11-01"
IBM_NOISE = "https://eu-de.quantum.cloud.ibm.com/learning/en/courses/tools-for-quantum-advantage/noise-and-errors"
IBM_PROCESSORS = "https://quantum.cloud.ibm.com/docs/en/guides/processor-types"
WEBER_DATASHEET = "https://quantumai.google/hardware/datasheet/weber.pdf"
FORTE_SPECS = "https://www.ionq.com/quantum-systems/forte"
FORTE_PAPER = "https://arxiv.org/html/2308.05071v2"
GIDNEY_2025_RSA = "https://arxiv.org/abs/2505.15917"
GOOGLE_WILLOW_QEC = "https://arxiv.org/abs/2408.13687"
IBM_NIGHTHAWK_R2 = "https://www.ibm.com/quantum/blog/nighthawk-r2"
IBM_COMPUTE_CHANGELOG = "https://eu-de.quantum.cloud.ibm.com/docs/en/guides/changelog-quantum-compute-service"
IBM_NIGHTHAWK_R3 = "https://newsroom.ibm.com/2026-11-11-ibm-quantum-nighthawk-demonstrates-new-levels-of-speed-and-quality%2C-with-plans-to-scale-beyond-1%2C000-qubits-in-2027"
IBM_LINK_DEMONSTRATION = "https://arxiv.org/abs/2610.29986"
SYSTEM_TWO_DEPLOYMENT = (
    "IBM Quantum System Two is the modular cryogenic mainframe/chassis; Heron, Nighthawk r2 "
    "and Nighthawk r3 are QPUs housed inside it. A single Nighthawk r2 (120Q) is the live "
    "system today. Per IBM's November 11, 2026 announcement, the roadmap scales to a "
    "single Nighthawk r3 QPU (520 programmable / 2,034 physical qubits, 10,000 target "
    "operations, 10 installed l-couplers) and a dual-processor 2x Nighthawk r3 linked "
    "system (1,040 programmable / 4,068 physical qubits bridged across 10 active "
    "l-couplers across coupled cryogenic modules) in 2027. These are roadmap targets, "
    "not demonstrated r3 system calibrations.")


def _provenance(source_url, sources, published, notes, *, retrieval_date=RETRIEVED_ON, statistics=None):
    fields = ["n_qubits_max", "t1_us", "t2_us", "t_1q_ns", "t_2q_ns", "t_meas_ns",
              "t_reset_ns", "err_1q", "err_2q", "err_meas", "topology_factor", "native_2q_per_cx"]
    return {"source_url": source_url, "sources": sources, "retrieval_date": retrieval_date,
            "value_types": {field: "vendor_or_literature_approximation" if field in published else "model_assumption"
                            for field in fields},
            "statistics": statistics or {},
            "notes": notes + " The native_2q_per_cx conversion is a model assumption and should "
                             "be verified against a gate-decomposition reference."}


def _nighthawk_provenance():
    provenance = _provenance(IBM_NIGHTHAWK_R2, [IBM_NIGHTHAWK_R2, IBM_COMPUTE_CHANGELOG],
        {"n_qubits_max", "t1_us", "t_reset_ns"},
        "Nighthawk r2: fixed-frequency superconducting transmons, high-dynamic-range tunable "
        "couplers and independent active dissipative reset. IBM reports 120 programmable "
        "qubits, 218 couplers and 120 reset elements (458 physical elements), four-neighbor "
        "square-grid connectivity, 100,000+ circuits/s and 1 us repetition delay. The 25x "
        "throughput comparison with Heron's ~4 kHz is benchmark context, not a universal "
        "runtime multiplier. Use undisturbed T1=200 us for coherent exposure; reset-only "
        "effective T1~25 ns is not computational coherence. T2=160 us, 40 ns native 2Q, "
        "1Q error 0.00025, EPLG 0.0037 and readout/initialization proxy 0.0075 are supplied "
        "task specifications, not independently verified live calibrations. EPLG proxies "
        "per-native-gate error and combined readout/initialization proxies err_meas once; "
        "no separate initialization-error factor exists. 32 ns 1Q and 1500 ns measurement "
        "reuse Heron's model baselines. Routing factor 1.2 reuses the square-grid assumption. "
        "The 7,500+ gate demonstration is not a maximum circuit depth or fidelity guarantee. "
        "No mid-circuit reset, HPC dispatch or measured hybrid-node latency is simulated.",
        retrieval_date="2026-11-07")
    for field in ("t2_us", "t_2q_ns", "err_1q", "err_2q", "err_meas"):
        provenance["value_types"][field] = "user_supplied_specification"
    provenance["value_types"]["repetition_rate_hz"] = "vendor_or_literature_approximation"
    provenance["statistics"] = {
        "repetition_rate_hz": {"value": 100_000, "unit": "Hz", "statistic_type": "conservative peak circuit throughput model",
            "source_url": IBM_COMPUTE_CHANGELOG, "usage": "10 us minimum complete-shot period; longer circuits take longer"},
        "t_reset_ns": {"value": 1000, "unit": "ns", "statistic_type": "default inter-circuit repetition/reset delay", "source_url": IBM_COMPUTE_CHANGELOG},
        "err_2q": {"value": 0.0037, "statistic_type": "user-supplied EPLG used as a native-gate error proxy"},
        "validated_gate_count": {"at_least": 7500, "statistic_type": "demonstrated total gate count, not depth cutoff", "source_url": IBM_NIGHTHAWK_R2},
    }
    provenance["architecture"] = {"modality": "Superconducting Transmon (fixed-frequency)",
        "connectivity_degree": 4, "programmable_qubits": 120, "tunable_couplers": 218,
        "dissipative_reset_gadgets": 120, "total_physical_elements": 458,
        "reset_only_effective_t1_ns": 25,
        "deployment_notes": SYSTEM_TWO_DEPLOYMENT + " User-supplied deployment context: Hyde Park Labs (Chicago / NQAC); HPC hybrid pairing examples ORNL Umbra / NCSA DeltaAI. Not execution targets in this model."}
    return provenance


def _r3_profile(*, dual: bool) -> QPUProfile:
    """Roadmap capacity with explicitly inherited r2 physics, not new calibration."""
    inherited = {"t1_us": 200.0, "t2_us": 160.0, "t_1q_ns": 32.0, "t_2q_ns": 40.0,
                 "t_meas_ns": 1500.0, "t_reset_ns": 1000.0, "err_1q": 0.00025,
                 "err_2q": 0.0037, "err_meas": 0.0075, "topology_factor": 1.2,
                 "native_2q_per_cx": 1.0, "repetition_rate_hz": 100_000.0}
    provenance = _provenance(IBM_NIGHTHAWK_R3,
        [IBM_NIGHTHAWK_R3, IBM_NIGHTHAWK_R2, IBM_LINK_DEMONSTRATION], {"n_qubits_max"},
        "November 11, 2026 r3 design / 2027 linked-system roadmap. All local timing, "
        "T1/T2, error, routing, native-entangler and 100 kHz repetition parameters are "
        "carried over from the r2 baseline as modeling assumptions. 10,000 operations "
        "is an advisory design target, not a depth cutoff, hard feasibility cap or "
        "fidelity guarantee. The 0.993 default extrapolates the r1 four-l-coupler "
        "demonstration's peak (~0.9929; mean ~0.990) to ten r3 bridge channels; "
        "0.999 is an optional 2027 target scenario, not achieved r3 fidelity. "
        "100 ns per scheduled transfer round is a configurable architectural assumption. "
        "V1 traffic packs one module first (or balances explicit dual placement), "
        "assumes uniformly mixed CX operand pairs, two state transfers per remote CX, "
        "and ideal pooled channel scheduling ceil(transfers/10), ignoring gate dependencies. "
        "Transfers add coherent stalls and an independent fidelity proxy; this is not "
        "a compiled interaction graph or a calibrated quantum channel model.",
        retrieval_date="2026-11-12")
    provenance["value_types"].update({key: "model_assumption_inherited_from_r2" for key in inherited})
    provenance["value_types"].update({"n_physical_qubits": "vendor_roadmap_target" if not dual else "derived_2x_vendor_roadmap_target",
        "max_operations": "vendor_roadmap_target", "module_count": "vendor_roadmap_target",
        "qubits_per_module": "vendor_roadmap_target", "l_couplers_installed": "vendor_roadmap_target",
        "l_couplers_active": "architectural_scenario", "state_transfer_fidelity": "extrapolated_r1_peak",
        "state_transfer_target_fidelity": "roadmap_target", "transfer_duration_ns": "architectural_assumption"})
    provenance["statistics"] = {
        "inherited_r2_parameters": inherited,
        "max_operations": {"value": 10000, "statistic_type": "design target; advisory, not depth limit", "source_url": IBM_NIGHTHAWK_R3},
        "state_transfer_fidelity": {"peak": 0.993, "average": 0.990, "demonstrated_channels": 4,
            "demonstrated_processor": "Nighthawk r1", "statistic_type": "r1 peak extrapolated to r3", "source_url": IBM_LINK_DEMONSTRATION},
        "state_transfer_target_fidelity": {"value": 0.999, "statistic_type": "optional 2027 target scenario"},
        "transfer_duration_ns": {"value": 100.0, "unit": "ns/round", "statistic_type": "configurable architectural assumption"}}
    provenance["architecture"] = {"modality": "Superconducting Transmon (fixed-frequency)",
        "connectivity_degree": 4, "programmable_qubits": 1040 if dual else 520,
        "total_physical_qubits": 4068 if dual else 2034, "module_count": 2 if dual else 1,
        "qubits_per_module": 520, "l_couplers_installed": 10, "l_couplers_active": 10 if dual else 0,
        "deployment_notes": SYSTEM_TWO_DEPLOYMENT}
    return QPUProfile(id="ibm_nighthawk_r3_dual" if dual else "ibm_nighthawk_r3",
        name="IBM Quantum System Two (2x Nighthawk r3 Linked — 1,040Q)" if dual else "IBM Quantum System Two (Nighthawk r3 — 520Q)",
        n_qubits_max=1040 if dual else 520, n_physical_qubits=4068 if dual else 2034,
        max_operations=10000, module_count=2 if dual else 1, qubits_per_module=520,
        l_couplers_installed=10, l_couplers_active=10 if dual else 0,
        state_transfer_fidelity=0.993 if dual else None,
        state_transfer_target_fidelity=0.999 if dual else None, transfer_duration_ns=100.0 if dual else None,
        **inherited, provenance=provenance)


HARDWARE_PROFILES = {
    "ibm_heron_nisq": QPUProfile(
        id="ibm_heron_nisq", name="IBM Heron (133-qubit cap, r3-era timing; representative)", n_qubits_max=133,
        t1_us=200, t2_us=150, t_1q_ns=32, t_2q_ns=68,
        t_meas_ns=1500, t_reset_ns=200_000,
        err_1q=0.0003, err_2q=0.003, err_meas=0.01, topology_factor=1.5, native_2q_per_cx=1.0,
        provenance=_provenance(IBM_NOISE, [IBM_NOISE, IBM_PROCESSORS],
                               {"n_qubits_max", "t1_us", "t_2q_ns"},
            "133 qubits is a capacity cap paired with representative r3-era timing. T1=200 us is "
            "a family-scale approximation; 68 ns is an IBM Boston example, not a measured "
            "calibration of a 133-qubit device. Remaining timing/error values and "
            "the Heavy-Hex routing multiplier are explicit modeling assumptions.")),
    "ibm_nighthawk_r2": QPUProfile(
        id="ibm_nighthawk_r2", name="IBM Quantum System Two (Nighthawk r2)", n_qubits_max=120,
        t1_us=200.0, t2_us=160.0, t_1q_ns=32.0, t_2q_ns=40.0,
        t_meas_ns=1500.0, t_reset_ns=1000.0,
        err_1q=0.00025, err_2q=0.0037, err_meas=0.0075,
        topology_factor=1.2, native_2q_per_cx=1.0, repetition_rate_hz=100_000.0,
        provenance=_nighthawk_provenance()),
    "ibm_nighthawk_r3": _r3_profile(dual=False),
    "ibm_nighthawk_r3_dual": _r3_profile(dual=True),
    "google_weber_grid": QPUProfile(
        id="google_weber_grid", name="Google Weber / Sycamore (representative)", n_qubits_max=53,
        t1_us=15, t2_us=20, t_1q_ns=25, t_2q_ns=32,
        t_meas_ns=4000, t_reset_ns=200_000,
        err_1q=0.001, err_2q=0.009, err_meas=0.04, topology_factor=1.2, native_2q_per_cx=2.0,
        provenance=_provenance(WEBER_DATASHEET, [WEBER_DATASHEET],
                               {"n_qubits_max", "t1_us", "t_1q_ns", "t_2q_ns", "t_meas_ns", "err_1q", "err_2q"},
            "14 May 2021 datasheet: 53 Weber qubits, typical (median) T1=15 us, 25 ns 1Q, "
            "32 ns sqrt(iSWAP), 4 us readout. The 0.9% typical isolated XEB error is for that same "
            "sqrt(iSWAP) gate; typical parallel error is 1.4% (context, not used). Assume two "
            "native sqrt(iSWAP) gates per CX for both depth and 2Q count. Reset remains an "
            "assumption; the typical 1–5 kHz repetition rate is supporting context, not a "
            "standalone reset measurement. T2, measurement-error proxy and square-grid routing "
            "are assumptions; CX-based circuits are not device-natively scheduled.",
            retrieval_date="2026-11-02", statistics={
                "t_2q_ns": {"gate": "sqrt(iSWAP)", "statistic_type": "specified native gate duration",
                            "source_url": WEBER_DATASHEET},
                "err_2q": {"gate": "sqrt(iSWAP)", "statistic_type": "typical (median) isolated XEB error per gate, Jan–Mar 2021",
                           "source_url": WEBER_DATASHEET},
                "repetition_rate_hz": {"range": [1000, 5000], "statistic_type": "typical repetition-rate range",
                                       "source_url": WEBER_DATASHEET, "usage": "supporting context only; reset unchanged"},
            })),
    "ionq_forte_trapped_ion": QPUProfile(
        id="ionq_forte_trapped_ion", name="IonQ Forte (representative)", n_qubits_max=36,
        t1_us=100_000_000, t2_us=1_000_000, t_1q_ns=110_000, t_2q_ns=900_000,
        t_meas_ns=250_000, t_reset_ns=1_000_000,
        err_1q=0.0002, err_2q=0.004, err_meas=0.005, topology_factor=1.0, native_2q_per_cx=1.0,
        provenance=_provenance(FORTE_SPECS, [FORTE_SPECS, FORTE_PAPER],
                               {"n_qubits_max", "t1_us", "t2_us", "t_1q_ns", "t_2q_ns", "err_1q", "err_2q", "err_meas"},
            "T1=100 s uses the upper end of the vendor's 10–100 s range; T2 is about 1 s. "
            "110 us 1Q and 900 us 2Q timings are from the 30-qubit Forte paper, approximated "
            "for this 36-qubit preset. Vendor SPAM error proxies measurement error. Readout/reset "
            "times are assumptions. All-to-all connectivity uses no routing expansion.")),
    "ftqc_surface_code": QPUProfile(
        id="ftqc_surface_code",
        name="FTQC Surface-Code Logical QPU (1 µs cycle, d≈27 target; representative)",
        n_qubits_max=1024,
        t1_us=None, t2_us=None,
        t_1q_ns=1_000.0, t_2q_ns=27_000.0,
        t_meas_ns=27_000.0, t_reset_ns=1_000.0,
        err_1q=1e-10, err_2q=1e-9, err_meas=1e-9,
        topology_factor=1.0, native_2q_per_cx=1.0,
        provenance=_provenance(GIDNEY_2025_RSA, [GIDNEY_2025_RSA, GOOGLE_WILLOW_QEC],
            {"t_1q_ns"},
            "Representative logical QPU, not a demonstrated device. Gidney 2025 assumes a 1 us "
            "surface-code cycle and 0.1% physical gate error. Willow reports 1.1 us cycles and "
            "Lambda=2.14 +/- 0.02 suppression per distance increase of two, not per unit distance. "
            "The d=27 target, 1024 logical workspace qubits and roughly 1,000 physical superconducting "
            "qubits per logical qubit are coarse model assumptions; actual patch, routing, factory "
            "and decoder resources are not counted. Logical 2Q lattice surgery and measurement "
            "cost d * 1 us = 27 us, orders of magnitude slower than the representative Heron 68 ns "
            "physical entangler. Initialization assumes one code cycle. T1/T2=None is a model "
            "assumption: under active surface-code syndrome extraction, idle logical memory error "
            "per cycle is folded into the logical operation error rates (err_1q=1e-10, err_2q=1e-9). "
            "Separate unmitigated physical T1/T2 relaxation is disabled to avoid double-counting "
            "against approximately 243 qubit-seconds of lattice-surgery exposure at M=1M in the "
            "Multi-Oracle tier. This does not assert infinite physical coherence; residual memory "
            "errors are assumed covered by the per-operation targets, without a separate idle schedule. "
            "Logical operation error targets assume sub-threshold 0.1% physical errors "
            "and Lambda approximately 2 suppression per distance step of two. The 1e-10/1e-9 targets "
            "are optimistic model assumptions, not measured Willow errors or a quantitative d=27 "
            "extrapolation from its distance-7 memory. Logical routing is absorbed into bus timing; "
            "magic-state factories, decoding and feed-forward stalls are not separately scheduled.",
            retrieval_date="2026-11-02", statistics={
                "n_qubits_max": {"statistic_type": "model_assumption: logical workspace capacity",
                    "source_url": GIDNEY_2025_RSA,
                    "note": "1024 logical qubits; ~1,000 physical qubits per logical qubit at d≈27 is a coarse footprint assumption, excluding supporting resources."},
                "t1_us": {"statistic_type": "model_assumption: active-QEC memory errors included in logical operation errors",
                    "source_url": GOOGLE_WILLOW_QEC, "note": "None disables a separate T1 penalty to avoid double-counting; not a measured or infinite physical lifetime."},
                "t2_us": {"statistic_type": "model_assumption: active-QEC memory errors included in logical operation errors",
                    "source_url": GOOGLE_WILLOW_QEC, "note": "None disables a separate T2 penalty to avoid double-counting; not a measured or infinite physical lifetime."},
                "t_1q_ns": {"statistic_type": "literature resource-estimation assumption: syndrome cycle duration",
                    "source_url": GIDNEY_2025_RSA,
                    "note": "1 us in Gidney 2025; Willow benchmarks report 1.1 us. One cycle proxies logical 1Q timing."},
                "t_2q_ns": {"statistic_type": "model_assumption: derived lattice-surgery latency",
                    "source_url": GIDNEY_2025_RSA, "note": "d * cycle = 27 * 1 us; logical suppression trades against slower gates."},
                "t_meas_ns": {"statistic_type": "model_assumption: logical measurement latency",
                    "source_url": GIDNEY_2025_RSA, "note": "d=27 rounds of 1 us syndrome extraction."},
                "t_reset_ns": {"statistic_type": "model_assumption: logical initialization latency",
                    "source_url": GIDNEY_2025_RSA, "note": "One 1 us code cycle; simplified initialization proxy."},
                "err_1q": {"statistic_type": "model_assumption: logical 1Q error probability per operation",
                    "source_url": GOOGLE_WILLOW_QEC, "note": "1e-10 target at d≈27; not an experimental result or direct Lambda extrapolation."},
                "err_2q": {"statistic_type": "model_assumption: logical lattice-surgery error probability per operation",
                    "source_url": GOOGLE_WILLOW_QEC, "note": "1e-9 target; 0.1% physical error and Lambda≈2 per distance increase of two are context, not a derivation."},
                "err_meas": {"statistic_type": "model_assumption: logical measurement error probability per operation",
                    "source_url": GOOGLE_WILLOW_QEC, "note": "1e-9 target after d rounds; not measured Willow readout fidelity."},
                "topology_factor": {"statistic_type": "model_assumption: logical routing multiplier",
                    "source_url": GIDNEY_2025_RSA, "note": "1.0; logical routing absorbed into lattice-surgery bus timing."},
                "native_2q_per_cx": {"statistic_type": "model_assumption: logical entanglers per CX",
                    "source_url": GIDNEY_2025_RSA, "note": "1.0 logical lattice-surgery operation per modeled CX."},
            })),
    "ideal_sim": QPUProfile(
        id="ideal_sim", name="Ideal noise-free reference", n_qubits_max=None,
        t1_us=None, t2_us=None, t_1q_ns=32, t_2q_ns=250, t_meas_ns=1500, t_reset_ns=0,
        err_1q=0, err_2q=0, err_meas=0, topology_factor=1, native_2q_per_cx=1.0,
        provenance=_provenance(None, [], set(),
            "Theoretical reference: unlimited capacity, no gate/SPAM errors or T1 decay. Finite "
            "gate/readout durations are illustrative, so shot repetition still costs time.")),
}

TOPOLOGIES = {"ibm_heron_nisq": "Heavy-Hex", "ibm_nighthawk_r2": "4-degree Square Grid", "google_weber_grid": "2D Square Grid",
              "ibm_nighthawk_r3": "4-degree Square Grid", "ibm_nighthawk_r3_dual": "Linked Square Grids (10 l-couplers)",
              "ftqc_surface_code": "2D Surface-Code Lattice Surgery",
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
            "resource_model_version": RESOURCE_MODEL_VERSION,
            **({"reference_qubits": profile.n_qubits_max} if profile.n_qubits_max is not None else {}),
            "capacity_override": profile.n_qubits_max is not None and available_qubits > profile.n_qubits_max,
            "routing_depth_multiplier": profile.topology_factor,
            "qpu_profile": profile.model_dump(mode="json")}

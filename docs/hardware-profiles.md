# Hardware profiles

## Purpose and disclaimer

Q-Split's profiles are representative, literature-grounded approximations, not live device calibrations. Results from resource model version 2 (`CALIBRATED_V2`) are simulation estimates, not hardware benchmarks. This document follows [the stored profiles and provenance](../backend/profiles.py), [the field definitions](../backend/models.py), and [the production estimator](../backend/estimation.py).

Terms used below:

- **T1:** a characteristic time for a qubit's excited state to relax toward equilibrium.
- **T2:** a characteristic time for loss of phase coherence.
- **1Q gate:** an operation on one qubit.
- **2Q gate:** an operation involving two qubits; a native entangler is the hardware-level gate used to couple them.
- **Coherence:** preservation of the quantum state relationships needed for a calculation; Q-Split reports modeled no-error survival, not algorithm success probability.
- **CX:** a controlled-NOT operation, the two-qubit basis used by the circuit resource estimates.

## Summary table

Display names below are the backend `QPUProfile.name` strings; selector labels may be shorter. Capacity is `n_qubits_max`; FTQC counts logical workspace qubits. T1/T2 are in microseconds (µs), all gate/readout/reset times are in nanoseconds (ns), and errors are probabilities per operation, not percentages. The error column lists `err_1q / err_2q / err_meas` in that order; measurement and reset correspond to `t_meas_ns` and `t_reset_ns`.

| Profile ID | Display name | Capacity | T1 (µs) | T2 (µs) | 1Q (ns) | 2Q (ns) | Meas. (ns) | Reset (ns) | Errors: 1Q / 2Q / meas. | `topology_factor` | `native_2q_per_cx` |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: |
| `ibm_heron_nisq` | IBM Heron (133-qubit cap, r3-era timing; representative) | 133 | 200 | 150 | 32 | 68 | 1,500 | 200,000 | 0.0003 / 0.003 / 0.01 | 1.5 | 1 |
| `google_weber_grid` | Google Weber / Sycamore (representative) | 53 | 15 | 20 | 25 | 32 | 4,000 | 200,000 | 0.001 / 0.009 / 0.04 | 1.2 | 2 |
| `ionq_forte_trapped_ion` | IonQ Forte (representative) | 36 | 100,000,000 | 1,000,000 | 110,000 | 900,000 | 250,000 | 1,000,000 | 0.0002 / 0.004 / 0.005 | 1 | 1 |
| `ftqc_surface_code` | FTQC Surface-Code Logical QPU (1 µs cycle, d≈27 target; representative) | 1,024 logical | `None` (disabled) | `None` (disabled) | 1,000 | 27,000 | 27,000 | 1,000 | 1e-10 / 1e-09 / 1e-09 | 1 | 1 |
| `ideal_sim` | Ideal noise-free reference | `None` (unbounded) | `None` (disabled) | `None` (disabled) | 32 | 250 | 1,500 | 0 | 0 / 0 / 0 | 1 | 1 |

`None` for capacity means the stored profile is unbounded. `None` for T1/T2 disables separate memory decay: FTQC assumes memory errors are folded into logical operation errors, while the ideal reference has no noise. Neither meaning removes the cockpit's explicitly selected available-qubit limit; see [capacity overrides](#capacity-overrides).

## Profiles and provenance

Provenance distinguishes `vendor_or_literature_approximation` from `model_assumption` for every table parameter. All five profiles classify `native_2q_per_cx` as a model assumption; the shared provenance note says this conversion should be verified against a gate-decomposition reference. A linked source supplies context for an assumption, not evidence that the assumed value was measured.

### IBM Heron

This is a representative Heavy-Hex superconducting profile combining a **133-qubit capacity cap with r3-era timing**, not a measured calibration of one 133-qubit device. Routing expands resources by the assumed Heavy-Hex multiplier of 1.5.

- **Vendor/literature approximations:** `n_qubits_max`, `t1_us`, and `t_2q_ns`.
- **Model assumptions:** `t2_us`, `t_1q_ns`, `t_meas_ns`, `t_reset_ns`, `err_1q`, `err_2q`, `err_meas`, `topology_factor`, and `native_2q_per_cx`.
- **Statistic caveats:** T1 = 200 µs is a family-scale approximation; the 68 ns 2Q duration is an IBM Boston example. Neither establishes the calibration of the capacity-capped device. The profile's `statistics` dictionary is empty; the code gives no further per-field statistic types.
- **Sources — retrieval date 2026-11-01:** [IBM noise and errors](https://eu-de.quantum.cloud.ibm.com/learning/en/courses/tools-for-quantum-advantage/noise-and-errors) (primary `source_url`), [IBM processor types](https://quantum.cloud.ibm.com/docs/en/guides/processor-types).

### Google Weber

This is a representative **53-qubit Weber / Sycamore 2D square-grid** profile. It uses native √iSWAP gate timing and error from the 14 May 2021 datasheet; CX-based circuits are not device-natively scheduled.

- **Vendor/literature approximations:** `n_qubits_max`, `t1_us`, `t_1q_ns`, `t_2q_ns`, `t_meas_ns`, `err_1q`, and `err_2q`.
- **Model assumptions:** `t2_us`, `t_reset_ns`, `err_meas`, `topology_factor`, and `native_2q_per_cx`.
- **Source — retrieval date 2026-11-02:** [Weber datasheet](https://quantumai.google/hardware/datasheet/weber.pdf) (primary and only source).

The notes identify typical (median) T1 = 15 µs, 25 ns 1Q gates, 32 ns √iSWAP gates, and 4 µs readout. The recorded `statistics` entries distinguish:

| Field | Recorded statistic and use |
| --- | --- |
| `t_2q_ns` | Specified native √iSWAP gate duration: 32 ns. |
| `err_2q` | Typical (median) isolated XEB error per √iSWAP gate, Jan–Mar 2021: 0.9%. XEB is the datasheet's cross-entropy benchmarking error statistic. |
| `repetition_rate_hz` | Typical range 1,000–5,000 Hz (1–5 kHz), supporting context only; reset unchanged. |

The typical parallel error of 1.4% is context only and is not used. The 0.9% error and 32 ns timing describe the same native gate. **Two native √iSWAP gates per CX are assumed**, applied to both depth and 2Q count; this needs verification against a gate-decomposition reference. T2, the measurement-error proxy, reset, and square-grid routing are assumptions. The repetition-rate range is not a standalone reset measurement.

### IonQ Forte

This represents a **36-qubit all-to-all trapped-ion** preset, combining vendor specifications with timings from a **30-qubit Forte paper**. It is not a single measured 36-qubit calibration; all-to-all connectivity uses no routing expansion (`topology_factor = 1.0`).

- **Vendor/literature approximations:** `n_qubits_max`, `t1_us`, `t2_us`, `t_1q_ns`, `t_2q_ns`, `err_1q`, `err_2q`, and `err_meas`.
- **Model assumptions:** `t_meas_ns`, `t_reset_ns`, `topology_factor`, and `native_2q_per_cx`.
- **Statistic caveats:** T1 = 100 s takes the upper end of the vendor's 10–100 s range; T2 is about 1 s. The 110 µs 1Q and 900 µs 2Q durations come from the 30-qubit paper and are approximated for this preset. Vendor state-preparation-and-measurement (SPAM) error proxies measurement error; it is not an isolated readout-error measurement. The profile's `statistics` dictionary is empty.
- **Sources — retrieval date 2026-11-01:** [Forte system specifications](https://www.ionq.com/quantum-systems/forte) (primary `source_url`), [30-qubit Forte paper](https://arxiv.org/html/2308.05071v2).

### FTQC Surface-Code

This is a **representative fault-tolerant logical QPU**, not a demonstrated device. Its 1,024 qubits are logical workspace: encoded qubits rather than a count of physical superconducting devices. Code distance d≈27 is the assumed error-correcting-code target; the coarse footprint is roughly 1,000 physical superconducting qubits per logical qubit, excluding supporting resources.

**Sources — retrieval date 2026-11-02:** [Gidney 2025 RSA resource estimate](https://arxiv.org/abs/2505.15917) (primary `source_url`), [Google Willow QEC](https://arxiv.org/abs/2408.13687).

The provenance records Gidney's assumed **1 µs surface-code cycle and 0.1% physical gate error**. Willow reports **1.1 µs cycles** and error suppression Λ = **2.14 ± 0.02 per distance increase of two**, not per unit distance. These are distinct contexts; the preset does not claim that Willow measured a 1 µs logical gate or demonstrated d=27 performance. Syndrome extraction means repeated error-detection measurements; a cycle is used as the logical 1Q timing proxy.

Only `t_1q_ns` is classified as `vendor_or_literature_approximation`; every other table parameter is a `model_assumption`. The per-field `statistics` record the following types and qualifications:

| Field | Recorded statistic type and qualification |
| --- | --- |
| `n_qubits_max` | Model assumption: logical workspace capacity; 1,024 logical qubits with the coarse d≈27 footprint above. Source context: Gidney. |
| `t1_us` | Model assumption: active-QEC memory errors included in logical operation errors; `None` disables a separate T1 penalty. Source context: Willow. |
| `t2_us` | Model assumption: active-QEC memory errors included in logical operation errors; `None` disables a separate T2 penalty. Source context: Willow. |
| `t_1q_ns` | Literature resource-estimation assumption: syndrome cycle duration; 1 µs in Gidney, compared with Willow's 1.1 µs. |
| `t_2q_ns` | Model assumption: derived lattice-surgery latency, d × cycle = 27 × 1 µs. Source context: Gidney. |
| `t_meas_ns` | Model assumption: logical measurement latency over d=27 rounds of 1 µs syndrome extraction. Source context: Gidney. |
| `t_reset_ns` | Model assumption: logical initialization latency of one 1 µs code cycle, a simplified proxy. Source context: Gidney. |
| `err_1q` | Model assumption: logical 1Q error probability per operation, 1e-10 target at d≈27; not measured or a direct Λ extrapolation. Source context: Willow. |
| `err_2q` | Model assumption: logical lattice-surgery error probability per operation, 1e-9 target; 0.1% physical error and Λ≈2 per distance increase of two are context, not a derivation. Source context: Willow. |
| `err_meas` | Model assumption: logical measurement error probability per operation, 1e-9 target after d rounds; not measured Willow readout fidelity. Source context: Willow. |
| `topology_factor` | Model assumption: logical routing multiplier, 1.0; routing is absorbed into lattice-surgery bus timing. Source context: Gidney. |
| `native_2q_per_cx` | Model assumption: logical entanglers per CX, 1.0 logical lattice-surgery operation per modeled CX. Source context: Gidney. |

Lattice surgery is the modeled logical 2Q operation: **27 µs for d × 1 µs**, also used for logical measurement. This is orders of magnitude slower than Heron's representative 68 ns physical entangler. Logical error suppression trades against this clock-speed cost; the 1e-10/1e-9 targets are optimistic assumptions, not measured Willow errors or a quantitative extrapolation from its distance-7 memory.

**Why T1/T2 are `None`:** under active syndrome extraction, idle logical memory errors per cycle are assumed folded into the logical operation errors. The estimator therefore disables a separate unmitigated T1/T2 relaxation penalty to avoid double-counting against approximately 243 qubit-seconds of exposure at M=1M in the Multi-Oracle tier. This is neither a measured lifetime nor infinite physical coherence; residual memory errors are assumed covered by per-operation targets without a separate idle schedule.

Actual patch, routing, factory, and decoder resources are not counted. Logical routing overhead is absorbed into bus timing; magic-state factories, decoding, and feed-forward stalls are not separately scheduled. Logical survival and wall-clock latency must therefore be interpreted as representative projections, not performance of a built fault-tolerant processor.

### Ideal Noise-Free

This is a theoretical reference with **unlimited stored profile capacity**, no gate/SPAM errors, and no T1/T2 decay. Explicit UI capacity and supported routing still constrain a run; this profile does not represent error-corrected hardware.

- **Vendor/literature approximations:** none.
- **Model assumptions:** all twelve parameters in `value_types`, including zero errors, `None` capacity/T1/T2, illustrative gate/readout times, zero reset time, and the routing/native-conversion factors.
- **Sources:** `source_url = None`, `sources = []`; no external source is claimed. The provenance records date **2026-11-01** and an empty `statistics` dictionary.

Finite illustrative gate and readout durations mean repeated shots still cost time. For feasible execution, survival is 100%; noise-free does not mean instantaneous.

## How profile values are used

[The estimator](../backend/estimation.py) takes a hardware-independent `CircuitSpec`, a `QPUProfile`, a shot count, and a launch overhead. A shot is one execution of the circuit. It applies the profile as follows:

1. **Routing and native conversion:** multiply CX-basis depth and 2Q count by `topology_factor × native_2q_per_cx`, then round each result up once. Do not expand an already expanded resource again. The stored 2Q time and error describe the same native gate; 1Q and measurement counts are not multiplied by these factors.
2. **Circuit duration:** bill every resulting depth layer at `t_2q_ns`, including layers containing only 1Q gates. `t_1q_ns` is stored for future scheduling models and does not currently set production circuit time.
3. **Batch latency:** charge launch once, then repeat circuit, measurement, and reset time for every shot. Measurement/reset are included in latency but excluded from coherent circuit exposure; launch is also excluded from exposure.

   ```text
   latency_ms = launch_overhead_ms
              + shots × (native_depth × t_2q_ns + t_meas_ns + t_reset_ns) / 1e6
   ```

4. **Per-shot survival:** combine independent 1Q, expanded 2Q, and measurement error probabilities with memory decay. For finite T1, the point estimate charges **all circuit qubits for the full circuit duration**, using `exp(-n_qubits × circuit_us / t1_us)`; it does not identify scheduled idle periods. `None` disables that decay term. Shots repeat latency, not the per-shot survival exponent.
5. **Sensitivity:** T1 gives both the point and best estimate. Worst uses T2 instead of T1 when available (otherwise T1) and takes the lower of that result and the point, so a T2 greater than T1 cannot improve the worst case. The idle terms are alternatives, not additive; the range is model sensitivity, not a confidence interval.
6. **Status:** the [backend classifier](../backend/main.py) calls survival ≥70% `NOMINAL`, ≥35% but <70% `DEGRADED`, and <35% `EXCEEDED`, using the unrounded percentage. Infeasible QPU execution reports zero survival.

The [layer-aware timing design](../backend/LAYER_TIMING_DESIGN.md) describes a separate reference diagnostic and a proposed versioned scheduling interface. It does not replace the current `CALIBRATED_V2` production formula or justify inferring a layer mix from gate totals.

## Capacity overrides

The UI allows available qubits to exceed a profile's reference capacity. These overrides are exploratory hypothetical devices, not a claim that the referenced hardware has grown.

The pure estimator enforces the capacity of the profile it receives. [`execution_profile`](../backend/profiles.py) returns a copy with `n_qubits_max` replaced by the user's selected available qubits; it never mutates the stored profile. Telemetry preserves the reference `qpu_profile` and `reference_qubits` where defined, reports the selected capacity, and marks `capacity_override` when it exceeds a finite reference. The ideal profile has no finite reference, but the execution copy still receives the selected UI capacity.

## Known limitations

- Profiles are representative approximations rather than current calibrations; source-based values may combine different device sizes or generations, as detailed above.
- Routing and native-entangler conversions are approximate multipliers, not a device-native compilation or schedule. Every profile's native conversion needs verification against a gate-decomposition reference.
- Every depth layer is charged at the 2Q duration; stored 1Q durations do not yet affect production timing.
- Every qubit is charged for the full circuit duration rather than scheduled idle time. Combining decay with calibrated gate errors can double-count gate-time decoherence; the estimator does not subtract that overlap without evidence.
- Best/worst survival values are sensitivity scenarios, not statistical confidence bounds, observed output probabilities, or algorithm success probabilities.
- FTQC logical errors, code distance, physical footprint, and memory-error treatment are model assumptions. Supporting resources and separate factory, decoder, routing, and feed-forward schedules are excluded or absorbed into timing as specified above.
- Dependency-layer diagnostics are not calibrated pulse schedules. Extra decomposition 1Q gates, routing, overlap with measurement, and hardware scheduling constraints are unresolved in that diagnostic; aggregate gate counts and depth cannot determine a schedule.
- The planned layer-aware interface still needs explicit semantics for delays, reset instructions, mid-circuit measurement, and feed-forward. Toy reference layer ratios must not silently extrapolate to larger scales or parallel tiers.

Return to the [README hardware overview](../README.md#hardware-profiles).

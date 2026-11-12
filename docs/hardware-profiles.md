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
| `ibm_nighthawk_r2` | IBM Quantum System Two (Nighthawk r2) | 120 | 200 | 160 | 32 | 40 | 1,500 | 1,000 | 0.00025 / 0.0037 / 0.0075 | 1.2 | 1 |
| `ibm_nighthawk_r3` | IBM Quantum System Two (Nighthawk r3 — 520Q) | 520 | 200 | 160 | 32 | 40 | 1,500 | 1,000 | 0.00025 / 0.0037 / 0.0075 | 1.2 | 1 |
| `ibm_nighthawk_r3_dual` | IBM Quantum System Two (2x Nighthawk r3 Linked — 1,040Q) | 1,040 | 200 | 160 | 32 | 40 | 1,500 | 1,000 | 0.00025 / 0.0037 / 0.0075 | 1.2 | 1 |
| `google_weber_grid` | Google Weber / Sycamore (representative) | 53 | 15 | 20 | 25 | 32 | 4,000 | 200,000 | 0.001 / 0.009 / 0.04 | 1.2 | 2 |
| `ionq_forte_trapped_ion` | IonQ Forte (representative) | 36 | 100,000,000 | 1,000,000 | 110,000 | 900,000 | 250,000 | 1,000,000 | 0.0002 / 0.004 / 0.005 | 1 | 1 |
| `ftqc_surface_code` | FTQC Surface-Code Logical QPU (1 µs cycle, d≈27 target; representative) | 1,024 logical | `None` (disabled) | `None` (disabled) | 1,000 | 27,000 | 27,000 | 1,000 | 1e-10 / 1e-09 / 1e-09 | 1 | 1 |
| `ideal_sim` | Ideal noise-free reference | `None` (unbounded) | `None` (disabled) | `None` (disabled) | 32 | 250 | 1,500 | 0 | 0 / 0 / 0 | 1 | 1 |

`None` for capacity means the stored profile is unbounded. `None` for T1/T2 disables separate memory decay: FTQC assumes memory errors are folded into logical operation errors, while the ideal reference has no noise. Neither meaning removes the cockpit's explicitly selected available-qubit limit; see [capacity overrides](#capacity-overrides).

## Profiles and provenance

Provenance distinguishes `vendor_or_literature_approximation`, `user_supplied_specification`, and `model_assumption` for table parameters; supplied values are not presented as retrieved device calibrations. All eight profiles treat `native_2q_per_cx` as a model assumption (r3 records it as inherited from r2); the shared provenance note says this conversion should be verified against a gate-decomposition reference. A linked source supplies context for an assumption, not evidence that the assumed value was measured.

### IBM Heron

This is a representative Heavy-Hex superconducting profile combining a **133-qubit capacity cap with r3-era timing**, not a measured calibration of one 133-qubit device. Routing expands resources by the assumed Heavy-Hex multiplier of 1.5.

- **Vendor/literature approximations:** `n_qubits_max`, `t1_us`, and `t_2q_ns`.
- **Model assumptions:** `t2_us`, `t_1q_ns`, `t_meas_ns`, `t_reset_ns`, `err_1q`, `err_2q`, `err_meas`, `topology_factor`, and `native_2q_per_cx`.
- **Statistic caveats:** T1 = 200 µs is a family-scale approximation; the 68 ns 2Q duration is an IBM Boston example. Neither establishes the calibration of the capacity-capped device. The profile's `statistics` dictionary is empty; the code gives no further per-field statistic types.
- **Sources — retrieval date 2026-11-01:** [IBM noise and errors](https://eu-de.quantum.cloud.ibm.com/learning/en/courses/tools-for-quantum-advantage/noise-and-errors) (primary `source_url`), [IBM processor types](https://quantum.cloud.ibm.com/docs/en/guides/processor-types).

### IBM Nighthawk r2

The `ibm_nighthawk_r2` preset represents **IBM Quantum System Two (Nighthawk r2)**: fixed-frequency superconducting transmons on a four-degree square grid with high-dynamic-range tunable couplers and independent dissipative reset. Capacity is **120 programmable qubits**, excluding the 218 couplers and 120 reset gadgets (458 total physical elements). The supplied deployment context is Hyde Park Labs (Chicago / NQAC), with ORNL Umbra / NCSA DeltaAI as hybrid-node examples; these are metadata, not simulated execution targets.

[IBM's r2 announcement](https://www.ibm.com/quantum/blog/nighthawk-r2) and [the compute-service changelog](https://eu-de.quantum.cloud.ibm.com/docs/en/guides/changelog-quantum-compute-service), retrieved 2026-11-07, support the capacity, topology, undisturbed T1≈200 µs, 1 µs inter-circuit delay, and 100,000+ circuits/s context. **T2=160 µs, native 2Q duration=40 ns, errors=0.00025/0.0037/0.0075** are the task-supplied specification and are marked `user_supplied_specification`, not independently retrieved device calibration. EPLG proxies native per-gate error; the combined readout/initialization value maps to `err_meas` once, without inventing a second initialization-error term.

The model reuses Heron's **32 ns 1Q and 1,500 ns readout** assumptions. Routing 1.2 uses the existing square-grid multiplier, with one native entangler per CX. Degree is metadata; no graph-aware transpilation is added. **7,500+ demonstrated gates** is gate count, not layer depth or a safe maximum, and imposes no partitioning cutoff. The reset-only effective T1≈25 ns never replaces the computational T1=200 µs.

The optional `repetition_rate_hz=100000` is a conservative peak-rate model: a complete shot takes `max(circuit_ns + readout_ns + reset_ns, 10000 ns)`. Reset is **1,000 ns**, counted once; any remaining pacing is reported as `repetition_delay_ms` inside the existing `measurement_reset_ms` I/O/control bucket. Long circuits exceed 10 µs and run below the peak rate. The 25× Heron comparison is benchmark context, not a universal speedup multiplier. Other profiles default to `repetition_rate_hz=None` and retain their previous timings. Neither pacing nor reset adds coherent exposure.

### IBM Nighthawk r3 and linked dual system

**Quantum System Two is the modular cryogenic mainframe/chassis; Heron and Nighthawk are its QPUs.** The live r2 system retains its name and physics. These r3 profiles represent the roadmap announced by IBM on November 11, 2026, including a linked system across coupled cryogenic modules in 2027.

| Field | Single r3 | Linked 2x r3 |
| --- | ---: | ---: |
| Programmable capacity (`n_qubits_max`) | 520 | 1,040 |
| Total physical qubits (`n_physical_qubits`) | 2,034 | 4,068 (2 × 2,034) |
| Modules / programmable qubits per module | 1 / 520 | 2 / 520 |
| Installed / active l-coupler bridge channels | 10 / 0 | 10 / 10 |
| Operation design target (`max_operations`) | 10,000 | 10,000 |
| Assumed peak complete-shot rate | 100,000 Hz | 100,000 Hz |

The operation target is advisory, not a hard depth cutoff or a guarantee of circuit survival. All local T1/T2, gate/readout/reset timings, errors, topology/native-entangler conversion and repetition rate are copied from r2 as **modeling assumptions**, classified individually as `model_assumption_inherited_from_r2` in provenance.

The linked system defaults to transfer fidelity **0.993**, extrapolated from the peak on four links between r1 processors, whose average was about **0.990**. **0.999** is an optional 2027 target scenario, not a demonstrated r3 calibration. Transfer duration defaults to **100 ns per scheduled round**, a configurable architectural assumption. Ten channels are counted once as bridge channels between the two modules.

The categorized hardware selector exposes these controls only for the linked profile. The API accepts an optional `interconnect` object:

```json
{"placement": "dual", "fidelity_scenario": "target_2027", "transfer_duration_ns": 80.0}
```

Defaults are `placement="auto"`, `fidelity_scenario="demonstrated"`, and the profile's 100 ns duration. Null duration uses the profile default. Controls are saved/restored with the canonical profile ID and exported in JSON; CSV/comparisons also expose the selected scenario and link diagnostics. Single-module profiles reject interconnect controls.

Auto placement uses **active circuit width**, not selected available capacity: ≤520 active qubits use one module and no transfers. Above 520, auto fills the first module then spills to the second. Explicit dual placement balances the active register across both modules. V1 traffic assumes uniformly mixed CX operand pairs: for partition widths L/R and q=L+R, remote CX count is `ceil(n_2q × 2LR / (q(q−1)))`, using the workload's pre-routing CX count. Each remote CX contributes two out-and-back state transfers; local gate resources remain charged. Rounds are `ceil(transfers / 10)`, an optimistic pooled schedule that ignores dependency stalls. Circuit width alone does not provide a measured interaction graph.

Link stalls extend coherent exposure and complete-shot timing; transfer fidelity enters T1/T2 survival once. `link_execution_ms` is already included in `gate_execution_ms`. Physical counts do not increase programmable capacity. Exploratory capacity overrides retain the reference module/channel count and extrapolate storage capacity beyond the published geometry when needed; they do not describe an available physical system.

Sources (retrieved 2026-11-12): [IBM announcement](https://newsroom.ibm.com/2026-11-11-ibm-quantum-nighthawk-demonstrates-new-levels-of-speed-and-quality%2C-with-plans-to-scale-beyond-1%2C000-qubits-in-2027), [r1 l-coupler demonstration](https://arxiv.org/abs/2610.29986), and the r2 baseline above. Provenance separates roadmap values, inherited assumptions and demonstrated r1 results.

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
3. **Batch latency:** charge launch once, then repeat circuit, measurement, reset and optional peak-rate pacing for every shot. Readout/reset/pacing are included in latency but excluded from coherent circuit exposure; launch is also excluded from exposure. The rate is in Hz; absent rates preserve timing-only behavior.

   ```text
   physical_shot_ns = native_depth × t_2q_ns + t_meas_ns + t_reset_ns
   shot_period_ns = max(physical_shot_ns, 1e9 / repetition_rate_hz)  # if rate set
   shot_period_ns = physical_shot_ns                              # otherwise
   latency_ms = launch_overhead_ms + shots × shot_period_ns / 1e6
   ```

4. **Per-shot survival:** combine independent 1Q, expanded 2Q, and measurement error probabilities with memory decay. For finite T1, the point estimate charges **all circuit qubits for the full circuit duration**, using `exp(-n_qubits × circuit_us / t1_us)`; it does not identify scheduled idle periods. `None` disables that decay term. Shots repeat latency, not the per-shot survival exponent.
5. **Sensitivity:** T1 gives both the point and best estimate. Worst uses T2 instead of T1 when available (otherwise T1) and takes the lower of that result and the point, so a T2 greater than T1 cannot improve the worst case. The idle terms are alternatives, not additive; the range is model sensitivity, not a confidence interval.
6. **Status:** the [backend classifier](../backend/main.py) calls survival ≥70% `NOMINAL`, ≥35% but <70% `DEGRADED`, and <35% `EXCEEDED`, using the unrounded percentage. Infeasible QPU execution reports zero survival.

The [layer-aware timing design](../backend/LAYER_TIMING_DESIGN.md) describes a separate reference diagnostic and a proposed versioned scheduling interface. It does not replace the current `CALIBRATED_V2` production formula or justify inferring a layer mix from gate totals.

## Custom / Research hardware

Select **Custom / Theoretical QPU (User-Defined)** to open the collapsible Custom Hardware Configuration Panel. Clone any of the eight built-in profiles, edit the grouped physics fields, and run explicitly. The baseline ID records lineage only; editing a custom profile never changes the built-in registry. Labels are limited to 120 printable characters.

The API accepts `hardware_profile="custom"` with a required `custom_profile` object. Other hardware selectors reject this object. `CustomQPUProfileSpec` shares strict, frozen, finite-number physical validation with `QPUProfile`: positive 2Q timing and lifetimes, nonnegative other operation durations, errors in [0,1], routing/native-CX multipliers ≥1, optional positive repetition rate, and optional null lifetimes/capacity. Custom capacity is bounded to the public int32 range. Unknown keys, booleans in numeric fields, numeric strings, NaN and infinity are rejected; scientific notation is supported in JSON numbers and builder inputs. Finite parameters that overflow derived timing calculations return HTTP 422 rather than nonfinite telemetry.

The fields are `name`, optional `base_profile_id`, `n_qubits_max`, `t1_us`, `t2_us`, `t_1q_ns`, `t_2q_ns`, `t_meas_ns`, `t_reset_ns`, `err_1q`, `err_2q`, `err_meas`, `topology_factor`, optional `native_2q_per_cx` and `repetition_rate_hz`, plus the existing module/link and physical-count metadata fields shown above. `base_profile_id` must be one of the eight built-in IDs. Missing optional fields receive the same defaults as `QPUProfile`; missing installed channel count is inferred from active channels.

The existing V1 partition model supports **one or two modules**, with custom programmable qubits per module, installed/active channels, transfer fidelity, optional target fidelity, and ns per transfer round. Active channels cannot exceed installed channels; linked modules require capacity, active channels, fidelity and duration. Declared custom capacity cannot exceed the reference module geometry. Auto placement uses active circuit width and schedules `ceil(transfers / active_channels)` rounds. Optional `interconnect` placement and fidelity controls work on linked custom profiles; the target scenario requires a defined target fidelity. The historical wire token `target_2027` selects that alternate fidelity, without claiming the custom hardware has been demonstrated. All other link physics is shared with r3.

**Logical FTQC Mode** writes `t1_us=null` and `t2_us=null`, disabling separate idle decay while retaining gate, readout and link survival penalties. Logical memory errors must then be included in operation-error assumptions; this is not a syndrome-level QEC simulation. Turning the toggle off restores the lifetimes held while the panel was open, or the initial representative lifetimes after loading a logical preset.

Named presets are explicitly saved/loaded in localStorage under `q-split.custom-hardware-presets.v1`, limited to 30 names, with same-name saves replacing that preset. Presets contain physics and clone lineage; per-run placement/scenario controls are captured separately with each simulation. Browser storage errors do not prevent editing or simulation. Presets are local to this browser, whereas saved run history contains a complete immutable request and embedded resolved `qpu_profile`, so restoration works independently of local presets.

Resolved custom profiles have `id="custom"`; provenance marks each parameter `user_defined_custom` and records `base_profile_id`. Advisor, proxy and persistence validation bound embedded physics and verify that it matches captured controls, instead of comparing it to static vendor constants. Custom names remain untrusted data in advisor prompts. Comparison rows show the custom name and cloned baseline, and CSV includes the name, baseline ID and complete custom-parameter JSON alongside existing link diagnostics. JSON exports retain the full request and telemetry.

Available-qubit overrides retain the existing exploratory semantics below; physical-count metadata and advisory operation targets are not extra programmable capacity or hard depth cutoffs.

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

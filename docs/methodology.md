[Back to README](../README.md)

# Methodology

This document collects Q-Split's existing model contract, worked examples, and reference diagnostics. The technical material below is moved from the README; it describes simulation estimates and their stated limitations.

- [Engine context](#engine-context)
- [Verdict taxonomy](#verdict-taxonomy)
- [FTQC examples and profile resources](#ftqc-examples-and-profile-resources)
- [Timing, survival and calibration](#timing-survival-and-calibration)

## Engine context

* Frontend & API: Next.js 16 (React 19, TypeScript, Tailwind CSS) with custom parser validation and Prisma ORM backed by Neon Serverless PostgreSQL. FastAPI uses Pydantic for backend request validation.
* Backend Engine: Containerized Python FastAPI simulating reference circuits with Qiskit Aer alongside an analytical hardware profiler. CPU/GPU/QPU routing selects cost models; no physical QPU connection is used.
* Dual Simulation Modes:
  1. Qiskit Aer Statevector References: N = 15 and M = 64 sequential references execute in Qiskit Aer; other tiers and larger scales use analytical projections. The references use 8 qubits for Shor's Algorithm and 10 for the Quantum-MIPS marked-state demonstration. The latter does not execute vector loading or adaptive maximum finding; its measured CPU simulator timings are separate from projected GPU/QPU timings and coherence.
  2. Analytical Co-Design Profiler: Closed-form models for other tiers and larger scales (Shor N >= 21 through RSA-2048; Quantum-MIPS M >= 1,024 through 1,048,576), tracking statevector RAM limits (`16 × 2^q` bytes for `q` emulated qubits), gate resources, independent gate errors, and T1 decay.

### Verdict taxonomy

These statuses describe distinct layers of the simulation:

| Layer | Internal values | Meaning |
| --- | --- | --- |
| Overall Pipeline Offload State | `optimal` \| `warning` \| `blocked` | The derived offload verdict considers execution feasibility, coherence, interconnect costs, and available CPU comparisons. |
| Per-Stage Bottleneck Severity | `OPTIMAL` \| `WARNING` \| `CRITICAL_BOTTLENECK` | Each pipeline stage reports its own execution status; this vocabulary also appears in persisted bottleneck summaries. |
| Coherence Status | `NOMINAL` \| `DEGRADED` \| `EXCEEDED` | The coherence budget uses survival thresholds of 70% and 35%; a blocked QPU route overrides survival to `EXCEEDED`. |

These vocabularies are intentionally separate: a `NOMINAL` coherence budget alone does not establish an `optimal` offload verdict. All internal enums and status values remain unchanged, as do API and database contracts.

## FTQC examples and profile resources

At the FTQC default capacity, small Shor workloads select Carry-Lookahead and MIPS selects Multi-Oracle. Survival is per shot; batch time includes 512 Shor or 1,024 MIPS shots. Logical protection gives `NOMINAL` (>99.9%) survival in these examples, while the lattice-surgery clock remains slower than the illustrative native classical algorithm. Statevector emulation is a separate comparison and may exceed RAM limits.

| Workload | Logical survival | Circuit per shot | QPU shot batch | Native CPU kernel |
| --- | ---: | ---: | ---: | ---: |
| Shor N=15 | 99.999901% | 10.611 ms | 5.447 s | 0.000030 ms |
| Shor N=21 | 99.999807% | 17.955 ms | 9.208 s | 0.000040 ms |
| Shor N=35 | 99.999667% | 26.649 ms | 13.659 s | 0.000050 ms |
| MIPS M=64 | 99.999930% | 5.967 ms | 6.139 s | 0.098304 ms |
| MIPS M=1,024 | 99.999539% | 39.555 ms | 40.533 s | 1.572864 ms |
| MIPS M=32,768 | 99.996098% | 335.637 ms | 343.721 s | 50.331648 ms |
| MIPS M=131,072 | 99.991158% | 760.779 ms | 779.067 s | 201.326592 ms |
| MIPS M=1,048,576 | 99.970585% | 2.531 s | 2,592.250 s | 1,610.612736 ms |

These values are outputs of the existing workload/estimator models at 1,024 available logical qubits, not additional physical constants. The same-capacity Heron examples all report `EXCEEDED` coherence. Thresholds remain 70% / 35%; >99.9% is the verification target for this FTQC preset, not a new status threshold.

The backend's `QPUProfile` objects in `backend/profiles.py` record source URLs, the retrieval date, and per-field value types distinguishing literature/vendor approximations from modeling assumptions. IBM uses T1 = 200 µs, consistent with [IBM's family-scale discussion](https://eu-de.quantum.cloud.ibm.com/learning/en/courses/tools-for-quantum-advantage/noise-and-errors); Forte uses the upper end of its [published 10–100 second T1 range](https://www.ionq.com/quantum-systems/forte) and gate times from the [30-qubit Forte paper](https://arxiv.org/html/2308.05071v2). These are representative presets, not live calibrations. The pure estimator enforces profile capacity; the cockpit can explicitly override it to explore hypothetical devices, reported as `capacity_override` while retaining the published reference.

`backend/models.py` defines `CircuitSpec` (qubits, depth, gate/measurement counts, and host-stage costs) independently of hardware. Workload adapters in `backend/workloads.py` build specifications; `backend/estimation.py` contains the pure QPU and CPU/GPU estimators. This resource interface can accept a future BYOC adapter without adding workload-specific physics.

## Timing, survival and calibration

Simulation responses identify this physics model with `routing_model: "CALIBRATED_V2"` and `resource_model_version: 2`, including CPU/GPU and blocked routes. Next.js stores these fields in the existing `telemetry` JSON column; no SQL migration is required. Historical runs without a version resolve to V1. Saved snapshots show the version, comparisons suppress deltas across versions, and the advisor rejects cross-version comparisons and includes the version in its cache fingerprint. QPU latency breakdowns use `gate_execution_ms` for compute and `launch_overhead_ms` plus `measurement_reset_ms` for I/O/control. Those costs are already included in `latency_ms`; `io_state_prep_ms: 0.0` does not imply zero I/O.

QPU batch latency is `launch_ms + shots × (depth × t_2q_ns + t_meas_ns + t_reset_ns) / 1e6` when no repetition rate is configured. With optional `repetition_rate_hz`, each complete shot instead takes `max(depth × t_2q_ns + t_meas_ns + t_reset_ns, 1e9 / repetition_rate_hz)` ns. Nighthawk r2 uses 100,000 Hz (10 µs minimum period), 40 ns 2Q gates and a 1,000 ns reset. Remaining pacing is a subset of `measurement_reset_ms`, exposed as `repetition_delay_ms`, never a fourth additive bucket or coherent exposure. No global 25× latency multiplier is applied. Effective native depth and 2Q count are each `ceil(CX-basis resource × topology_factor × native_2q_per_cx)`. The conversion factor is 2 for Weber and 1 for the other profiles; it is recorded as a `model_assumption`. The T1 point survival formula remains `(1−err_1q)^n_1q × (1−err_2q)^n_2q × (1−err_meas)^n_meas × exp(−n_qubits × T_circuit_us / t1_us)`, with `T_circuit_us = native_depth × t_2q_ns / 1000` and native `n_2q`. Launch, measurement and reset repeat for latency but do not extend coherent circuit exposure. T2 supplies an alternative sensitivity scenario; 1Q duration remains stored for future scheduling models. Shor uses 512 shots and MIPS 1,024; each batch has an illustrative 0.30 ms launch. `latency_ms` includes all batch costs, so `io_state_prep_ms` is zero to avoid charging them twice.

Survival telemetry includes `coherence_survival_best` and `coherence_survival_worst` as probabilities in `[0,1]`. Best equals the existing T1 point (`coherence_survival`); worst replaces T1 with T2 where available, otherwise T1, and takes the lower of this alternative and the point. This cap preserves ordering when T2 exceeds T1, as in the stored Weber approximation. `coherence_survival_pct` retains full floating-point precision in API telemetry; the 70% / 35% status thresholds use that unrounded T1 value. Percentage formatting happens only in displays, with scientific notation for tiny nonzero values. The range describes model sensitivity, not a confidence interval or experimentally established bounds.

`coherence_log_survival` is the natural log of the T1 point and remains finite when the probability underflows to zero. It is `null` for infeasible execution or certain failure, and exactly zero for the ideal profile. `log_survival_terms` reports signed natural-log contributions `one_qubit`, `two_qubit`, `measurement`, `idle_t1`, and `idle_t2`. The point is `exp(one_qubit + two_qubit + measurement + idle_t1)`; worst uses `min(idle_t1, idle_t2)` instead. **The idle entries are alternatives; never sum both.** Three conservative modeling choices remain explicit: charge every qubit for the full circuit rather than scheduled idle time, bill every layer at the 2Q duration, and combine that decay with calibrated gate errors that may already include gate-time decoherence. No attempt is made to subtract that overlap without calibration evidence. A null individual log term represents negative infinity (certain failure); infeasible execution has zero survival bounds and a null breakdown.

Existing survival displays show a compact best/worst annotation when range telemetry is available; historical or blocked runs without a physical estimate add no annotation. The advisor validates the bounded probabilities and fixed numeric log breakdown, pruning unknown nested fields. Both advisor routes accept unrounded percentages, nullable finite `coherence_log_survival`, best/worst probabilities, and the log breakdown. The compact LLM digest includes the point percentage, log point, and best/worst probabilities; it omits detailed log terms and the duplicate point probability.

Run `backend/venv/bin/python backend/scripts/validate_survival.py` for a separate, seeded Aer noise comparison of N=15 peak probability and MIPS-64 marked-state probability against analytic best/point/worst survival for IBM, Weber, Forte and the representative FTQC logical profile. FTQC uses logical-operation noise only, with no separate thermal relaxation; this is not a syndrome-level QEC simulation. `--shots COUNT` overrides the production defaults. This CLI imports no FastAPI code and is never imported by the API. It maps profile gate errors to uniform nonidentity Pauli noise, adds symmetric readout flips, and applies [Aer thermal relaxation](https://qiskit.github.io/qiskit-aer/stubs/qiskit_aer.noise.thermal_relaxation_error.html) using stored T1/T2 and gate times. All 1Q basis gates use the representative 1Q duration, including `rz`; CX noise repeats the native-entangler conversion count without claiming device-native compilation. The sampled metric is an output probability, not no-error survival or verified factoring success, and need not lie within the analytic sensitivity range. Aer applies gate-local relaxation without topology routing or unscheduled idle exposure; the analytic model charges routed resources and all-qubit exposure. Combining gate errors and thermal noise can double-count decoherence. The CLI prints these assumptions with its table and rejects unsupported thermal parameters rather than silently changing them.

A separate [layer-aware timing design](../backend/LAYER_TIMING_DESIGN.md) and `backend/scripts/analyze_layer_timing.py` derive dependency-layer diagnostics from compiled toy references. They do not change production timing or infer an unsupported analytic layer mix. Version 1 continues billing every layer at the 2Q duration.

`classical_baselines` reports **Classical Circuit Emulation** and **Native Classical Algorithm** separately. Emulation uses complex128 RAM and illustrative amplitude-operation costs; a native comparison is supplied by the workload adapter, not inferred from qubit count. Toy factoring and exhaustive MIPS include labeled cost assumptions. Generic circuits and RSA sizes without a calibrated native estimate report that comparison as unavailable. `classical_cpu_baseline` remains the emulation comparison for existing consumers.

All Shor and MIPS sizes use analytic depth and gate-count proxies, including N=15 and M=64. In `backend/workloads.py`, `DEPTH_EXPANSION_FACTOR` corrects depth while `GATE_COUNT_EXPANSION_FACTOR` independently corrects the 1Q/2Q proxies. Both workloads use the same gate-count expansion logic; CX count is not equated to expanded depth. Live Aer only supplies cross-check fields such as `aer_reference_circuit_depth`, `aer_gate_counts`, counts and simulator timings; it never replaces a modeled `CircuitSpec` or the analytic `reference_circuit_depth`. Both references use the production `{cx, rz, sx, x}` basis, optimization level 1 and seed 7 from `backend/circuits.py`.

Run `backend/venv/bin/python backend/scripts/calibrate_depth.py` to reproduce the calibration without importing FastAPI. On 2026-11-02, Qiskit 2.6.1 / Aer 0.18.0 gave:

| Toy reference | Logical depth | Compiled depth | CX count | 1Q count | Depth ratio | 1Q ratio | 2Q ratio |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Shor N=15 | 288 | 1,594 | 798 | 1,635 | 5.534722 | 2.838542 | 2.770833 |
| MIPS M=64 | 202 | 1,084 | 588 | 1,161 | 5.366337 | 2.873762 | 2.910891 |

The depth factor **5.45** is the arithmetic mean of the two depth ratios, rounded to two decimals. The gate-count factor **2.85** is the arithmetic mean of all four compiled/proxy gate-count ratios, using analytic 1Q = twice logical depth and analytic 2Q = logical depth. These produce sequential analytic resources `(depth, 1Q, 2Q)` of `(1,570, 1,642, 821)` for Shor and `(1,101, 1,152, 576)` for MIPS. Both factors are `model_assumption` corrections measured only on **sequential-tier toy circuits**. They are applied unchanged to windowed/carry-lookahead (and MIPS multi-oracle) tiers and large scales, with **no evidence supporting that extrapolation**. N=15 implements a special-cased SWAP permutation rather than general modular exponentiation. These are not validated scaling laws; the survival estimates are neither algorithm success probabilities nor a calibrated Aer noise model.

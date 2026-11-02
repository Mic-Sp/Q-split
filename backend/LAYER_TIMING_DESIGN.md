# Layer-aware timing design

## Current production contract

Resource model version 2 (`CALIBRATED_V2`) retains `ceil(spec.depth * topology_factor * native_2q_per_cx) * t_2q_ns` for circuit duration. It bills every layer at the 2Q duration, including layers containing only 1Q gates. Readout/reset and launch are charged separately. The same circuit duration supplies the conservative all-qubit idle exposure used by the survival model.

This design does not change that formula, the two workload expansion factors, profile values, response keys, or the 70/35 thresholds. The analytic workloads continue building the same specifications at every scale. Live reference measurements are cross-checks only.

## Reproducible reference diagnostic

Run from the repository root:

```sh
backend/venv/bin/python backend/scripts/analyze_layer_timing.py
```

The script builds both production reference circuits and uses the production compiler settings. It partitions dependency layers into 1Q-only, 2Q-only, mixed 1Q/2Q, and measurement-only categories. Unknown operations are rejected. No FastAPI or Aer execution is needed.

Observed with Qiskit 2.6.1, `{cx, rz, sx, x}`, optimization level 1, seed 7, on 2026-11-02:

| Reference | 1Q-only | 2Q-only | Mixed | Measurement-only | Compiled depth |
| --- | ---: | ---: | ---: | ---: | ---: |
| Shor N=15 | 824 | 483 | 286 | 1 | 1,594 |
| MIPS M=64 | 531 | 404 | 148 | 1 | 1,084 |

Statistic type: observed counts of transpiled dependency layers, not physical-device measurements. These counts are separate from the unchanged depth and gate-count expansion factors.

The diagnostic computes an unrouted, per-shot gate-time scenario:

```text
cx_duration = native_2q_per_cx * t_2q_ns
gate_ns = one_only * t_1q_ns
        + two_only * cx_duration
        + mixed * max(t_1q_ns, cx_duration)
```

It excludes measurement-only layers from gate exposure; measurement/reset and launch are not included in this diagnostic. On the stored Forte profile, the Shor reference gives 782,740,000 ns versus 1,434,600,000 ns when every compiled depth layer is billed at the 2Q duration. MIPS gives 555,210,000 ns versus 975,600,000 ns. These are model scenarios for the compiled sequential references, not replacements for production batch latency.

The durations come from `profiles.py`; the diagnostic includes the profile source URL and retrieval date. Its timing statistic is the sum of the longest stored gate duration in each dependency layer. Timing is explicitly flagged `model_assumption`: dependency layers are not a calibrated pulse schedule, CX conversion is approximate, and extra decomposition 1Q gates, routing, overlap with measurement, and hardware scheduling constraints are not resolved.

## Proposed estimator interface

Before enabling layer-aware production timing, introduce a separate, versioned timing description alongside `CircuitSpec`. It should describe complete gate layers (including mixed layers), carry compilation/provenance metadata, and distinguish observed circuit structure from an assumed analytic layer mix. Validate that layer coverage, depth, gate counts, and basis agree. Delays, reset instructions, mid-circuit measurement, and feed-forward need explicit semantics before accepting those circuits.

Keep the duration calculation pure: the adapter supplies the timing description; the estimator receives that description and `QPUProfile`, with no circuit imports, I/O, or simulator calls. Apply native conversion and routing in one documented place. A device-compiled schedule must not receive those expansions again.

When no timing description exists, retain the conservative version-1 fallback. Do not infer a layer mix from `n_1q`, `n_2q`, or two toy circuits: aggregate counts and depth do not determine a schedule. Any future analytic mix must have `model_assumption` provenance, a stated range of applicability, and sensitivity tests. The toy ratios must not silently extrapolate to larger scales or parallel tiers.

For all analytic scales, use one consistent timing policy. Do not switch M=64 or N=15 to measured layers while larger scales retain the fallback. Expose reference layer diagnostics separately if they are ever added to API telemetry, and update backend response types, frontend types, advisor allowlists, and integration tests together.

## Required checks before a production timing change

- Pure 1Q, pure 2Q, and mixed layers, including a profile where 1Q duration exceeds 2Q duration.
- Measurement/reset/launch billed exactly once and excluded from coherent gate exposure as specified.
- Native conversion/routing applied once; explicit device schedules avoid duplicate expansion.
- Consistent spec construction across live/analytic scales; monotonic workload scaling retained.
- Reconstructed log survival and unchanged 70/35 thresholds, JSON-safe underflow/certain failure.
- Real payloads through both Next.js advisor routes, including historical runs without new fields.

The current diagnostic tests cover reference partitioning, mixed-layer duration, unknown operations, and preservation of the production fallback. Adopting the proposed interface is a separate model change requiring validated schedule inputs.

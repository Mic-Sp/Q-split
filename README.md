# ⚡ Q-Split

### Hybrid Quantum-Classical Workload Profiler & Heterogeneous Orchestrator

**Live Cockpit:** https://q-split.vercel.app/  
**Engine API (FastAPI):** https://q-split-engine.onrender.com/docs

---

## 🎯 Overview

**Q-Split** is a full-stack simulator and co-design profiler for exploring quantum-classical workload placement. Its 3-stage pipeline compares modeled CPU/GPU execution and QPU offload while accounting for illustrative launch/transfer overhead, circuit depth, statevector memory limits, and NISQ decoherence. Results are simulation estimates, not physical-device benchmarks or proof of practical quantum advantage.

---

## 🛠️ System Architecture & Dual Engine

* Frontend & API: Next.js 16 (React 19, TypeScript, Tailwind CSS) with custom parser validation and Prisma ORM backed by Neon Serverless PostgreSQL. FastAPI uses Pydantic for backend request validation.
* Backend Engine: Containerized Python FastAPI simulating reference circuits with Qiskit Aer alongside an analytical hardware profiler. CPU/GPU/QPU routing selects cost models; no physical QPU connection is used.
* Dual Simulation Modes:
  1. Qiskit Aer Statevector References: N = 15 and M = 64 sequential references execute in Qiskit Aer; other tiers and larger scales use analytical projections. The references use 8 qubits for Shor's Algorithm and 10 for the Quantum-MIPS marked-state demonstration. The latter does not execute vector loading or adaptive maximum finding; its measured CPU simulator timings are separate from projected GPU/QPU timings and coherence.
  2. Analytical Co-Design Profiler: Closed-form models for other tiers and larger scales (Shor N >= 21 through RSA-2048; Quantum-MIPS M >= 1,024 through 1,048,576), tracking statevector RAM limits (`16 × 2^q` bytes for `q` emulated qubits), gate resources, independent gate errors, and T1 decay.

The hosted backend on Render may take 30–50 seconds or longer to spin up after inactivity. Keep the page open while the initial request completes; [Render documents free-service startup as taking about a minute](https://render.com/docs/free#spinning-down-on-idle).

### Verdict taxonomy

These statuses describe distinct layers of the simulation:

| Layer | Internal values | Meaning |
| --- | --- | --- |
| Overall Pipeline Offload State | `optimal` \| `warning` \| `blocked` | The derived offload verdict considers execution feasibility, coherence, interconnect costs, and available CPU comparisons. |
| Per-Stage Bottleneck Severity | `OPTIMAL` \| `WARNING` \| `CRITICAL_BOTTLENECK` | Each pipeline stage reports its own execution status; this vocabulary also appears in persisted bottleneck summaries. |
| Coherence Status | `NOMINAL` \| `DEGRADED` \| `EXCEEDED` | The coherence budget uses survival thresholds of 70% and 35%; a blocked QPU route overrides survival to `EXCEEDED`. |

These vocabularies are intentionally separate: a `NOMINAL` coherence budget alone does not establish an `optimal` offload verdict. All internal enums and status values remain unchanged, as do API and database contracts.

---

## 🎛️ Supported Workloads & Hardware Profiles

* Shor's Algorithm (N = 15, 21, 35, RSA-512, RSA-2048): The public API accepts these five presets, matching the frontend; other Shor scales return HTTP 422. Models factoring pipelines, with CPU preferred for scalar host stages in this calibration. RSA-scale runs project resource requirements; they do not factor real RSA keys. The QPU model accounts for modular-exponentiation depth and coherence limits.
* Quantum-MIPS (Maximum Inner Product Search; LLM Vector Retrieval) (M = 64, 1,024, 32k, 128k, 1M): Models LSH pruning and FP16 reranking, with GPU hosts preferred at M >= 1,024. Grover's search / amplitude amplification uses O(√M) iterations in the reference model. This is not a measured end-to-end vector retrieval speedup.

### Hardware Profiles

* IBM Heron (133-qubit cap, r3-era timing; representative): Heavy-Hex superconducting connectivity and modeled SWAP routing overhead. Capacity and timing are representative assumptions rather than a single device calibration.
* Google Weber (2D Grid): 53 qubits, 32 ns √iSWAP gates paired with their 0.9% typical isolated XEB error, and typical T1 of 15 µs from the [14 May 2021 Weber datasheet](https://quantumai.google/hardware/datasheet/weber.pdf). The model assumes two native √iSWAP gates per CX, applied to both depth and 2Q count; this conversion needs verification against a gate-decomposition reference. The datasheet's typical 1–5 kHz repetition rate is supporting provenance context; the reset-time assumption is unchanged. The 53-qubit selector is the reference; 72 and other larger capacities remain exploratory overrides.
* IonQ Forte (Trapped Ion): 36-qubit reference with all-to-all connectivity, high gate fidelity, and long coherence. The model removes SWAP routing layers but uses slower laser-driven gate execution; high fidelity does not mean noise-free execution.
* FTQC Surface-Code Logical QPU (`ftqc_surface_code`): 1,024 logical workspace qubits, a representative d≈27 target, and 27 µs logical lattice-surgery 2Q gates/measurement (`27 × 1 µs`), compared with Heron's representative 68 ns physical entangler. The selector sets capacity to 1,024 and includes that preset. [Gidney 2025](https://arxiv.org/abs/2505.15917) assumes a 1 µs code cycle and 0.1% physical gate error; [Willow QEC](https://arxiv.org/abs/2408.13687) reports 1.1 µs cycles and Λ = 2.14 ± 0.02 suppression per distance increase of two. The d≈27 target, roughly 1,000 physical superconducting qubits per logical qubit, one-cycle initialization, and logical errors of 1e-10 (1Q) / 1e-9 (2Q/measurement) are model assumptions, not measured d=27 performance or a direct extrapolation of Willow. Supporting physical resources and magic-state factories are excluded. Under active syndrome extraction, idle memory errors are assumed folded into logical operation errors; `t1_us`/`t2_us` are `None` to avoid double-counting a separate relaxation penalty. This does not imply infinite physical coherence. All fields carry provenance retrieved on 2026-11-02.
* Ideal Noise-Free: Theoretical reference with 100% modeled coherence for feasible execution. Capacity and routing limits still apply.

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

Simulation responses identify this physics model with `routing_model: "CALIBRATED_V2"` and `resource_model_version: 2`, including CPU/GPU and blocked routes. Next.js stores these fields in the existing `telemetry` JSON column; no SQL migration is required. Historical runs without a version resolve to V1. Saved snapshots show the version, comparisons suppress deltas across versions, and the advisor rejects cross-version comparisons and includes the version in its cache fingerprint. QPU latency breakdowns use `gate_execution_ms` for compute and `launch_overhead_ms` plus `measurement_reset_ms` for I/O/control. Those costs are already included in `latency_ms`; `io_state_prep_ms: 0.0` does not imply zero I/O.

QPU batch latency is `launch_ms + shots × (depth × t_2q_ns + t_meas_ns + t_reset_ns) / 1e6`. Effective native depth and 2Q count are each `ceil(CX-basis resource × topology_factor × native_2q_per_cx)`. The conversion factor is 2 for Weber and 1 for the other profiles; it is recorded as a `model_assumption`. The T1 point survival formula remains `(1−err_1q)^n_1q × (1−err_2q)^n_2q × (1−err_meas)^n_meas × exp(−n_qubits × T_circuit_us / t1_us)`, with `T_circuit_us = native_depth × t_2q_ns / 1000` and native `n_2q`. Launch, measurement and reset repeat for latency but do not extend coherent circuit exposure. T2 supplies an alternative sensitivity scenario; 1Q duration remains stored for future scheduling models. Shor uses 512 shots and MIPS 1,024; each batch has an illustrative 0.30 ms launch. `latency_ms` includes all batch costs, so `io_state_prep_ms` is zero to avoid charging them twice.

Survival telemetry includes `coherence_survival_best` and `coherence_survival_worst` as probabilities in `[0,1]`. Best equals the existing T1 point (`coherence_survival`); worst replaces T1 with T2 where available, otherwise T1, and takes the lower of this alternative and the point. This cap preserves ordering when T2 exceeds T1, as in the stored Weber approximation. `coherence_survival_pct` retains full floating-point precision in API telemetry; the 70% / 35% status thresholds use that unrounded T1 value. Percentage formatting happens only in displays, with scientific notation for tiny nonzero values. The range describes model sensitivity, not a confidence interval or experimentally established bounds.

`coherence_log_survival` is the natural log of the T1 point and remains finite when the probability underflows to zero. It is `null` for infeasible execution or certain failure, and exactly zero for the ideal profile. `log_survival_terms` reports signed natural-log contributions `one_qubit`, `two_qubit`, `measurement`, `idle_t1`, and `idle_t2`. The point is `exp(one_qubit + two_qubit + measurement + idle_t1)`; worst uses `min(idle_t1, idle_t2)` instead. **The idle entries are alternatives; never sum both.** Three conservative modeling choices remain explicit: charge every qubit for the full circuit rather than scheduled idle time, bill every layer at the 2Q duration, and combine that decay with calibrated gate errors that may already include gate-time decoherence. No attempt is made to subtract that overlap without calibration evidence. A null individual log term represents negative infinity (certain failure); infeasible execution has zero survival bounds and a null breakdown.

Existing survival displays show a compact best/worst annotation when range telemetry is available; historical or blocked runs without a physical estimate add no annotation. The advisor validates the bounded probabilities and fixed numeric log breakdown, pruning unknown nested fields. Both advisor routes accept unrounded percentages, nullable finite `coherence_log_survival`, best/worst probabilities, and the log breakdown. The compact LLM digest includes the point percentage, log point, and best/worst probabilities; it omits detailed log terms and the duplicate point probability.

Run `backend/venv/bin/python backend/scripts/validate_survival.py` for a separate, seeded Aer noise comparison of N=15 peak probability and MIPS-64 marked-state probability against analytic best/point/worst survival for IBM, Weber, Forte and the representative FTQC logical profile. FTQC uses logical-operation noise only, with no separate thermal relaxation; this is not a syndrome-level QEC simulation. `--shots COUNT` overrides the production defaults. This CLI imports no FastAPI code and is never imported by the API. It maps profile gate errors to uniform nonidentity Pauli noise, adds symmetric readout flips, and applies [Aer thermal relaxation](https://qiskit.github.io/qiskit-aer/stubs/qiskit_aer.noise.thermal_relaxation_error.html) using stored T1/T2 and gate times. All 1Q basis gates use the representative 1Q duration, including `rz`; CX noise repeats the native-entangler conversion count without claiming device-native compilation. The sampled metric is an output probability, not no-error survival or verified factoring success, and need not lie within the analytic sensitivity range. Aer applies gate-local relaxation without topology routing or unscheduled idle exposure; the analytic model charges routed resources and all-qubit exposure. Combining gate errors and thermal noise can double-count decoherence. The CLI prints these assumptions with its table and rejects unsupported thermal parameters rather than silently changing them.

A separate [layer-aware timing design](backend/LAYER_TIMING_DESIGN.md) and `backend/scripts/analyze_layer_timing.py` derive dependency-layer diagnostics from compiled toy references. They do not change production timing or infer an unsupported analytic layer mix. Version 1 continues billing every layer at the 2Q duration.

`classical_baselines` reports **Classical Circuit Emulation** and **Native Classical Algorithm** separately. Emulation uses complex128 RAM and illustrative amplitude-operation costs; a native comparison is supplied by the workload adapter, not inferred from qubit count. Toy factoring and exhaustive MIPS include labeled cost assumptions. Generic circuits and RSA sizes without a calibrated native estimate report that comparison as unavailable. `classical_cpu_baseline` remains the emulation comparison for existing consumers.

All Shor and MIPS sizes use analytic depth and gate-count proxies, including N=15 and M=64. In `backend/workloads.py`, `DEPTH_EXPANSION_FACTOR` corrects depth while `GATE_COUNT_EXPANSION_FACTOR` independently corrects the 1Q/2Q proxies. Both workloads use the same gate-count expansion logic; CX count is not equated to expanded depth. Live Aer only supplies cross-check fields such as `aer_reference_circuit_depth`, `aer_gate_counts`, counts and simulator timings; it never replaces a modeled `CircuitSpec` or the analytic `reference_circuit_depth`. Both references use the production `{cx, rz, sx, x}` basis, optimization level 1 and seed 7 from `backend/circuits.py`.

Run `backend/venv/bin/python backend/scripts/calibrate_depth.py` to reproduce the calibration without importing FastAPI. On 2026-11-02, Qiskit 2.6.1 / Aer 0.18.0 gave:

| Toy reference | Logical depth | Compiled depth | CX count | 1Q count | Depth ratio | 1Q ratio | 2Q ratio |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Shor N=15 | 288 | 1,594 | 798 | 1,635 | 5.534722 | 2.838542 | 2.770833 |
| MIPS M=64 | 202 | 1,084 | 588 | 1,161 | 5.366337 | 2.873762 | 2.910891 |

The depth factor **5.45** is the arithmetic mean of the two depth ratios, rounded to two decimals. The gate-count factor **2.85** is the arithmetic mean of all four compiled/proxy gate-count ratios, using analytic 1Q = twice logical depth and analytic 2Q = logical depth. These produce sequential analytic resources `(depth, 1Q, 2Q)` of `(1,570, 1,642, 821)` for Shor and `(1,101, 1,152, 576)` for MIPS. Both factors are `model_assumption` corrections measured only on **sequential-tier toy circuits**. They are applied unchanged to windowed/carry-lookahead (and MIPS multi-oracle) tiers and large scales, with **no evidence supporting that extrapolation**. N=15 implements a special-cased SWAP permutation rather than general modular exponentiation. These are not validated scaling laws; the survival estimates are neither algorithm success probabilities nor a calibrated Aer noise model.

---

## Interface and saved runs

* Themes: Use the header's Sun/Moon button to switch light and dark modes, or the monitor button to follow the system preference. System mode is the default; your theme choice persists across browser reloads.
* Quick history filters: **All Runs**, **Nominal Only**, and **Pinned Only** show matching counts for the active workload's loaded runs. Filtering happens in memory, without additional API calls or database queries. Nominal matches the `NOMINAL` coherence budget status; pinned includes pinned or named snapshots. The table initially displays the latest five matching rows; **Show all** expands the loaded matches.
* Restore and export: **Restore to Simulator** loads a saved run from the active browser session into the controls; click **Run simulation** to execute it. Select up to three runs for comparison. CSV/JSON export uses selected runs, including hidden selections, or the displayed rows when nothing is selected.
* Retention: History retains at most 20 unpinned, unnamed runs per session across workloads. Named or pinned snapshots are protected. See the persistence and TTL sections below for the 48-hour cleanup policy.

---

## 🤖 AI Telemetry Advisor & Unit Economics

* Powered by Google Gemini AI with strict system instruction grounding and a Hardware Control Constraint Guardrail.
* Neon PostgreSQL Read-Through Caching: Matching diagnostics can be reused with zero new model tokens or estimated inference cost. Cache keys include configuration, telemetry, comparison context, model, and policy.
* Live UI Telemetry Strip: Distinguishes **Live AI**, **Cached DB Hit**, **Reused diagnostic**, and **Deterministic Fallback**, with token counts, estimated USD cost, and lookup latency. Reusing a saved diagnostic does not imply a new database cache lookup.

Advisor provider requests use two 60-second sliding windows: at most **5 live attempts per browser session** and **8 per connecting IP**. Valid persistent-cache hits and coalesced followers consume no tokens; missing provider credentials also consume none. Limits are checked atomically immediately before the outbound request, so failed provider attempts count. When a limit is reached, both advisor endpoint names return the usual HTTP 200 deterministic fallback with a cooldown notice and zero new model usage.

On Vercel, IP identification uses the platform-controlled `x-vercel-forwarded-for` header, falling back to `x-real-ip` only when that header is absent. Arbitrary forwarding chains are ignored. Missing or malformed session UUIDs return `400`; missing, invalid, or untrusted IP headers share a conservative unknown-IP quota, including on non-Vercel hosts. See [Vercel's request-header documentation](https://vercel.com/docs/headers/request-headers#x-vercel-forwarded-for) for the forwarding trust boundary.

Advisor input is validated before cache or provider access. Only complete decimal numbers or numeric strings within field-specific bounds are accepted, with exactly three known stages and supported workload scales. Legacy telemetry caps latency totals at 30 days and circuit depths at 100 billion. Versioned resource projections use JavaScript’s safe numeric range to accommodate expanded native-resource RSA estimates. Display names, notes, snapshot labels, unknown metrics, and nested objects are excluded from model input. Remaining text is restricted to fixed vocabularies; bottleneck explanations are sanitized and capped at 100 characters before classification. The prompt encloses the resulting JSON in a `benchmark_telemetry` XML block and instructs the model to treat every value as passive data.

The zero-dependency limiter is **process-local**: quotas survive warm-process/module reuse but are not coordinated across server instances or cold starts. Expired keys are automatically swept, and a 10,000-key cap rejects new identities instead of evicting active quotas. Strict deployment-wide provider budgets require a shared limiter or platform-level controls.

---

## 🚀 Quickstart & Local Development

1. Clone the repository and install the frontend dependencies:

   ```sh
   git clone https://github.com/Mic-Sp/Q-split.git q-split
   cd q-split/frontend
   npm install
   cp .env.example .env.local
   ```

2. Edit `frontend/.env.local`. The engine URL is a server-side runtime setting; database and Gemini credentials are optional:

   ```dotenv
   SIMULATION_API_URL=http://localhost:8000
   ENGINE_SECRET=
   DATABASE_URL=
   DATABASE_URL_UNPOOLED=
   GEMINI_API_KEY=
   ```

   Set `DATABASE_URL` to the Neon connection for persistent history and advisor caching. `DATABASE_URL_UNPOOLED` supplies a direct connection for Prisma migrations and maintenance; it falls back to `DATABASE_URL` when blank. Without database credentials, simulations still work; without a Gemini key, the advisor supplies deterministic local diagnostics.

   Set the same nonempty `ENGINE_SECRET` in the FastAPI process environment and the Next.js server environment (locally, `frontend/.env.local`) to authenticate simulations. The proxy sends it as `X-Engine-Secret`; missing or incorrect credentials receive HTTP 401 before simulation dispatch. Without `ENGINE_ENV=production`, an unset or blank secret keeps local development open. Production requires a nonblank secret and refuses to start without one; see [production deployment](#production-deployment). Engine routes grant no browser CORS access because browsers use the Next.js proxy. Keep the secret out of `NEXT_PUBLIC_*` variables.

   `GET /` is a public, uncached health probe in both development and configured production. It needs no secret, stays available when docs are disabled, performs no simulation, and does not wait for simulation worker threads. Each Next.js Node server startup pings it once with a three-second timeout; engine downtime does not fail frontend startup. A cold engine may still take longer to become ready.

3. In a separate terminal, create the Python environment and start the backend **from the repository root**:

   ```sh
   python3 -m venv backend/venv
   backend/venv/bin/python -m pip install -r backend/requirements.txt
   backend/venv/bin/python -m uvicorn backend.main:app --reload --port 8000
   ```

4. Start the frontend **from `frontend/`**:

   ```sh
   npm run dev
   ```

   Open http://localhost:3000. If database credentials are configured, apply the migrations described below before using persistent history.

5. Run the test suites:

   From the repository root:

   ```sh
   backend/venv/bin/python -m pip install -r backend/requirements-dev.txt
   backend/venv/bin/python -m pytest backend/tests -q
   ```

   From `frontend/`:

   ```sh
   npx tsc --noEmit
   npm test
   ```

   The frontend tests include the 1,620-configuration backend integration matrix and use the Python environment installed above.

## Production deployment

Set these variables in the **FastAPI process environment** before starting the engine:

| Variable | Production behavior |
| --- | --- |
| `ENGINE_ENV=production` | Requires a nonblank `ENGINE_SECRET` during app creation and startup. |
| `ENGINE_SECRET` | Supply through the hosting platform's secret configuration; set the same value on the Next.js server. Missing or whitespace-only values prevent startup. |
| `ENGINE_ENABLE_DOCS` | Leave unset to disable `/docs`, `/docs/oauth2-redirect`, `/redoc`, and `/openapi.json`. Set exactly `1` to expose them; simulation requests still require the secret. |

On Next.js, set `SIMULATION_API_URL` to the engine URL and `ENGINE_SECRET` to the matching value. `ENGINE_ENV` and `ENGINE_ENABLE_DOCS` belong to FastAPI, not the browser. Restart the engine after changing these settings. Local Python development without the production flag keeps optional authentication and docs enabled. If a running production process loses its secret, simulation requests fail closed with HTTP 503.

The backend Dockerfile defaults to `ENGINE_ENV=production`. With `ENGINE_SECRET` supplied in the host environment, build and run it from the repository root:

```sh
docker build -t q-split-engine backend
docker run --rm -p 8000:8000 -e ENGINE_SECRET q-split-engine
```

For an intentionally open local container, pass `-e ENGINE_ENV=development`. Configure platform health checks and Next.js pre-warming to use **`GET /`**. It remains public without `X-Engine-Secret`, independently of authentication and docs visibility. A production process with missing credentials must be configured correctly before it can start serving any routes.

## Run persistence and session API

Next.js owns run/snapshot persistence in Prisma's `SimulationRun` table; the Python
backend only executes simulations. From `frontend`, run `npm run db:generate` and
`npm run db:migrate` to generate the client and deploy the additive migrations.
Existing rows retain `sessionId = NULL` with their telemetry and snapshot metadata intact.

Send the same required `X-Session-Id` header on `GET /api/runs`, `POST /api/runs`,
`PATCH /api/runs/:id`, `DELETE /api/runs/:id`, and `POST /api/advisor` (or
`/api/analyze-telemetry`). Tokens must be canonical hyphenated RFC 4122 UUID v4
values with a valid variant, normalized to lowercase by the server. Missing or
malformed tokens return `400` before payload parsing or database access.
This is session isolation, not account authentication. The frontend automatically
creates the token before its first history request, stores it under
`q-split:session-id` in browser `sessionStorage`, and attaches it to every history,
save, snapshot, deletion, and Advisor request. Reloads retain the workspace; a fresh
tab session gets a new one. If storage is blocked, all requests share an in-memory
token for that page lifetime. Comparisons and exports use this session's loaded
history. Invalid legacy browser tokens are replaced with a fresh UUID v4. No sign-in
or session controls are required.

- Creates assign the header's session; payload fields cannot override ownership.
- Each save atomically retains at most 20 unpinned runs per session across all
  workloads. FIFO uses server creation time
  (UUID breaks ties); retries preserve that time. Named or pinned snapshots never
  count toward the cap and are never pruned. Write conflicts retry the transaction.
- Lists (including pinned snapshots and workload filters) and mutations use that
  exact session. Missing headers cannot access legacy `NULL` rows; those rows remain
  unchanged and subject to the existing TTL policy.
- Malformed headers return `400`. A foreign/missing snapshot update returns `404`;
  deletes remain idempotent `200` without affecting foreign rows. Reusing another
  session's run UUID on POST returns `409` without returning its contents.
- `AdvisorCache` is global and has no session or run foreign key. Only the Advisor
  server populates it. Matching normalized configuration, telemetry, comparison
  context, model, and policy reuse diagnostics across run/session IDs, including
  after source-run deletion. Responses bind IDs and history writes to the caller;
  cache hits retain original usage but charge zero new tokens/cost.

## Database TTL maintenance

The session FIFO cap is complemented by a 48-hour TTL on unpinned, unnamed runs.
The cleanup uses database time and `createdAt`, across every session ID (including
legacy `NULL` rows). It expires runs rather than measuring a session's last activity:
a run older than 48 hours qualifies even if its browser session is still active.
Runs exactly 48 hours old remain until a later cleanup. A snapshot name or pin
independently protects a run, and the permanent `AdvisorCache` is untouched.

The Prisma migration adds `SimulationRun_unpinned_createdAt_idx` on
`(isSnapshot, snapshotName, createdAt)`, matching the two protection filters and
the time-range lookup. Apply the migration and run maintenance from `frontend`:

```sh
npm run db:migrate
npm run db:cleanup
```

`db:cleanup` executes [purge-expired-runs.sql](frontend/prisma/maintenance/purge-expired-runs.sql)
using `prisma.config.ts`, which loads `.env.local` and prefers
`DATABASE_URL_UNPOOLED` over `DATABASE_URL`. For manual execution in the Neon SQL
Editor, select the intended database/branch and run that file's SQL directly.

Cleanup runs only when invoked; installing the index does not enable a scheduler.
For hourly maintenance, add this entry to your deployment host's crontab, replacing
the project path and ensuring Node/npm are available in cron's `PATH`:

```cron
0 * * * * cd /path/to/q-split/frontend && npm run db:cleanup
```

Provide the database environment on that host or use its local `.env.local`;
keep credentials out of the crontab. An external scheduled runner can execute the
same command. Hourly scheduling means eligible rows are removed on the next run.

To verify the SQL against PostgreSQL without changing application data, run
`npm run db:test:ttl`. It exercises the actual cleanup script with temporary tables
in a rolled-back transaction, covering expired runs in multiple sessions, the
48-hour boundary, named/pinned snapshot protection, permanent cache preservation,
and repeated execution.

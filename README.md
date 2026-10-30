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
  2. Analytical Co-Design Profiler: Closed-form models for other tiers and larger scales (Shor N >= 21 through RSA-2048; Quantum-MIPS M >= 1,024 through 1,048,576), tracking statevector RAM limits (`16 × 2^q` bytes for `q` emulated qubits), gate depth, and exponential coherence decay.

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

* Shor's Algorithm (N = 15, 21, 35, RSA-512, RSA-2048): Models factoring pipelines, with CPU preferred for scalar host stages in this calibration. RSA-scale runs project resource requirements; they do not factor real RSA keys. The QPU model accounts for modular-exponentiation depth and coherence limits.
* Quantum-MIPS (Maximum Inner Product Search; LLM Vector Retrieval) (M = 64, 1,024, 32k, 128k, 1M): Models LSH pruning and FP16 reranking, with GPU hosts preferred at M >= 1,024. Grover's search / amplitude amplification uses O(√M) iterations in the reference model. This is not a measured end-to-end vector retrieval speedup.

### Hardware Profiles

* IBM Heron NISQ: 133-qubit r1 reference with Heavy-Hex superconducting connectivity and modeled SWAP routing overhead.
* Google Weber (2D Grid): An exploratory 72-qubit grid preset inspired by square-lattice superconducting hardware. Google's published Weber device has 53 active qubits; 72 is a model capacity, not its physical-device specification.
* IonQ Forte (Trapped Ion): 36-qubit reference with all-to-all connectivity, high gate fidelity, and long coherence. The model removes SWAP routing layers but uses slower laser-driven gate execution; high fidelity does not mean noise-free execution.
* Ideal Noise-Free: Theoretical reference with 100% modeled coherence for feasible execution. Capacity and routing limits still apply.

Profile depth, latency, and coherence factors are comparative modeling assumptions. Available QPU qubits can be overridden independently of the profile's reference capacity; overrides beyond that reference are exploratory.

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
   DATABASE_URL=
   DATABASE_URL_UNPOOLED=
   GEMINI_API_KEY=
   ```

   Set `DATABASE_URL` to the Neon connection for persistent history and advisor caching. `DATABASE_URL_UNPOOLED` supplies a direct connection for Prisma migrations and maintenance; it falls back to `DATABASE_URL` when blank. Without database credentials, simulations still work; without a Gemini key, the advisor supplies deterministic local diagnostics.

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
   backend/venv/bin/python -m unittest discover -s backend/tests -v
   ```

   From `frontend/`:

   ```sh
   npx tsc --noEmit
   npm test
   ```

   The frontend tests include the 1,620-configuration backend integration matrix and use the Python environment installed above.

## Run persistence and session API

Next.js owns run/snapshot persistence in Prisma's `SimulationRun` table; the Python
backend only executes simulations. From `frontend`, run `npm run db:generate` and
`npm run db:migrate` to generate the client and deploy the additive migrations.
Existing rows retain `sessionId = NULL` with their telemetry and snapshot metadata intact.

Send the same optional `X-Session-Id` header on `GET /api/runs`, `POST /api/runs`,
`PATCH /api/runs/:id`, `DELETE /api/runs/:id`, and `POST /api/advisor` (or
`/api/analyze-telemetry`). Tokens are case-sensitive, contain 1–128 ASCII letters,
digits, underscores, or hyphens, and should be unpredictable client-generated UUIDs.
This is session isolation, not account authentication. The frontend automatically
creates the token before its first history request, stores it under
`q-split:session-id` in browser `sessionStorage`, and attaches it to every history,
save, snapshot, deletion, and Advisor request. Reloads retain the workspace; a fresh
tab session gets a new one. If storage is blocked, all requests share an in-memory
token for that page lifetime. Comparisons and exports use this session's loaded
history. No sign-in or session controls are required.

- Creates assign the header's session; payload fields cannot override ownership.
- Each save atomically retains at most 20 unpinned runs per session across all
  workloads, including the legacy `NULL` bucket. FIFO uses server creation time
  (UUID breaks ties); retries preserve that time. Named or pinned snapshots never
  count toward the cap and are never pruned. Write conflicts retry the transaction.
- Lists (including pinned snapshots and workload filters) and mutations use that
  exact session. Missing headers select only the legacy `NULL` bucket.
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

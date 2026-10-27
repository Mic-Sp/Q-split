Q-Split is a Next.js dashboard for the hybrid quantum-classical FastAPI profiler.

## Getting Started

The application always uses a dark slate theme, configured in
`src/app/globals.css` with the `dark` class set in the root layout.

### Backend URL

Set the API URL in `frontend/.env.local`:

```dotenv
NEXT_PUBLIC_API_URL=https://q-split-engine.onrender.com
```

For local backend testing, use `NEXT_PUBLIC_API_URL=http://localhost:8000`
instead. Import `API_BASE_URL` from `@/lib/config` for API requests; it defaults
to `http://localhost:8000` when the variable is missing or empty. The fallback
applies to configuration, not failed network requests.

Restart the development server after changing `.env.local`. Production builds
must be rebuilt to pick up changes to `NEXT_PUBLIC_API_URL`.

### Development server

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

### Dashboard behavior

The dashboard at `src/app/page.tsx` starts idle with the Shor's N = 15 configuration
selected. Only clicking Run simulation (or an explicit retry action) posts to
`/api/simulate`. Changing the workload, target scale, hardware profile, QPU capacity, or stage
nodes only edits the configuration. Each request captures the configuration at
the time of the click, so edits during a run do not submit or change that request.
Previous results are labeled when they differ from the selected configuration.
Failed requests retain the last successful result with an error notice and retry action.

Loading feedback appears immediately. After 10 seconds, a cold-start notice
offers Try again; requests time out after 90 seconds with a Retry button. Retrying
cancels the previous request. Network failures do not automatically switch to a
local backend; select the local URL using the environment configuration above.

Each pipeline card has CPU/GPU/QPU node-assignment pills. The default route is
CPU → QPU → CPU; each stage can be assigned independently. Every request includes
the full `routing` object (`stage_1_node`, `stage_2_node`, `stage_3_node`). Selection
changes, processor icons, and processor labels appear immediately. Latency, status,
and metrics update only after manually running a simulation and receiving its
response. Previous results remain labeled during updates or errors.

The local backend URL is selected in `.env.local` (normally
`http://localhost:8000`). The Render deployment must include the current
`RoutingConfig` and `available_qubits` contract. A response that ignores node
assignments or QPU capacity produces an error instead of displaying misleading
telemetry.

Green indicates optimal,
amber indicates a warning, and rose indicates a critical bottleneck. The delta
tracker compares consecutive successful responses, retaining six transitions in
memory until the page reloads. Node changes are included alongside metrics.
Failed and canceled requests do not enter history.

N = 15 in sequential mode executes an eight-qubit circuit using Qiskit Aer on a
classical simulator. Parallel tiers and larger scales use analytical projections.
Stage timings and coherence values are estimates,
not physical QPU measurements. Quantum-MIPS currently returns HTTP 501 from the
backend and displays an availability message.

API contracts are in `src/types/telemetry.ts`. The request helper, response
validation, and delta comparison are in `src/lib/telemetry.ts`.

Run `npm run lint` and `npm run build` to check the frontend.

### QPU capacity and parallelization

Requests accept `available_qubits`, a positive integer defaulting to 133. Presets
are 16, 133, 1121, 2048, 4096, and 16384; a numeric input and threshold shortcuts
allow exact boundary experiments. The 133 and 1121 labels reference the
[Heron r1 and Condor milestones](https://www.ibm.com/quantum/blog/quantum-roadmap-2033);
larger values are exploratory capacities. The profiler models usable logical
qubits, excluding physical error-correction overhead and device connectivity.
Capacity is independent of the selected noise profile and is reused per stage.

Here `n` is the modulus bit length; RSA-512/RSA-2048 use 512/2048 bits directly.

| Available capacity | Allocated qubits | Tier | Modeled circuit depth |
| --- | --- | --- | --- |
| Below `2n + 3` (8 for N = 15) | 0 | Blocked | 0, no execution |
| Minimum through `< 3n` | Minimum | Space-Optimized Sequential | `floor(4.5 n³)` |
| `3n` through `< ceil(5.5n)` | `3n` | Windowed Parallel | `ceil(4.5 n² log₂ n)` |
| `ceil(5.5n)` or more | `ceil(5.5n)` | Carry-Lookahead Parallel | `ceil(4.5 n log₂² n)` |

The N = 15 sequential circuit uses its actual compiled depth rather than the
cubic analytical formula. NISQ coherence uses `100 exp(-depth / 1200)` across
tiers; ideal coherence is 100%. Analytical QPU time uses 0.00025 ms per depth
layer. These coefficients are illustrative assumptions, not hardware benchmarks.
Additional qubits beyond the last threshold remain idle and do not change depth
or latency. Stage telemetry exposes `available_qubits`, `qubits_allocated`,
`minimum_qubits_required`, `idle_qubits`, `parallelization_tier`,
`depth_complexity`, and `parallel_speedup_ceiling_reached` alongside depth and
coherence. The UI shows allocation / capacity and the active tier together.
Tier threshold buttons show formula, depth, architectural trade-offs, and math
for the selected scale on hover, keyboard focus, or touch. Tooltips escape
container clipping, support Escape/outside-tap dismissal, and allow arrow/Page
keys to scroll long content while retaining focus on the threshold button.

Insufficient capacity returns normal HTTP 200 telemetry with critical status and
`INSUFFICIENT QPU QUBIT CAPACITY`, zero QPU latency, and blocked downstream stages.
Every QPU-assigned stage checks capacity; classical pre/post routines still have
no QPU implementation even when capacity is sufficient. CPU/GPU kernel emulation
retains its existing memory limits and is unaffected by QPU capacity.

Run history preserves capacity in request JSON and all allocation/tier metrics
in telemetry JSON, including blocked runs. Existing history remains readable;
this addition requires no database schema migration.

The top-level coherence KPI compares QPU survival with the 100% deterministic
classical baseline; CPU/GPU kernel emulation displays that baseline explicitly.
Its budget badge is NOMINAL at 70% or above, DEGRADED from 35% to below 70%, and
EXCEEDED below 35% or when a QPU route is blocked. The latency KPI separates
active compute from interconnect/state-preparation overhead. GPU timings already
include launch/transfer costs, so those are separated once; QPU I/O is reported
separately and added to the KPI total. Blocked stages contribute neither compute
nor overhead. Original stage telemetry and saved stage-sum latencies are unchanged.
Alongside the KPI cards in the compact telemetry summary, the latency proportion bar splits the same total
into classical CPU/GPU compute, QPU gate execution, and interconnect/control
overhead. Its legend reports milliseconds and actual percentage shares; nonzero
segments have an 8px minimum width for visibility. Empty or fully blocked runs
show an unfilled track, and routing edits retain the last completed result until
the next simulation succeeds. All durations remain illustrative model estimates.

The **Co-Design Offload Verdict** strip derives a short status locally from that
same completed snapshot, with no AI call, timer, or extra network request.
Capacity and unsupported-route blockers take priority, followed by classical
statevector RAM limits, other execution blockers, QPU coherence below 35%, and
interconnect overhead above 40% of the modeled wall-clock total. Capacity verdicts
report the exact usable-register deficit. CPU/GPU deterministic coherence never
triggers a QPU decoherence verdict.

The backend includes a `classical_cpu_baseline` object in the kernel metrics,
using the existing all-CPU sequential statevector timing and RAM model. It adds no
Aer execution and does not change stage timings. A **Quantum Advantage Window**
requires QPU survival of at least 70%, plus at least 2× modeled kernel and full
pipeline speedup over that feasible CPU reference, including offload I/O.
Ideal-profile verdicts identify the noise-free projection explicitly. A RAM-blocked
CPU reference has null timings; the strip never treats those as a speedup. Older
backends/history without reference metrics display a comparison-needed verdict.
High overhead alone does not prove a CPU speed advantage: the strip says CPU is
faster only when the reference timing supports that conclusion. Changing controls
retains the completed-run verdict until the next successful simulation, alongside
the existing latency bar and KPI cards.

### Persistent Run History (Neon + Prisma)

The desktop dashboard keeps the control panel, compact KPI/status/verdict/latency
summary, and three execution stage cards together above the analytics. Both Run
simulation buttons submit the same selected configuration; the inline pipeline
button shows uncommitted changes and shares loading/capacity validation with the
top button. Capacity/model explanations and the complete co-design verdict remain
available in keyboard-, pointer-, and touch-accessible info tooltips. The advisor
and state delta tracker share a desktop row and stack on mobile; long delta tables
scroll within their panel. Stage and advisor telemetry retain their original data.

The Benchmark Comparison Table shows the latest five saved runs by default.
**Show all 20 runs** expands the fetched recent list; **Named Snapshots Only**
includes pinned benchmarks even after they age out of the twenty recent runs.
The table compares captured routes, hardware, qubits/tier, compute versus I/O,
wall-clock latency, coherence budget, and primary bottleneck using the same
metrics as the live KPI cards. **Details** opens the complete payload, saved
advisor diagnostic, original token usage, and zero-cost cached view.

Check up to three rows to open a side-by-side comparison matrix above the table.
The first selected run is the reference; subsequent columns show absolute timing,
qubit, gate-count, and coherence percentage-point deltas. Selection order is
preserved across filters and Show latest 5/Show all; remove a column or use
**Clear selection** to release slots. Deleted runs leave the comparison, and
the next selected run becomes the reference if needed.

**Export CSV** and **Export JSON** download selected runs, including selections
hidden by a filter or collapsed list. Without selections they download exactly
the currently displayed rows. Exports run locally from loaded history, so they
remain available offline. CSV includes flattened system metrics, coherence
budget, bottleneck, run UUID, and all saved AI diagnostic sections, with UTC
timestamps, quoted multiline fields, and a UTF-8 BOM. Formula-like text fields
receive a leading apostrophe for spreadsheet safety. JSON preserves the complete
saved records, structured requests/telemetry, snapshot metadata, and advisor
usage; circuit depths retain their serialized decimal strings. No schema change
or new database request is required for comparison or export.

After a simulation completes, enter a label beside the pipeline Run button and
choose **Capture Benchmark Snapshot**. This names and pins that completed run;
unsaved edits to the controls do not alter its captured configuration. Existing
rows also offer **Name snapshot** or **Rename**. Names are trimmed, limited to
120 characters, and stored as plain text. **Restore to Simulator** restores the
exact workload, scale, hardware profile, QPU capacity, and three stage routes;
press Run simulation to execute them. The currently completed telemetry remains
visible until then. **Delete** permanently removes the selected database row.
Failed naming or deletion requests retain the label or row for retry; restores
remain usable from already loaded history while offline.

Successful simulations are saved by a separate background request to the Next.js
server. A failed save never changes the simulation result or disables Run
simulation. Saved history loads on page open; this does not start a simulation.
Expand a saved run to review its configuration, summary, and complete JSON telemetry.

Configure these **server-only** values in `frontend/.env.local` (never use a
`NEXT_PUBLIC_` prefix for database credentials):

```dotenv
# Pooled application connection from Neon Console → Connect
DATABASE_URL="postgresql://USER:PASSWORD@YOUR_ENDPOINT-pooler.REGION.aws.neon.tech/neondb?sslmode=require"
# Direct connection for schema migrations
DATABASE_URL_UNPOOLED="postgresql://USER:PASSWORD@YOUR_ENDPOINT.REGION.aws.neon.tech/neondb?sslmode=require"
```

Prisma CLI uses `prisma.config.ts` to load the same `.env.local` file as Next.js.
Client generation and builds work without connection strings. The app lazily
creates a server-only Prisma client with bounded connection/query timeouts.

The schema is in `prisma/schema.prisma`. The initial migration and the additive
`20261027000000_benchmark_snapshots` migration have been applied to the configured
Neon database. The snapshot migration adds a nullable name, a default-false pin
flag, a metadata update timestamp, and a pin/date index, preserving existing
records and advisor insights. For a new environment, confirm the
target connection strings, then apply the reviewed migrations from `frontend/`
with:

```bash
npm run db:migrate
```

Restart Next.js after configuring the URLs. Deployments also need these
environment variables set on their server. `DATABASE_URL_UNPOOLED` takes
precedence for Prisma CLI commands, with `DATABASE_URL` as a fallback.

The database stores timestamps, workload/scale/hardware, all three stage targets,
execution mode, total latency, bottleneck severity and description, qubits, circuit
depth, coherence, normalized request JSON, and the complete telemetry JSONB.
Large circuit depths use PostgreSQL BIGINT and serialize as decimal strings.
Each execution gets a unique UUID; retrying its save uses the same UUID to avoid
duplicates. Re-running a simulation creates a separate history record.

- `GET /api/runs?limit=20` returns the newest runs (limit 1–50, no caching) plus
  a separate `snapshots` list of all pinned benchmarks.
- `POST /api/runs` accepts `{ id, completedAt, request, telemetry }`, validates it,
  derives summary metrics on the server, and performs an idempotent save.
  An optional `advisorInsight` updates only that run's saved diagnostic; ordinary
  save retries do not erase an existing insight or snapshot label.
- `PATCH /api/runs/[id]` accepts `{ snapshotName: "My benchmark" }` to name and
  pin a run. `{ snapshotName: null }` or `{ isSnapshot: false }` clears its name
  and pin. Only snapshot metadata is mutable; captured inputs and telemetry are
  immutable. `snapshotUpdatedAt` prevents stale save responses from erasing names.
- `DELETE /api/runs/[id]` removes one run; repeating the deletion is safe.
  The client waits for outstanding saves and ignores late advisor saves for a
  locally deleted run so background work cannot recreate it in that tab.
- Missing configuration returns an `unconfigured` notice. An unavailable database
  or missing table returns a sanitized `unavailable` response; no driver error or
  credentials are exposed to the browser.
- Failed saves stay queued in the current tab. Retry saving resubmits that queue;
  unsaved runs are lost if the tab closes or reloads. The history section displays
  database records only, rather than presenting unsaved runs as persisted.
- Saved history belongs to this app's database; no per-user account scope exists.

### AI Telemetry Advisor

Set server-only values in `.env.local` and your deployment environment:

```dotenv
GEMINI_API_KEY="YOUR_API_KEY"
# Optional override; the default is a current, low-latency Flash model.
GEMINI_MODEL="gemini-3.5-flash-lite"
```

The advisor is on demand: run a simulation, then click **Generate analysis**.
Editing controls, loading history, and running simulations never call Gemini.
Analysis uses the completed run's captured settings. With two completed runs,
the optional comparison includes the previous run, even when several settings
changed. A new successful simulation resets the panel and stops displaying stale
analysis. An already-started shared server generation can finish within its
deadline and save its result even if one browser caller navigates away.

`POST /api/advisor` accepts `{ current: CompletedRun, previous?: CompletedRun }`;
a completed run contains `{ id, completedAt, request, telemetry }`. A dedicated
pre-flight validator checks both runs before any database lookup or AI call.
Invalid payloads return HTTP 400. Supported scales are
15, 21, 35, 512, and 2048. Routing/profile/workload/status/tier values must match
known enums; capacity is an integer from 1 to 2,147,483,647, matching FastAPI.
Latencies must be finite and nonnegative, qubit/depth metrics must be bounded
integers, and coherence must be in 0–100%. Stage nodes must match routing and
QPU capacity must match the request. Omitted routing/capacity use CPU/QPU/CPU
and 133; extra stage positions are rejected.

The body reader enforces a **64 KiB UTF-8 byte limit**, including streamed bodies
and requests with absent or misleading Content-Length headers. Oversized bodies
return HTTP 413 and stop reading immediately; invalid UTF-8/JSON returns 400.
Tokens are Unicode-normalized, stripped of control/format characters, trimmed,
and checked against allowlists. Display fields and arbitrary metadata are never
forwarded to Gemini. The prompt contains only normalized active configuration,
execution mode, canonical bottleneck category, total/stage latencies, allowlisted
numeric/boolean metrics and tier enums, plus the server's local recommendation.
Run IDs, timestamps, labels, stage descriptions, nested metric objects, and
previous AI output are excluded. Reordered or verbose equivalent input produces
the same prompt digest. These checks also protect deterministic fallback text.

The API key stays in a server-side request header;
it is never sent to the browser or stored with history. The integration uses
Google's [generateContent API](https://ai.google.dev/api/generate-content), system
instructions for a Principal Quantum-Classical Systems Architect, and a JSON
response schema. No additional SDK is required.

Generation is capped at 1,024 output tokens with temperature 0.1, one candidate,
and an 18-second deadline covering generation and response reading. The JSON
schema permits exactly the three diagnostic keys. A separate live-output gate
requires 20–900 characters and 1–4 sentences per section, handles decimal values
without treating their decimal points as sentence boundaries, and normalizes
whitespace/Unicode before checking known unsupported hardware claims. It rejects
calibration, error-correction buffers, other unmodeled hardware actions, and
claims of actual physical-device execution; explicit model limitations remain
valid. Unexpected fields, malformed/truncated JSON, and rejected claims trigger
the local fallback. The gate is separate from legacy history parsing so stricter
generation limits do not make existing saved runs unreadable.

The response is `{ insight }` with `runId`, optional comparison ID, source/model,
timestamp, fallback reason/notice, and three validated text sections:
`routingDiagnosis`, `spaceTimeTradeOff`, and `optimizationRecommendation`.
Sections cover hardware limits, stage placement, ancilla/depth tiers, and one
specific next experiment. Prompts distinguish analytical timings and modeled
usable qubits from physical hardware measurements/error-correction requirements.

Missing keys, provider HTTP 429, timeouts, network errors, or invalid/truncated
output return a clearly labeled deterministic local diagnostic with the same
sections. Gemini calls time out after 18 seconds; the browser also handles an
unreachable advisor endpoint. Fallbacks remain usable and can be saved. Analysis
never blocks the simulator. Raw provider errors and secrets are not exposed.
Response metadata distinguishes `source: "gemini"`, `source: "cached"`, and
`source: "fallback"`, displayed as **Live AI**, **Cached DB Hit**, and **Deterministic Fallback**;
fallbacks use `model: null`, a specific `fallbackReason` (including
`invalid_response` for failed output validation), and a human-readable `notice`.

Before generation, the endpoint checks the current run's `advisorInsight` in
Neon via Prisma. Its SHA-256 `cacheKey` covers the run ID, compact numeric digest,
previous run ID/digest or no comparison, model, system prompt, output schema and
generation constraints. Display text and timestamps do not affect cache hits.
A hit must pass metadata and current output validation, match the comparison,
and originate from Gemini; local fallbacks and legacy entries without a matching
fingerprint never block a new AI request. A validated hit returns immediately
as **Cached DB Hit**, even when the Gemini key is unavailable. Only the latest analysis
is stored for each run; changing comparison state replaces it after generation.

Fresh validated Gemini diagnostics are saved on the server to the existing run
before the response returns. Cache reads/writes each have a 1.5-second deadline;
the browser allows 26 seconds for lookup, generation and save. A database outage
does not prevent analysis. Response `persistence.status` reports `saved`,
`pending`, `unconfigured`, or `unavailable`, with sanitized notices. If the
original simulation record is still being saved or a server write fails, the
existing background queue attaches the diagnostic to the original full telemetry
under the same UUID. Successful server writes refresh history without a duplicate
save POST. Delayed run-save responses cannot erase newer insights in the UI.

The frontend uses a synchronous in-flight guard as well as a disabled loading
button. Concurrent identical endpoint requests share one generation within a
server process. The shared response keeps its actual source, is marked
`telemetry.shared: true`, and reports no additional API tokens or cost. Completed results live
in Neon; no unbounded in-memory result cache is kept. This coalescing is process
local, not a distributed lock: simultaneous cold misses on separate server
instances can still generate independently. Persistent cache hits work across
instances once saved.

The existing nullable JSONB column was added by migration
`20261026010000_advisor_insights` and applied to the configured Neon database.
This cache adds no schema migration. Saved diagnostics appear automatically
inside expanded history rows after a reload, with Cached DB Hit or Deterministic Fallback
badges and no generation request. If the database is unavailable,
the insight stays visible in this tab and **Retry saving** retries without
another Gemini call. Unsaved insights are lost on reload, like unsaved runs.

The compact **AI Inference Telemetry & Unit Economics** strip shows execution
source, current API input/output/total tokens, estimated USD cost to six decimal
places, and lookup latency. `insight.usage` holds the original generation counts
and cost; `insight.telemetry` holds the current lookup's counts, cost, savings,
latency in milliseconds, and shared-response flag. Both survive JSONB persistence
and history serialization without a schema migration. Cache hits preserve
`usage` while reporting zero new API tokens, `$0.000000 (Cache Saved)`, and the
original estimated cost saved. Historical views also show original token counts;
their lookup latency is unavailable rather than reusing an old inference duration.

Live counts come from Gemini `usageMetadata` (`promptTokenCount`,
`candidatesTokenCount`, and `totalTokenCount`); generated thinking tokens are
included in output usage when present. Missing counts use a labeled estimate of
one token per four characters, including system and user text for input.
Estimated cost uses the configured accounting rates of **$0.15 per million input
tokens** and **$0.60 per million output tokens**; these fixed rates also apply to
model overrides. Fallback responses report zero API tokens and zero cost.
Lookup latency covers request validation, database read, and generation up to the
available diagnostic, excluding the following database write. Older saved
diagnostics remain readable with unavailable original token metrics.

Checks that do **not** apply database migrations:

```bash
npm run db:generate
npm run db:validate
npm test
npm run typecheck
npm run build
```

The tests cover record validation/serialization, summaries, large integer values,
default and mismatched routing, history API responses, idempotent save contracts,
and database failure handling using an in-process repository double, not Neon.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

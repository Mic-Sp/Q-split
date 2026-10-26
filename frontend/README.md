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

### Persistent Run History (Neon + Prisma)

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

The schema is in `prisma/schema.prisma`. The initial migration is in
`prisma/migrations/20261026000000_simulation_runs/migration.sql` and has been
applied to the configured Neon database. For a new environment, confirm the
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

- `GET /api/runs?limit=20` returns the newest runs (limit 1–50, no caching).
- `POST /api/runs` accepts `{ id, completedAt, request, telemetry }`, validates it,
  derives summary metrics on the server, and performs an idempotent save.
- Missing configuration returns an `unconfigured` notice. An unavailable database
  or missing table returns a sanitized `unavailable` response; no driver error or
  credentials are exposed to the browser.
- Failed saves stay queued in the current tab. Retry saving resubmits that queue;
  unsaved runs are lost if the tab closes or reloads. The history section displays
  database records only, rather than presenting unsaved runs as persisted.
- Saved history belongs to this app's database; no per-user account scope exists.

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

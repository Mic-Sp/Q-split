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
`/api/simulate`. Changing the workload, target scale, hardware profile, or stage
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

The updated local backend runs on `http://127.0.0.1:8001`, configured in
`.env.local`. The Render deployment must include `RoutingConfig` before it can
handle custom routes. A response that ignores the requested node assignments
produces an error rather than displaying a successful custom simulation.

Green indicates optimal,
amber indicates a warning, and rose indicates a critical bottleneck. The delta
tracker compares consecutive successful responses, retaining six transitions in
memory until the page reloads. Node changes are included alongside metrics.
Failed and canceled requests do not enter history.

N = 15 executes a circuit using Qiskit Aer on a classical simulator. Larger scales
use analytical projections. Stage timings and coherence values are estimates,
not physical QPU measurements. Quantum-MIPS currently returns HTTP 501 from the
backend and displays an availability message.

API contracts are in `src/types/telemetry.ts`. The request helper, response
validation, and delta comparison are in `src/lib/telemetry.ts`.

Run `npm run lint` and `npm run build` to check the frontend.

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

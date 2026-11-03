[Back to README](../README.md)

# Persistence and sessions

This document collects the existing saved-run interface, optional database setup, session API, and TTL maintenance instructions.

## Interface and saved runs

* Themes: Use the header's Sun/Moon button to switch light and dark modes, or the monitor button to follow the system preference. System mode is the default; your theme choice persists across browser reloads.
* Quick history filters: **All Runs**, **Nominal Only**, and **Pinned Only** show matching counts for the active workload's loaded runs. Filtering happens in memory, without additional API calls or database queries. Nominal matches the `NOMINAL` coherence budget status; pinned includes pinned or named snapshots. The table initially displays the latest five matching rows; **Show all** expands the loaded matches.
* Restore and export: **Restore to Simulator** loads a saved run from the active browser session into the controls; click **Run simulation** to execute it. Select up to three runs for comparison. CSV/JSON export uses selected runs, including hidden selections, or the displayed rows when nothing is selected.
* Retention: History retains at most 20 unpinned, unnamed runs per session across workloads. Named or pinned snapshots are protected. See the persistence and TTL sections below for the 48-hour cleanup policy.

## Optional database setup

   Set `DATABASE_URL` to the Neon connection for persistent history and advisor caching. `DATABASE_URL_UNPOOLED` supplies a direct connection for Prisma migrations and maintenance; it falls back to `DATABASE_URL` when blank. Without database credentials, simulations still work; without a Gemini key, the advisor supplies deterministic local diagnostics.

   Open http://localhost:3000. If database credentials are configured, apply the migrations described below before using persistent history.

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

`db:cleanup` executes [purge-expired-runs.sql](../frontend/prisma/maintenance/purge-expired-runs.sql)
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

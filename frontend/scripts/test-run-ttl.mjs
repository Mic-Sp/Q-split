import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Exercise the actual maintenance SQL against PostgreSQL, using only temporary
// tables and a rolled-back transaction. pg_temp excludes application tables from
// unqualified name resolution; the real run/cache tables are never modified.
const cleanup = readFileSync(new URL("../prisma/maintenance/purge-expired-runs.sql", import.meta.url), "utf8");
const assertions = `
DO $$
BEGIN
  IF (SELECT array_agg("id" ORDER BY "id") FROM "SimulationRun") IS DISTINCT FROM
      ARRAY['boundary', 'empty-name', 'fresh', 'named', 'named-and-pinned', 'pinned', 'recent']::text[] THEN
    RAISE EXCEPTION 'TTL cleanup deleted a protected/recent run or retained an expired run';
  END IF;
  IF (SELECT count(*) FROM "AdvisorCache" WHERE "cacheKey" = 'permanent' AND "advisorInsight" = '{"preserve":true}'::jsonb) <> 1 THEN
    RAISE EXCEPTION 'TTL cleanup changed the permanent Advisor cache';
  END IF;
END $$;
`;
const sql = `
BEGIN;
SET LOCAL search_path = pg_temp;
CREATE TEMP TABLE "SimulationRun" (
  "id" TEXT PRIMARY KEY,
  "sessionId" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL,
  "isSnapshot" BOOLEAN NOT NULL DEFAULT false,
  "snapshotName" TEXT
) ON COMMIT DROP;
CREATE TEMP TABLE "AdvisorCache" (
  "cacheKey" TEXT PRIMARY KEY,
  "createdAt" TIMESTAMPTZ NOT NULL,
  "advisorInsight" JSONB NOT NULL
) ON COMMIT DROP;
INSERT INTO "SimulationRun" ("id", "sessionId", "createdAt", "isSnapshot", "snapshotName") VALUES
  ('expired-a', 'session-a', CURRENT_TIMESTAMP - INTERVAL '49 hours', false, NULL),
  ('expired-b', 'session-b', CURRENT_TIMESTAMP - INTERVAL '72 hours', false, NULL),
  ('expired-legacy', NULL, CURRENT_TIMESTAMP - INTERVAL '49 hours', false, NULL),
  ('just-expired', 'session-a', CURRENT_TIMESTAMP - INTERVAL '48 hours 1 second', false, NULL),
  ('boundary', 'session-a', CURRENT_TIMESTAMP - INTERVAL '48 hours', false, NULL),
  ('recent', 'session-b', CURRENT_TIMESTAMP - INTERVAL '47 hours 59 minutes 59 seconds', false, NULL),
  ('fresh', NULL, CURRENT_TIMESTAMP, false, NULL),
  ('pinned', 'session-a', CURRENT_TIMESTAMP - INTERVAL '365 days', true, NULL),
  ('named', 'session-b', CURRENT_TIMESTAMP - INTERVAL '365 days', false, 'Keep this name'),
  ('named-and-pinned', NULL, CURRENT_TIMESTAMP - INTERVAL '365 days', true, 'Legacy baseline'),
  ('empty-name', NULL, CURRENT_TIMESTAMP - INTERVAL '365 days', false, '');
INSERT INTO "AdvisorCache" VALUES ('permanent', CURRENT_TIMESTAMP - INTERVAL '365 days', '{"preserve":true}');
${cleanup}
${assertions}
-- Repeat against the same transaction clock to prove idempotence.
${cleanup}
${assertions}
ROLLBACK;
`;
const result = spawnSync(process.execPath, ["node_modules/prisma/build/index.js", "db", "execute", "--stdin"], {
  cwd: fileURLToPath(new URL("../", import.meta.url)), input: sql, encoding: "utf8", timeout: 30_000,
});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
console.log("TTL SQL regression passed: session/legacy expiry, strict 48-hour boundary, named/pinned protection, permanent cache, and idempotence. All fixtures rolled back.");

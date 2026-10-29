-- Run manually or on a schedule; safe to repeat.
-- All session IDs, including legacy NULLs, share this run-age retention policy.
-- Database time and server creation time define the strict 48-hour cutoff.
-- Named OR pinned snapshots survive. AdvisorCache is permanent and untouched.
DELETE FROM "SimulationRun"
WHERE "isSnapshot" = false
  AND "snapshotName" IS NULL
  AND "createdAt" < CURRENT_TIMESTAMP - INTERVAL '48 hours';

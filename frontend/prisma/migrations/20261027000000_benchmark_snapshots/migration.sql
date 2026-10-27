-- Additive metadata only; existing runs, telemetry and advisor usage stay intact.
ALTER TABLE "SimulationRun"
  ADD COLUMN "snapshotName" VARCHAR(120),
  ADD COLUMN "isSnapshot" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "snapshotUpdatedAt" TIMESTAMPTZ(3);

CREATE INDEX "SimulationRun_isSnapshot_completedAt_idx"
  ON "SimulationRun" ("isSnapshot", "completedAt" DESC);

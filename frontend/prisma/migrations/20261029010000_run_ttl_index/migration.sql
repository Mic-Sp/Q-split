-- Match the cleanup predicate: unpinned AND unnamed, then creation-time cutoff.
CREATE INDEX "SimulationRun_unpinned_createdAt_idx"
  ON "SimulationRun" ("isSnapshot", "snapshotName", "createdAt");

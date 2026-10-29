-- Existing rows remain NULL and accessible to legacy callers without a session.
ALTER TABLE "SimulationRun" ADD COLUMN "sessionId" VARCHAR(128);

CREATE INDEX "SimulationRun_sessionId_completedAt_id_idx"
  ON "SimulationRun" ("sessionId", "completedAt" DESC, "id" DESC);
CREATE INDEX "SimulationRun_sessionId_workloadId_completedAt_idx"
  ON "SimulationRun" ("sessionId", "workloadId", "completedAt" DESC);
CREATE INDEX "SimulationRun_sessionId_isSnapshot_completedAt_idx"
  ON "SimulationRun" ("sessionId", "isSnapshot", "completedAt" DESC);

-- Only the Advisor server writes this global cache. Client-supplied run insights
-- are history metadata, never trusted as shared generation results.
CREATE TABLE "AdvisorCache" (
  "cacheKey" VARCHAR(64) NOT NULL,
  "runId" UUID NOT NULL,
  "advisorInsight" JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AdvisorCache_pkey" PRIMARY KEY ("cacheKey")
);

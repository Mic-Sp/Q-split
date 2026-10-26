-- Optional structured diagnostics; existing telemetry and historical rows stay intact.
ALTER TABLE "SimulationRun" ADD COLUMN "advisorInsight" JSONB;

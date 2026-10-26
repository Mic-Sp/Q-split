-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "StageNode" AS ENUM ('CPU', 'GPU', 'QPU');

-- CreateEnum
CREATE TYPE "StageStatus" AS ENUM ('OPTIMAL', 'WARNING', 'CRITICAL_BOTTLENECK');

-- CreateTable
CREATE TABLE "SimulationRun" (
    "id" UUID NOT NULL,
    "completedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "workloadId" TEXT NOT NULL,
    "workloadName" TEXT NOT NULL,
    "scaleParam" INTEGER NOT NULL,
    "scaleLabel" TEXT NOT NULL,
    "hardwareProfile" TEXT NOT NULL,
    "stage1Node" "StageNode" NOT NULL,
    "stage2Node" "StageNode" NOT NULL,
    "stage3Node" "StageNode" NOT NULL,
    "executionMode" TEXT NOT NULL,
    "totalLatencyMs" DOUBLE PRECISION NOT NULL,
    "bottleneckStatus" "StageStatus" NOT NULL,
    "primaryBottleneck" TEXT NOT NULL,
    "qubitsRequired" INTEGER,
    "circuitDepth" BIGINT,
    "coherenceSurvivalPct" DOUBLE PRECISION,
    "requestPayload" JSONB NOT NULL,
    "telemetry" JSONB NOT NULL,

    CONSTRAINT "SimulationRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SimulationRun_completedAt_id_idx" ON "SimulationRun"("completedAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "SimulationRun_workloadId_completedAt_idx" ON "SimulationRun"("workloadId", "completedAt" DESC);

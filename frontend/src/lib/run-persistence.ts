import type { Prisma, PrismaClient } from "@/generated/prisma/client";

export const MAX_UNPINNED_RUNS_PER_SESSION = 20;
const MAX_TRANSACTION_ATTEMPTS = 3;

/**
 * Save and prune atomically within one session, including the legacy NULL bucket.
 * FIFO uses server creation time, so retries never promote an older run. Both a
 * snapshot flag and a name independently protect a row, including at deletion.
 * Serializable isolation prevents simultaneous saves from exceeding the cap;
 * bounded P2034 retries repeat the whole transaction after a write conflict.
 */
export async function saveRunWithRetention(db: PrismaClient, data: Prisma.SimulationRunCreateInput, sessionId: string | null) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await db.$transaction(async tx => {
        const run = await tx.simulationRun.upsert({
          // A foreign UUID collides on create rather than changing its ownership.
          where: { id: data.id, sessionId }, create: { ...data, sessionId },
          update: data.advisorInsight === undefined ? {} : { advisorInsight: data.advisorInsight },
        });
        const unpinned = { sessionId, isSnapshot: false, snapshotName: null };
        const retained = await tx.simulationRun.findMany({
          where: unpinned, orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: MAX_UNPINNED_RUNS_PER_SESSION, select: { id: true },
        });
        await tx.simulationRun.deleteMany({
          where: { ...unpinned, id: { notIn: retained.map(row => row.id) } },
        });
        return run;
      }, { isolationLevel: "Serializable", maxWait: 2_000, timeout: 5_000 });
    } catch (error) {
      if (attempt >= MAX_TRANSACTION_ATTEMPTS || !error || typeof error !== "object" || !("code" in error) || error.code !== "P2034") throw error;
    }
  }
}

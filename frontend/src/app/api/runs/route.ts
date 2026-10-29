import { DATABASE_NOT_CONFIGURED, databaseNotice, getDatabase, withDatabaseTimeout } from "@/lib/db";
import { createRunRecord, serializeRun } from "@/lib/run-record";
import { WORKLOADS } from "@/lib/workloads";
import { readRunSession } from "@/lib/run-session";

// Next.js uses its default Node.js runtime; Cache Components forbids a runtime override.
const headers = { "Cache-Control": "no-store" };

/**
 * Read newest runs plus older pinned snapshots, optionally within one workload.
 * Validate filters before database access; the shors_factoring history alias maps
 * to canonical shors_crypto. Filtering occurs before the limit so other workloads
 * cannot crowd out the active family's recent window. Responses are never cached.
 */
export async function GET(request: Request) {
  let sessionId: string | null;
  try { sessionId = readRunSession(request); } catch (error) {
    return Response.json({ message: (error as Error).message }, { status: 400, headers });
  }
  const params = new URL(request.url).searchParams;
  const rawLimit = params.get("limit") ?? "20";
  if (!/^\d+$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 50) {
    return Response.json({ message: "Limit must be an integer from 1 to 50." }, { status: 400, headers });
  }
  const requestedWorkload = params.get("workload");
  // The stored Shor ID remains backwards compatible with existing snapshots.
  const workload = requestedWorkload === "shors_factoring" ? "shors_crypto" : requestedWorkload;
  if (workload !== null && !Object.hasOwn(WORKLOADS, workload)) {
    return Response.json({ message: "Workload must be shors_crypto or quantum_mips." }, { status: 400, headers });
  }
  const where = { sessionId, ...(workload === null ? {} : { workloadId: workload }) };
  try {
    const db = getDatabase();
    if (!db) return Response.json({ status: "unconfigured", message: DATABASE_NOT_CONFIGURED, runs: [] }, { headers });
    const [runs, snapshots] = await Promise.all([withDatabaseTimeout(db.simulationRun.findMany({
      where, take: Number(rawLimit), orderBy: [{ completedAt: "desc" }, { id: "desc" }],
    })), withDatabaseTimeout(db.simulationRun.findMany({
      where: { ...where, isSnapshot: true }, orderBy: [{ completedAt: "desc" }, { id: "desc" }],
    }))]);
    return Response.json({ status: "ready", runs: runs.map(serializeRun), snapshots: snapshots.map(serializeRun) }, { headers });
  } catch (error) {
    return Response.json({ status: "unavailable", message: databaseNotice(error), runs: [] }, { status: 503, headers });
  }
}

/**
 * Validate and idempotently persist one completed run under its stable UUID.
 * Bound payloads to 1 MiB, derive summaries server-side, and preserve immutable
 * configuration/telemetry and existing snapshot metadata on retries. Optional
 * validated advisor output updates only its diagnostic field; DB outages are sanitized.
 */
export async function POST(request: Request) {
  let data: ReturnType<typeof createRunRecord>;
  let sessionId: string | null;
  try {
    sessionId = readRunSession(request);
    if (Number(request.headers.get("content-length")) > 1_048_576) {
      return Response.json({ message: "Telemetry payload exceeds 1 MiB." }, { status: 413, headers });
    }
    const body = await request.text();
    if (new TextEncoder().encode(body).length > 1_048_576) {
      return Response.json({ message: "Telemetry payload exceeds 1 MiB." }, { status: 413, headers });
    }
    data = { ...createRunRecord(JSON.parse(body)), sessionId };
  } catch (error) {
    return Response.json({ message: error instanceof Error ? error.message : "Invalid completed simulation payload." }, { status: 400, headers });
  }
  try {
    const db = getDatabase();
    if (!db) return Response.json({ status: "unconfigured", message: DATABASE_NOT_CONFIGURED }, { headers });
    const run = await withDatabaseTimeout(db.simulationRun.upsert({
      // The ownership predicate is part of the write, including retries. A UUID
      // belonging to another bucket collides on create instead of being updated.
      where: { id: data.id, sessionId }, create: data, update: data.advisorInsight === undefined ? {} : { advisorInsight: data.advisorInsight },
    }));
    return Response.json({ status: "saved", run: serializeRun(run) }, { status: 201, headers });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "P2002") {
      return Response.json({ status: "conflict", message: "This run ID is unavailable. Save with a new run UUID." }, { status: 409, headers });
    }
    return Response.json({ status: "unavailable", message: databaseNotice(error) }, { status: 503, headers });
  }
}

import { DATABASE_NOT_CONFIGURED, databaseNotice, getDatabase, withDatabaseTimeout } from "@/lib/db";
import { serializeRun } from "@/lib/run-record";
import { snapshotPatch, validRunId } from "@/lib/benchmark-snapshot";
import { readRunSession } from "@/lib/run-session";

const headers = { "Cache-Control": "no-store" };
type Context = { params: Promise<{ id: string }> };

/**
 * Validate a UUID and <=2 KiB snapshot metadata mutation before database writes.
 * Only naming/pin state and its update timestamp change; request and telemetry
 * remain immutable. Return 404 for a missing row and sanitized availability states.
 */
export async function PATCH(request: Request, { params }: Context) {
  const { id } = await params;
  if (!validRunId(id)) return Response.json({ message: "Provide a valid run UUID." }, { status: 400, headers });
  let metadata: ReturnType<typeof snapshotPatch>;
  let sessionId: string | null;
  try {
    sessionId = readRunSession(request);
    if (Number(request.headers.get("content-length")) > 2048) return Response.json({ message: "Snapshot metadata exceeds 2 KiB." }, { status: 413, headers });
    const body = await request.text();
    if (new TextEncoder().encode(body).length > 2048) return Response.json({ message: "Snapshot metadata exceeds 2 KiB." }, { status: 413, headers });
    metadata = snapshotPatch(JSON.parse(body));
  } catch (error) {
    return Response.json({ message: error instanceof SyntaxError ? "Provide valid JSON snapshot metadata." : error instanceof Error ? error.message : "Invalid snapshot metadata." }, { status: 400, headers });
  }
  try {
    const db = getDatabase();
    if (!db) return Response.json({ status: "unconfigured", message: DATABASE_NOT_CONFIGURED }, { headers });
    const run = await withDatabaseTimeout(db.simulationRun.update({ where: { id, sessionId }, data: { ...metadata, snapshotUpdatedAt: new Date() } }));
    return Response.json({ status: "saved", run: serializeRun(run) }, { headers });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "P2025") return Response.json({ status: "not_found", message: "This run no longer exists. Refresh history to update the table." }, { status: 404, headers });
    return Response.json({ status: "unavailable", message: databaseNotice(error) }, { status: 503, headers });
  }
}

/**
 * Delete one UUID idempotently, treating an already-absent row as a successful retry.
 * No bulk deletion or telemetry mutation is exposed; connection errors remain sanitized.
 */
export async function DELETE(request: Request, { params }: Context) {
  const { id } = await params;
  if (!validRunId(id)) return Response.json({ message: "Provide a valid run UUID." }, { status: 400, headers });
  let sessionId: string | null;
  try { sessionId = readRunSession(request); } catch (error) {
    return Response.json({ message: (error as Error).message }, { status: 400, headers });
  }
  try {
    const db = getDatabase();
    if (!db) return Response.json({ status: "unconfigured", message: DATABASE_NOT_CONFIGURED }, { headers });
    // An already-deleted ID is a successful retry after a lost response.
    await withDatabaseTimeout(db.simulationRun.deleteMany({ where: { id, sessionId } }));
    return Response.json({ status: "deleted", id }, { headers });
  } catch (error) {
    return Response.json({ status: "unavailable", message: databaseNotice(error) }, { status: 503, headers });
  }
}

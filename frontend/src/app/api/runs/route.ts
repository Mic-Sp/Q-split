import { DATABASE_NOT_CONFIGURED, databaseNotice, getDatabase, withDatabaseTimeout } from "@/lib/db";
import { createRunRecord, serializeRun } from "@/lib/run-record";

// Next.js uses its default Node.js runtime; Cache Components forbids a runtime override.
const headers = { "Cache-Control": "no-store" };

export async function GET(request: Request) {
  const rawLimit = new URL(request.url).searchParams.get("limit") ?? "20";
  if (!/^\d+$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 50) {
    return Response.json({ message: "Limit must be an integer from 1 to 50." }, { status: 400, headers });
  }
  try {
    const db = getDatabase();
    if (!db) return Response.json({ status: "unconfigured", message: DATABASE_NOT_CONFIGURED, runs: [] }, { headers });
    const runs = await withDatabaseTimeout(db.simulationRun.findMany({
      take: Number(rawLimit), orderBy: [{ completedAt: "desc" }, { id: "desc" }],
    }));
    return Response.json({ status: "ready", runs: runs.map(serializeRun) }, { headers });
  } catch (error) {
    return Response.json({ status: "unavailable", message: databaseNotice(error), runs: [] }, { status: 503, headers });
  }
}

export async function POST(request: Request) {
  let data: ReturnType<typeof createRunRecord>;
  try {
    if (Number(request.headers.get("content-length")) > 1_048_576) {
      return Response.json({ message: "Telemetry payload exceeds 1 MiB." }, { status: 413, headers });
    }
    const body = await request.text();
    if (new TextEncoder().encode(body).length > 1_048_576) {
      return Response.json({ message: "Telemetry payload exceeds 1 MiB." }, { status: 413, headers });
    }
    data = createRunRecord(JSON.parse(body));
  } catch (error) {
    return Response.json({ message: error instanceof Error ? error.message : "Invalid completed simulation payload." }, { status: 400, headers });
  }
  try {
    const db = getDatabase();
    if (!db) return Response.json({ status: "unconfigured", message: DATABASE_NOT_CONFIGURED }, { headers });
    const run = await withDatabaseTimeout(db.simulationRun.upsert({
      where: { id: data.id }, create: data, update: {},
    }));
    return Response.json({ status: "saved", run: serializeRun(run) }, { status: 201, headers });
  } catch (error) {
    return Response.json({ status: "unavailable", message: databaseNotice(error) }, { status: 503, headers });
  }
}

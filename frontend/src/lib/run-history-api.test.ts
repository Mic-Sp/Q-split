import assert from "node:assert/strict";
import { test } from "node:test";
import type { Prisma, PrismaClient, SimulationRun } from "@/generated/prisma/client";
import { GET, POST } from "@/app/api/runs/route";
import { deterministicInsight } from "@/lib/advisor";
import type { CompletedRun } from "@/types/run-history";
import { DATABASE_CLIENT_SCHEMA } from "@/lib/db";

const fixture = () => ({
  id: "c367fe2e-f083-4996-8cbd-c895d7a26b8d", completedAt: "2026-10-26T16:00:00.000Z",
  request: { workload_id: "shors_crypto", scale_param: 21, hardware_profile: "ideal_sim" },
  telemetry: {
    workload_id: "shors_crypto", workload_name: "Shor's pipeline", scale_label: "N = 21", execution_mode: "NISQ_ANALYTICAL_PROFILER", primary_bottleneck: "NONE",
    stages: {
      stage_1_classical_pre: { name: "Preprocess", node: "CPU", latency_ms: 0.28, status: "OPTIMAL", output_summary: "Ready", metrics: {} },
      stage_2_quantum_kernel: { name: "Kernel", node: "QPU", latency_ms: 0.14, status: "OPTIMAL", output_summary: "Ready", metrics: { qubits_required: 13, circuit_depth: 562, coherence_survival_pct: 100 } },
      stage_3_classical_post: { name: "Postprocess", node: "CPU", latency_ms: 0.31, status: "OPTIMAL", output_summary: "3 × 7", metrics: {} },
    },
  },
});
const postRequest = (body: unknown) => new Request("http://localhost/api/runs", { method: "POST", body: JSON.stringify(body) });
const cache = globalThis as unknown as { qSplitDatabase?: { url: string; client: PrismaClient; schemaVersion?: string } };

test("history routes handle configuration, validation, saves, ordering, and failures without a live database", async () => {
  const previousUrl = process.env.DATABASE_URL;
  const previousCache = cache.qSplitDatabase;
  try {
    process.env.DATABASE_URL = "";
    let response = await GET(new Request("http://localhost/api/runs?limit=20"));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, "unconfigured");
    response = await POST(postRequest(fixture()));
    assert.equal((await response.json()).status, "unconfigured");
    assert.equal((await GET(new Request("http://localhost/api/runs?limit=999"))).status, 400);
    assert.equal((await POST(postRequest({}))).status, 400);
    assert.equal((await POST(new Request("http://localhost/api/runs", { method: "POST", headers: { "Content-Length": "1048577" }, body: "{}" }))).status, 413);

    // Inject a repository double into the server-only singleton, never Neon.
    const rows = new Map<string, SimulationRun>();
    const fakeUrl = "postgresql://test:test@local-test.invalid/test";
    process.env.DATABASE_URL = fakeUrl;
    let fail: string | null = null;
    cache.qSplitDatabase = {
      url: fakeUrl,
      schemaVersion: DATABASE_CLIENT_SCHEMA,
      client: {
        async $transaction<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>) {
          const before = structuredClone(rows);
          try { return await operation(this as unknown as Prisma.TransactionClient); }
          catch (error) { rows.clear(); before.forEach((row, id) => rows.set(id, row)); throw error; }
        },
        simulationRun: {
          upsert: async ({ where, create, update }: { where: { id: string; sessionId: string | null }; create: SimulationRun; update: Partial<SimulationRun> }) => {
            assert.equal(where.sessionId, null);
            assert.equal(create.sessionId, null);
            if (fail) throw Object.assign(new Error("secret-password must not be returned"), { code: fail });
            const row = rows.has(where.id) ? { ...rows.get(where.id)!, ...update } : { ...create, createdAt: new Date("2026-10-26T16:00:01.000Z"), snapshotName: null, isSnapshot: false };
            rows.set(where.id, row); return row;
          },
          findMany: async ({ take, orderBy, where, select }: { take?: number; orderBy: unknown; where: { sessionId: string | null; isSnapshot?: boolean; snapshotName?: null }; select?: { id: boolean } }) => {
            assert.equal(where.sessionId, null);
            assert.deepEqual(orderBy, [{ [select ? "createdAt" : "completedAt"]: "desc" }, { id: "desc" }]);
            if (fail) throw Object.assign(new Error("secret-password must not be returned"), { code: fail });
            return [...rows.values()].filter(row => (where.isSnapshot === undefined || row.isSnapshot === where.isSnapshot) &&
              (where.snapshotName === undefined || row.snapshotName === where.snapshotName)).sort((a, b) => Number(b.completedAt) - Number(a.completedAt)).slice(0, take);
          },
          deleteMany: async ({ where }: { where: { sessionId: string | null; isSnapshot: boolean; snapshotName: null; id: { notIn: string[] } } }) => {
            let count = 0;
            for (const row of rows.values()) if (row.sessionId === where.sessionId && row.isSnapshot === where.isSnapshot && row.snapshotName === where.snapshotName && !where.id.notIn.includes(row.id)) {
              rows.delete(row.id); count++;
            }
            return { count };
          },
        },
      } as unknown as PrismaClient,
    };
    response = await POST(postRequest(fixture()));
    assert.equal(response.status, 201);
    const saved = await response.json();
    assert.equal(saved.status, "saved"); assert.equal(saved.run.circuitDepth, "562");
    await POST(postRequest(fixture()));
    assert.equal(rows.size, 1, "Retries use the same unique run ID");
    const withInsight = fixture() as CompletedRun;
    withInsight.advisorInsight = deterministicInsight(withInsight, undefined, "missing_key");
    response = await POST(postRequest(withInsight));
    assert.equal((await response.json()).run.advisorInsight.source, "fallback");
    await POST(postRequest(fixture()));
    response = await GET(new Request("http://localhost/api/runs"));
    assert.equal((await response.json()).runs[0].advisorInsight.source, "fallback", "Late ordinary saves must not erase an insight");
    assert.equal(rows.size, 1, "Saving an insight must update the existing run");
    const newer = fixture(); newer.id = "c367fe2e-f083-4996-8cbd-c895d7a26b8e"; newer.completedAt = "2026-10-26T17:00:00.000Z";
    await POST(postRequest(newer));
    response = await GET(new Request("http://localhost/api/runs?limit=1"));
    const list = await response.json(); assert.equal(list.runs.length, 1); assert.equal(list.runs[0].id, newer.id);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    fail = "P2021";
    response = await GET(new Request("http://localhost/api/runs"));
    assert.equal(response.status, 503); assert.match((await response.json()).message, /database setup is incomplete.*current results remain available/);
    fail = "P1001";
    response = await POST(postRequest(fixture()));
    assert.equal(response.status, 503);
    const failure = await response.text(); assert.match(failure, /temporarily unavailable/); assert.ok(!failure.includes("secret-password"));
  } finally {
    if (previousUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previousUrl;
    cache.qSplitDatabase = previousCache;
  }
});

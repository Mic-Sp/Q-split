import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { PATCH, DELETE } from "@/app/api/runs/[id]/route";
import { GET, POST } from "@/app/api/runs/route";
import { restoredConfiguration, snapshotPatch } from "./benchmark-snapshot";
import { createRunRecord, serializeRun } from "./run-record";
import { benchmarkHistory, mergeRuns } from "./run-history";
import { createSessionClient } from "./client-session";
import { benchmarkExportRuns, selectedBenchmarkRuns } from "./benchmark-comparison";
import { benchmarkCsv, benchmarkJson } from "./benchmark-export";
import type { SavedSimulationRun } from "@/types/run-history";
import { DATABASE_CLIENT_SCHEMA } from "./db";
import type { Prisma, PrismaClient, SimulationRun } from "@/generated/prisma/client";
import type { CompletedRun } from "@/types/run-history";
import { deterministicInsight } from "./advisor";

const id = "c367fe2e-f083-4996-8cbd-c895d7a26b8d";
const fixture = (): CompletedRun => ({ id, completedAt: "2026-10-27T12:00:00.000Z",
  request: { workload_id: "shors_crypto", scale_param: 21, hardware_profile: "ideal_sim", available_qubits: 28,
    routing: { stage_1_node: "GPU", stage_2_node: "QPU", stage_3_node: "CPU" } },
  telemetry: { workload_id: "shors_crypto", workload_name: "Shor", scale_label: "N = 21", execution_mode: "NISQ_ANALYTICAL_PROFILER", primary_bottleneck: "NONE", stages: {
    stage_1_classical_pre: { name: "Pre", node: "GPU", latency_ms: 0.37, status: "WARNING", output_summary: "Ready", metrics: { launch_transfer_overhead_ms: 0.3 } },
    stage_2_quantum_kernel: { name: "Kernel", node: "QPU", latency_ms: 0.03, status: "OPTIMAL", output_summary: "Ready", metrics: { available_qubits: 28, qubits_allocated: 28, qubits_required: 13, circuit_depth: 122, coherence_survival_pct: 100 } },
    stage_3_classical_post: { name: "Post", node: "CPU", latency_ms: 0.31, status: "OPTIMAL", output_summary: "Ready", metrics: {} },
  } },
});
const context = (runId = id) => ({ params: Promise.resolve({ id: runId }) });
const patch = (body: unknown) => new Request(`http://localhost/api/runs/${id}`, { method: "PATCH", body: JSON.stringify(body) });
const remove = () => new Request(`http://localhost/api/runs/${id}`, { method: "DELETE" });
const record = () => ({ ...createRunRecord(fixture()), sessionId: null, createdAt: new Date(), snapshotName: null, isSnapshot: false, snapshotUpdatedAt: null }) as SimulationRun;

function repository(t: TestContext) {
  const global = globalThis as unknown as { qSplitDatabase?: { url: string; client: PrismaClient; schemaVersion?: string } };
  const prior = global.qSplitDatabase, priorUrl = process.env.DATABASE_URL;
  const rows = new Map([[id, record()]]);
  const stats = { writes: 0, reads: 0, fail: false, failPrune: false, conflicts: 0, transactions: 0 };
  const check = () => { if (stats.fail) throw new Error("secret-password must not be exposed"); };
  const url = "postgresql://test:test@snapshot-test.invalid/test";
  process.env.DATABASE_URL = url;
  global.qSplitDatabase = { url, schemaVersion: DATABASE_CLIENT_SCHEMA, client: {
    async $transaction<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>, options: { isolationLevel: string }) {
      assert.equal(options.isolationLevel, "Serializable"); stats.transactions++;
      const before = structuredClone(rows);
      try {
        const result = await operation(this as unknown as Prisma.TransactionClient);
        if (stats.conflicts > 0) { stats.conflicts--; throw Object.assign(new Error("private conflict details"), { code: "P2034" }); }
        return result;
      } catch (error) {
        rows.clear(); before.forEach((row, id) => rows.set(id, row)); throw error;
      }
    },
    simulationRun: {
    update: async ({ where, data }: { where: { id: string; sessionId: string | null }; data: Partial<SimulationRun> }) => {
      check(); stats.writes++;
      const existing = rows.get(where.id);
      if (!existing || existing.sessionId !== where.sessionId) throw Object.assign(new Error("private missing record details"), { code: "P2025" });
      const result = { ...existing, ...data }; rows.set(where.id, result); return result;
    },
    deleteMany: async ({ where }: { where: { id: string | { notIn: string[] }; sessionId: string | null; isSnapshot?: boolean; snapshotName?: null } }) => {
      check(); stats.writes++;
      if (stats.failPrune && typeof where.id !== "string") throw new Error("secret-password pruning failure");
      const targets = [...rows.values()].filter(row => row.sessionId === where.sessionId &&
        (where.isSnapshot === undefined || row.isSnapshot === where.isSnapshot) &&
        (where.snapshotName === undefined || row.snapshotName === where.snapshotName) &&
        (typeof where.id === "string" ? row.id === where.id : !where.id.notIn.includes(row.id)));
      targets.forEach(row => rows.delete(row.id)); return { count: targets.length };
    },
    findMany: async ({ take, where, orderBy, select }: { take?: number; where: { sessionId: string | null; isSnapshot?: boolean; snapshotName?: null; workloadId?: string }; orderBy: { createdAt?: string; completedAt?: string; id?: string }[]; select?: { id: boolean } }) => {
      check(); stats.reads++;
      const results = [...rows.values()].filter(row => row.sessionId === where.sessionId && (!where.workloadId || row.workloadId === where.workloadId) &&
        (where.isSnapshot === undefined || row.isSnapshot === where.isSnapshot) && (where.snapshotName === undefined || row.snapshotName === where.snapshotName))
        .sort((a, b) => (orderBy[0].createdAt ? +b.createdAt - +a.createdAt : +b.completedAt - +a.completedAt) || b.id.localeCompare(a.id)).slice(0, take);
      return select ? results.map(row => ({ id: row.id })) : results;
    },
    upsert: async ({ where, create, update }: { where: { id: string; sessionId: string | null }; create: SimulationRun; update: Partial<SimulationRun> }) => {
      check(); stats.writes++;
      if (rows.has(where.id) && rows.get(where.id)!.sessionId !== where.sessionId) throw Object.assign(new Error("private duplicate record details"), { code: "P2002" });
      const result = rows.has(where.id) ? { ...rows.get(where.id)!, ...update } : { ...create, createdAt: new Date(), snapshotName: null, isSnapshot: false, snapshotUpdatedAt: null }; rows.set(where.id, result); return result;
    },
  } } as unknown as PrismaClient };
  t.after(() => { global.qSplitDatabase = prior; if (priorUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = priorUrl; });
  return { rows, stats };
}

test("snapshot metadata validates names, explicit unpinning, bounds, and mass assignment", () => {
  assert.deepEqual(snapshotPatch({ snapshotName: "  N=35 NISQ Decoherence Test  " }), { snapshotName: "N=35 NISQ Decoherence Test", isSnapshot: true });
  assert.deepEqual(snapshotPatch({ snapshotName: null }), { snapshotName: null, isSnapshot: false });
  assert.deepEqual(snapshotPatch({ isSnapshot: false }), { snapshotName: null, isSnapshot: false });
  for (const value of [null, [], {}, { snapshotName: "" }, { snapshotName: "x".repeat(121) }, { snapshotName: "bad\nname" }, { snapshotName: "bad\u200bname" }, { snapshotName: 42 }, { snapshotName: "valid", isSnapshot: "true" }, { snapshotName: "valid", telemetry: {} }, { snapshotName: null, isSnapshot: true }]) assert.throws(() => snapshotPatch(value));
});

test("PATCH names and renames only metadata; ordinary POST retries preserve the snapshot", async t => {
  const { rows } = repository(t);
  const original = structuredClone(rows.get(id)!);
  const response = await PATCH(patch({ snapshotName: "N21 Capacity Ceiling" }), context());
  assert.equal(response.status, 200); assert.equal(response.headers.get("Cache-Control"), "no-store");
  const first = (await response.json()).run;
  assert.equal(first.snapshotName, "N21 Capacity Ceiling"); assert.equal(first.isSnapshot, true); assert.ok(first.snapshotUpdatedAt);
  assert.deepEqual(rows.get(id)!.telemetry, original.telemetry);
  assert.deepEqual(rows.get(id)!.requestPayload, original.requestPayload);
  await POST(new Request("http://localhost/api/runs", { method: "POST", body: JSON.stringify({ ...fixture(), snapshotName: "must be ignored", isSnapshot: false }) }));
  assert.equal(rows.get(id)!.snapshotName, "N21 Capacity Ceiling");
  const renamed = await PATCH(patch({ snapshotName: "RSA comparison reference" }), context());
  assert.equal((await renamed.json()).run.snapshotName, "RSA comparison reference");
  await PATCH(patch({ isSnapshot: false }), context());
  assert.equal(rows.get(id)!.isSnapshot, false); assert.equal(rows.get(id)!.snapshotName, null);
});

test("history returns old pinned snapshots separately from the bounded recent window", async t => {
  const { rows } = repository(t);
  await PATCH(patch({ snapshotName: "Old pinned baseline" }), context());
  for (let i = 0; i < 25; i++) {
    const row = record(); row.id = `c367fe2e-f083-4996-8cbd-${String(i).padStart(12, "0")}`; row.completedAt = new Date(Date.UTC(2026, 9, 28, 12, i)); rows.set(row.id, row);
  }
  const body = await (await GET(new Request("http://localhost/api/runs?limit=20"))).json();
  assert.equal(body.runs.length, 20); assert.equal(body.snapshots.length, 1); assert.equal(body.snapshots[0].id, id);
  const merged = mergeRuns([], [...body.runs, ...body.snapshots]);
  assert.equal(merged.length, 21); assert.equal(merged.find(row => row.id === id)?.snapshotName, "Old pinned baseline");
});

test("late save and refresh responses cannot erase newer snapshot names", () => {
  const initial = serializeRun(record());
  const named = { ...initial, snapshotName: "Pinned name", isSnapshot: true, snapshotUpdatedAt: "2026-10-27T14:00:00.000Z" };
  assert.equal(mergeRuns([named], [initial])[0].snapshotName, "Pinned name");
  const renamed = { ...named, snapshotName: "New name", snapshotUpdatedAt: "2026-10-27T15:00:00.000Z" };
  assert.equal(mergeRuns([named], [renamed])[0].snapshotName, "New name");
});

test("restore returns exact captured controls with independent routing and legacy defaults", () => {
  const saved = serializeRun(record());
  assert.deepEqual(restoredConfiguration(saved), fixture().request);
  const restored = restoredConfiguration(saved); restored.routing!.stage_1_node = "CPU";
  assert.equal(saved.request.routing!.stage_1_node, "GPU");
  delete saved.request.available_qubits; saved.request.routing = null;
  assert.equal(restoredConfiguration(saved).available_qubits, 133);
  assert.deepEqual(restoredConfiguration(saved).routing, { stage_1_node: "CPU", stage_2_node: "QPU", stage_3_node: "CPU" });
});

test("DELETE targets one run and is idempotent; offline mutations keep existing rows", async t => {
  const { rows, stats } = repository(t);
  const other = record(); other.id = "c367fe2e-f083-4996-8cbd-c895d7a26b8e"; rows.set(other.id, other);
  stats.fail = true;
  for (const response of [await PATCH(patch({ snapshotName: "Offline" }), context()), await DELETE(remove(), context())]) {
    assert.equal(response.status, 503); assert.ok(!(await response.text()).includes("secret-password"));
  }
  assert.equal(rows.size, 2);
  stats.fail = false;
  assert.equal((await (await DELETE(remove(), context())).json()).status, "deleted");
  assert.equal(rows.size, 1); assert.ok(rows.has(other.id));
  assert.equal((await DELETE(remove(), context())).status, 200);
  assert.equal((await PATCH(patch({ snapshotName: "Missing" }), context())).status, 404);
  process.env.DATABASE_URL = "";
  assert.equal((await (await DELETE(remove(), context())).json()).status, "unconfigured");
  assert.equal((await (await PATCH(patch({ snapshotName: "No database" }), context())).json()).status, "unconfigured");
});

test("invalid IDs and patch payloads fail before database writes", async t => {
  const { stats } = repository(t);
  assert.equal((await PATCH(patch({ snapshotName: "Valid" }), context("invalid-id"))).status, 400);
  assert.equal((await DELETE(remove(), context("invalid-id"))).status, 400);
  assert.equal((await PATCH(patch({ snapshotName: "bad\nname" }), context())).status, 400);
  assert.equal((await PATCH(new Request(`http://localhost/api/runs/${id}`, { method: "PATCH", body: "{" }), context())).status, 400);
  assert.equal((await PATCH(patch({ snapshotName: "x".repeat(2049) }), context())).status, 413);
  assert.equal(stats.writes, 0);
});

test("workload queries keep twenty own recent runs and only own pinned snapshots; naming, restore and deletion stay isolated", async t => {
  const { rows, stats } = repository(t);
  await PATCH(patch({ snapshotName: "Shor pinned baseline" }), context());
  for (const workload of ["shors_crypto", "quantum_mips"] as const) {
    for (let i = 0; i < 26; i++) {
      const input = fixture();
      input.id = `c367fe2e-f083-4996-8cbd-${workload === "quantum_mips" ? "1" : "2"}${String(i).padStart(11, "0")}`;
      input.request.workload_id = workload; input.telemetry.workload_id = workload;
      input.completedAt = new Date(Date.UTC(2026, 9, workload === "quantum_mips" ? 30 : 29, 12, i)).toISOString();
      if (workload === "quantum_mips") {
        input.request.scale_param = 1024; input.request.available_qubits = 23;
        input.telemetry.workload_name = "Quantum-MIPS"; input.telemetry.scale_label = "M = 1,024";
        Object.assign(input.telemetry.stages.stage_2_quantum_kernel.metrics, { available_qubits: 23, qubits_allocated: 14, qubits_required: 14, parallelization_tier: "Sequential Minimum" });
      }
      rows.set(input.id, { ...createRunRecord(input), sessionId: null, createdAt: new Date(input.completedAt), snapshotName: i === 0 ? `${workload} old pin` : null,
        isSnapshot: i === 0, snapshotUpdatedAt: null } as SimulationRun);
    }
  }
  for (const workload of ["shors_crypto", "quantum_mips", "shors_factoring"]) {
    const canonical = workload === "shors_factoring" ? "shors_crypto" : workload;
    const response = await GET(new Request(`http://localhost/api/runs?limit=20&workload=${workload}`));
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.runs.length, 20);
    assert.ok(result.runs.every((run: { workloadId: string }) => run.workloadId === canonical));
    assert.equal(result.snapshots.length, canonical === "shors_crypto" ? 2 : 1);
    assert.ok(result.snapshots.every((run: { workloadId: string }) => run.workloadId === canonical));
  }
  const reads = stats.reads;
  for (const workload of ["unknown", "", "__proto__"]) assert.equal((await GET(new Request(`http://localhost/api/runs?workload=${workload}`))).status, 400);
  assert.equal(stats.reads, reads, "Invalid filters fail before database access");
  const recent = await (await GET(new Request("http://localhost/api/runs?workload=quantum_mips"))).json();
  const chosen = recent.runs[0];
  const renamed = await PATCH(new Request(`http://localhost/api/runs/${chosen.id}`, { method: "PATCH", body: JSON.stringify({ snapshotName: "MIPS custom register" }) }), context(chosen.id));
  const saved = (await renamed.json()).run;
  assert.equal(saved.snapshotName, "MIPS custom register");
  assert.deepEqual(restoredConfiguration(saved), { ...chosen.request, available_qubits: 23 });
  assert.equal(saved.request.workload_id, "quantum_mips");
  assert.equal(rows.get(id)!.snapshotName, "Shor pinned baseline");
  const removed = await DELETE(new Request(`http://localhost/api/runs/${chosen.id}`, { method: "DELETE" }), context(chosen.id));
  assert.equal(removed.status, 200); assert.ok(!rows.has(chosen.id)); assert.ok(rows.has(id));
});

function sessionRequest(path: string, method: string, sessionId: string | null, body?: unknown) {
  return new Request(`http://localhost/api/runs${path}`, { method,
    headers: sessionId === null ? {} : { "X-Session-Id": sessionId },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test("sessions isolate recent runs, pinned snapshots, retries, renames, and deletes from other sessions and legacy callers", async t => {
  const { rows } = repository(t);
  const a = { ...fixture(), id: "c367fe2e-f083-4996-8cbd-c895d7a26b8a" };
  const b = { ...fixture(), id: "c367fe2e-f083-4996-8cbd-c895d7a26b8b", completedAt: "2026-10-28T12:00:00.000Z" };
  for (const [input, session] of [[a, "session-a"], [b, "session-b"]] as const) {
    assert.equal((await POST(sessionRequest("", "POST", session, { ...input, sessionId: "payload-cannot-change-owner" }))).status, 201);
    assert.equal(rows.get(input.id)!.sessionId, session);
    assert.equal((await PATCH(sessionRequest(`/${input.id}`, "PATCH", session, { snapshotName: session }), context(input.id))).status, 200);
    assert.equal((await POST(sessionRequest("", "POST", session, input))).status, 201);
    assert.equal(rows.get(input.id)!.snapshotName, session, "Retries preserve pins");
  }
  for (const [session, expectedId] of [["session-a", a.id], ["session-b", b.id], [null, id]] as const) {
    for (const query of ["?limit=1", "?limit=1&workload=shors_crypto", "?limit=1&workload=shors_factoring"]) {
      const response = await GET(sessionRequest(query, "GET", session));
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.deepEqual(result.runs.map((run: { id: string }) => run.id), [expectedId]);
      assert.deepEqual(result.snapshots.map((run: { id: string }) => run.id), session === null ? [] : [expectedId]);
      assert.equal(response.headers.get("Cache-Control"), "no-store");
    }
    const otherWorkload = await (await GET(sessionRequest("?workload=quantum_mips", "GET", session))).json();
    assert.deepEqual(otherWorkload.runs, []); assert.deepEqual(otherWorkload.snapshots, []);
  }
  const original = structuredClone(rows.get(a.id)!);
  for (const outsider of ["session-b", null]) {
    for (const metadata of [{ snapshotName: "Hijacked" }, { isSnapshot: false }]) {
      assert.equal((await PATCH(sessionRequest(`/${a.id}`, "PATCH", outsider, metadata), context(a.id))).status, 404);
    }
    assert.equal((await DELETE(sessionRequest(`/${a.id}`, "DELETE", outsider), context(a.id))).status, 200);
    const insight = deterministicInsight(a, undefined, "missing_key");
    const conflict = await POST(sessionRequest("", "POST", outsider, { ...a, advisorInsight: insight }));
    assert.equal(conflict.status, 409);
    assert.ok(!(await conflict.text()).includes("private"));
    assert.deepEqual(rows.get(a.id), original, "Foreign writes and UUID collisions cannot alter or return a run");
  }
  assert.equal((await PATCH(sessionRequest(`/${id}`, "PATCH", "session-a", { snapshotName: "Claim legacy" }), context())).status, 404);
  assert.equal((await DELETE(sessionRequest(`/${id}`, "DELETE", "session-a"), context())).status, 200);
  assert.ok(rows.has(id));
  assert.equal((await PATCH(sessionRequest(`/${a.id}`, "PATCH", "session-a", { snapshotName: "Renamed" }), context(a.id))).status, 200);
  assert.equal(rows.get(a.id)!.snapshotName, "Renamed");
  assert.equal((await DELETE(sessionRequest(`/${a.id}`, "DELETE", "session-a"), context(a.id))).status, 200);
  assert.ok(!rows.has(a.id)); assert.ok(rows.has(b.id)); assert.ok(rows.has(id));
});

test("invalid session headers fail closed before reads or writes", async t => {
  const { stats } = repository(t);
  for (const session of ["", "bad token", "a,b", "x".repeat(129)]) {
    assert.equal((await GET(sessionRequest("", "GET", session))).status, 400);
    assert.equal((await POST(sessionRequest("", "POST", session, fixture()))).status, 400);
    assert.equal((await PATCH(sessionRequest(`/${id}`, "PATCH", session, { snapshotName: "Valid" }), context())).status, 400);
    assert.equal((await DELETE(sessionRequest(`/${id}`, "DELETE", session), context())).status, 400);
  }
  assert.equal((await PATCH(sessionRequest(`/${id}`, "PATCH", null, { snapshotName: "Valid", sessionId: "session-a" }), context())).status, 400);
  assert.equal(stats.reads, 0); assert.equal(stats.writes, 0);
});

test("automatic browser sessions scope API history, snapshots, comparisons, exports, and deletion across reloads", async t => {
  const { rows } = repository(t);
  const stored = new Map<string, string>();
  const browser = { sessionStorage: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value); } } };
  const a = createSessionClient(() => browser);
  const b = createSessionClient(() => ({ sessionStorage: { getItem: () => null, setItem: () => {} } }));
  t.mock.method(globalThis, "fetch", async (path: RequestInfo | URL, options?: RequestInit) => {
    const request = new Request(`http://localhost${path}`, options);
    const runId = new URL(request.url).pathname.split("/")[3];
    switch (request.method) {
      case "POST": return POST(request);
      case "PATCH": return PATCH(request, context(runId));
      case "DELETE": return DELETE(request, context(runId));
      default: return GET(request);
    }
  });
  assert.deepEqual((await (await a.fetch("/api/runs")).json()).runs, [], "First request cannot load the legacy bucket");
  const runA = { ...fixture(), id: "c367fe2e-f083-4996-8cbd-c895d7a26b8a" };
  const runB = { ...fixture(), id: "c367fe2e-f083-4996-8cbd-c895d7a26b8b" };
  for (const [client, run] of [[a, runA], [b, runB]] as const) {
    assert.equal((await client.fetch("/api/runs", { method: "POST", body: JSON.stringify(run) })).status, 201);
    assert.equal(rows.get(run.id)!.sessionId, client.getSessionId());
  }
  await a.fetch(`/api/runs/${runA.id}`, { method: "PATCH", body: JSON.stringify({ snapshotName: "Only workspace A" }) });
  const reloaded = createSessionClient(() => browser);
  const history = await (await reloaded.fetch("/api/runs?workload=shors_crypto")).json();
  const loaded: SavedSimulationRun[] = mergeRuns([], [...history.runs, ...history.snapshots]);
  const view = benchmarkHistory(loaded, "shors_crypto", false, false);
  assert.deepEqual(view.visibleRuns.map(run => run.id), [runA.id]);
  assert.deepEqual(history.snapshots.map((run: SavedSimulationRun) => run.id), [runA.id]);
  assert.equal(view.visibleRuns[0].snapshotName, "Only workspace A");
  const selectedIds = [runB.id, id, runA.id];
  assert.deepEqual(selectedBenchmarkRuns(view.runs, selectedIds).map(run => run.id), [runA.id]);
  for (const selection of [[], selectedIds]) {
    const exported = benchmarkExportRuns(view.runs, view.visibleRuns, selection);
    assert.deepEqual(JSON.parse(benchmarkJson(exported)).map((run: SavedSimulationRun) => run.id), [runA.id]);
    assert.ok(!benchmarkCsv(exported).includes(runB.id)); assert.ok(!benchmarkCsv(exported).includes(id));
  }
  assert.equal((await b.fetch(`/api/runs/${runA.id}`, { method: "PATCH", body: JSON.stringify({ snapshotName: "Foreign" }) })).status, 404);
  await b.fetch(`/api/runs/${runA.id}`, { method: "DELETE" });
  assert.ok(rows.has(runA.id));
  await reloaded.fetch(`/api/runs/${runA.id}`, { method: "DELETE" });
  assert.ok(!rows.has(runA.id)); assert.ok(rows.has(runB.id)); assert.ok(rows.has(id));
  assert.deepEqual((await (await b.fetch("/api/runs")).json()).runs.map((run: SavedSimulationRun) => run.id), [runB.id]);
});

function retentionRecord(index: number, sessionId: string | null): SimulationRun {
  const input = fixture();
  input.id = `c367fe2e-f083-4996-8cbd-${String(index).padStart(12, "0")}`;
  if (index % 2) {
    input.request.workload_id = "quantum_mips"; input.request.scale_param = 64;
    input.telemetry.workload_id = "quantum_mips"; input.telemetry.workload_name = "Quantum-MIPS"; input.telemetry.scale_label = "M = 64";
  }
  return { ...createRunRecord(input), sessionId, createdAt: new Date(Date.UTC(2020, 0, 1, 0, index)),
    snapshotName: null, isSnapshot: false, snapshotUpdatedAt: null } as SimulationRun;
}

test("a twenty-first unpinned save prunes only its session's oldest run across workloads and protects named or pinned snapshots", async t => {
  const { rows } = repository(t);
  const oldest = retentionRecord(0, "session-a");
  for (let i = 0; i < 20; i++) { const row = retentionRecord(i, "session-a"); rows.set(row.id, row); }
  // Deliberately independent protection flags cover older/inconsistent metadata too.
  const named = { ...retentionRecord(100, "session-a"), createdAt: new Date("2019-01-01"), snapshotName: "Keep named forever" };
  const pinned = { ...retentionRecord(101, "session-a"), createdAt: new Date("2019-01-01"), isSnapshot: true };
  rows.set(named.id, named); rows.set(pinned.id, pinned);
  for (let i = 200; i < 225; i++) { const row = retentionRecord(i, "session-b"); rows.set(row.id, row); }
  const protectedRows = structuredClone([...rows.values()].filter(row => row.sessionId !== "session-a" || row.snapshotName !== null || row.isSnapshot));
  const fresh = { ...fixture(), completedAt: "2000-01-01T00:00:00.000Z" };
  // A backdated completion must still use its server insertion time for FIFO.
  fresh.id = "c367fe2e-f083-4996-8cbd-000000000021";
  const saved = await POST(sessionRequest("", "POST", "session-a", fresh));
  assert.equal(saved.status, 201);
  assert.ok(!rows.has(oldest.id)); assert.ok(rows.has(fresh.id));
  assert.equal([...rows.values()].filter(row => row.sessionId === "session-a" && !row.isSnapshot && row.snapshotName === null).length, 20);
  for (let i = 1; i < 20; i++) assert.ok(rows.has(retentionRecord(i, "session-a").id));
  for (const row of protectedRows) assert.deepEqual(rows.get(row.id), row, "Pruning cannot change named/pinned snapshots, other sessions, or legacy rows");
  const createdAt = rows.get(fresh.id)!.createdAt;
  assert.equal((await POST(sessionRequest("", "POST", "session-a", fresh))).status, 201);
  assert.deepEqual(rows.get(fresh.id)!.createdAt, createdAt, "Retries never refresh FIFO age");
  assert.equal([...rows.values()].filter(row => row.sessionId === "session-a").length, 22, "Snapshots do not count against the twenty-run cap");
});

test("one save clears an existing legacy backlog with deterministic timestamp ties without pruning another session", async t => {
  const { rows } = repository(t); rows.clear();
  for (let i = 0; i < 25; i++) {
    const row = { ...retentionRecord(i, null), createdAt: new Date("2020-01-01") }; rows.set(row.id, row);
  }
  const pinned = { ...retentionRecord(100, null), isSnapshot: true, snapshotName: "Legacy baseline" };
  const foreign = retentionRecord(200, "session-a"); rows.set(pinned.id, pinned); rows.set(foreign.id, foreign);
  assert.equal((await POST(sessionRequest("", "POST", null, fixture()))).status, 201);
  assert.equal([...rows.values()].filter(row => row.sessionId === null && !row.isSnapshot && row.snapshotName === null).length, 20);
  for (let i = 0; i < 25; i++) assert.equal(rows.has(retentionRecord(i, null).id), i >= 6, "Equal server timestamps use UUID descending as the tie-breaker");
  assert.deepEqual(rows.get(pinned.id), pinned); assert.deepEqual(rows.get(foreign.id), foreign);
});

test("prune failures roll back the save, and serialization conflicts retry atomically with a bounded failure path", async t => {
  const { rows, stats } = repository(t);
  for (let i = 0; i < 20; i++) { const row = retentionRecord(i, "session-a"); rows.set(row.id, row); }
  const before = structuredClone(rows), fresh = { ...fixture(), id: "c367fe2e-f083-4996-8cbd-000000000021" };
  stats.failPrune = true;
  const failed = await POST(sessionRequest("", "POST", "session-a", fresh));
  assert.equal(failed.status, 503); assert.ok(!(await failed.text()).includes("secret-password"));
  assert.deepEqual(rows, before, "A failed prune must not leave a twenty-first run committed");
  stats.failPrune = false; stats.conflicts = 1;
  const attempts = stats.transactions;
  assert.equal((await POST(sessionRequest("", "POST", "session-a", fresh))).status, 201);
  assert.equal(stats.transactions - attempts, 2);
  assert.ok(!rows.has(retentionRecord(0, "session-a").id)); assert.ok(rows.has(fresh.id));
  assert.equal([...rows.values()].filter(row => row.sessionId === "session-a").length, 20);
  const after = structuredClone(rows), priorAttempts = stats.transactions;
  stats.conflicts = 3;
  const exhausted = await POST(sessionRequest("", "POST", "session-a", { ...fresh, id: "c367fe2e-f083-4996-8cbd-000000000022" }));
  assert.equal(exhausted.status, 503); assert.ok(!(await exhausted.text()).includes("private conflict"));
  assert.equal(stats.transactions - priorAttempts, 3); assert.deepEqual(rows, after);
});

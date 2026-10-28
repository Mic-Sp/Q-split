import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { PATCH, DELETE } from "@/app/api/runs/[id]/route";
import { GET, POST } from "@/app/api/runs/route";
import { restoredConfiguration, snapshotPatch } from "./benchmark-snapshot";
import { createRunRecord, serializeRun } from "./run-record";
import { mergeRuns } from "./run-history";
import { DATABASE_CLIENT_SCHEMA } from "./db";
import type { PrismaClient, SimulationRun } from "@/generated/prisma/client";
import type { CompletedRun } from "@/types/run-history";

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
const record = () => ({ ...createRunRecord(fixture()), createdAt: new Date(), snapshotName: null, isSnapshot: false, snapshotUpdatedAt: null }) as SimulationRun;

function repository(t: TestContext) {
  const global = globalThis as unknown as { qSplitDatabase?: { url: string; client: PrismaClient; schemaVersion?: string } };
  const prior = global.qSplitDatabase, priorUrl = process.env.DATABASE_URL;
  const rows = new Map([[id, record()]]);
  const stats = { writes: 0, reads: 0, fail: false };
  const check = () => { if (stats.fail) throw new Error("secret-password must not be exposed"); };
  const url = "postgresql://test:test@snapshot-test.invalid/test";
  process.env.DATABASE_URL = url;
  global.qSplitDatabase = { url, schemaVersion: DATABASE_CLIENT_SCHEMA, client: { simulationRun: {
    update: async ({ where, data }: { where: { id: string }; data: Partial<SimulationRun> }) => {
      check(); stats.writes++;
      const existing = rows.get(where.id);
      if (!existing) throw Object.assign(new Error("private missing record details"), { code: "P2025" });
      const result = { ...existing, ...data }; rows.set(where.id, result); return result;
    },
    deleteMany: async ({ where }: { where: { id: string } }) => { check(); stats.writes++; return { count: rows.delete(where.id) ? 1 : 0 }; },
    findMany: async ({ take, where }: { take?: number; where?: { isSnapshot?: boolean; workloadId?: string } }) => {
      check(); stats.reads++; return [...rows.values()].filter(row => (!where?.workloadId || row.workloadId === where.workloadId) && (where?.isSnapshot === undefined || row.isSnapshot === where.isSnapshot)).sort((a, b) => +b.completedAt - +a.completedAt).slice(0, take);
    },
    upsert: async ({ where, create, update }: { where: { id: string }; create: SimulationRun; update: Partial<SimulationRun> }) => {
      check(); const result = rows.has(where.id) ? { ...rows.get(where.id)!, ...update } : { ...create, createdAt: new Date() }; rows.set(where.id, result); return result;
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
      rows.set(input.id, { ...createRunRecord(input), createdAt: new Date(input.completedAt), snapshotName: i === 0 ? `${workload} old pin` : null,
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

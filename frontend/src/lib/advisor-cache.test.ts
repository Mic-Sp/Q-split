import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { POST } from "@/app/api/advisor/route";
import { advisorCacheKey, adviseWithCache } from "@/lib/advisor-cache";
import { deterministicInsight, parseAdvisorInsight } from "@/lib/advisor";
import { validateAdvisorRequest } from "@/lib/advisor-input";
import { DATABASE_CLIENT_SCHEMA } from "@/lib/db";
import type { PrismaClient } from "@/generated/prisma/client";
import type { AdvisorInsight } from "@/types/advisor";

const fixture = () => ({ current: {
  id: "4d9c09fa-7843-4c63-9d2b-556f74c4e5ab", completedAt: "2026-10-26T16:00:00.000Z",
  request: { workload_id: "shors_crypto", scale_param: 21, hardware_profile: "ideal_sim", available_qubits: 28 },
  telemetry: { workload_id: "shors_crypto", workload_name: "Shor", scale_label: "N = 21", execution_mode: "NISQ_ANALYTICAL_PROFILER", primary_bottleneck: "NONE", stages: {
    stage_1_classical_pre: { name: "Pre", node: "CPU", latency_ms: 0.28, status: "OPTIMAL", output_summary: "Ready", metrics: {} },
    stage_2_quantum_kernel: { name: "Kernel", node: "QPU", latency_ms: 0.03, status: "OPTIMAL", output_summary: "Ready", metrics: { available_qubits: 28, qubits_allocated: 28, circuit_depth: 122, coherence_survival_pct: 100, parallelization_tier: "Carry-Lookahead Parallel" } },
    stage_3_classical_post: { name: "Post", node: "CPU", latency_ms: 0.31, status: "OPTIMAL", output_summary: "Ready", metrics: {} },
  } },
} });
const sections = { routingDiagnosis: "CPU → QPU → CPU routing completes without a critical bottleneck.", spaceTimeTradeOff: "28 qubits reach the carry-lookahead ceiling for N = 21.", optimizationRecommendation: "Compare the NISQ hardware profile at the same capacity and scale." };
const request = (value: unknown) => new Request("http://localhost/api/advisor", { method: "POST", body: JSON.stringify(value) });
const response = () => Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(sections) }] } }] });

function repository(t: TestContext) {
  const global = globalThis as unknown as { qSplitDatabase?: { url: string; client: PrismaClient; schemaVersion?: string } };
  const original = global.qSplitDatabase;
  const env = { DATABASE_URL: process.env.DATABASE_URL, GEMINI_API_KEY: process.env.GEMINI_API_KEY, GEMINI_MODEL: process.env.GEMINI_MODEL };
  const url = "postgresql://test:test@cache-test.invalid/test";
  const rows = new Map<string, { advisorInsight: AdvisorInsight | null }>([[fixture().current.id, { advisorInsight: null }]]);
  const stats = { reads: 0, writes: 0, failRead: false, failWrite: false };
  process.env.DATABASE_URL = url; process.env.GEMINI_API_KEY = "test-key"; process.env.GEMINI_MODEL = "gemini-3.5-flash-lite";
  global.qSplitDatabase = { url, schemaVersion: DATABASE_CLIENT_SCHEMA, client: { simulationRun: {
    findUnique: async ({ where }: { where: { id: string } }) => {
      stats.reads++;
      if (stats.failRead) throw new Error("secret-driver-password");
      return rows.get(where.id) ?? null;
    },
    updateMany: async ({ where, data }: { where: { id: string }; data: { advisorInsight: AdvisorInsight } }) => {
      stats.writes++;
      if (stats.failWrite) throw new Error("secret-driver-password");
      if (!rows.has(where.id)) return { count: 0 };
      rows.set(where.id, { advisorInsight: structuredClone(data.advisorInsight) });
      return { count: 1 };
    },
  } } as unknown as PrismaClient };
  t.after(() => {
    global.qSplitDatabase = original;
    for (const [key, value] of Object.entries(env)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  });
  return { rows, stats };
}

test("validated Neon cache hits bypass Gemini, including when its API key is absent", async (t) => {
  const { rows, stats } = repository(t); let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return response(); });
  const first = await (await POST(request(fixture()))).json();
  assert.equal(first.insight.source, "gemini");
  assert.equal(first.persistence.status, "saved");
  assert.match(first.insight.cacheKey, /^[a-f0-9]{64}$/);
  assert.deepEqual(rows.get(fixture().current.id)!.advisorInsight, first.insight, "Server persists before returning");
  process.env.GEMINI_API_KEY = "";
  const second = await (await POST(request(fixture()))).json();
  assert.equal(second.insight.source, "cached");
  assert.equal(parseAdvisorInsight(second.insight, fixture().current.id).cacheKey, first.insight.cacheKey);
  assert.equal(second.insight.generatedAt, first.insight.generatedAt);
  assert.deepEqual(second.insight.sections, first.insight.sections);
  assert.equal(second.persistence.status, "saved");
  assert.equal(calls, 1);
  assert.equal(stats.writes, 1);
});

test("fingerprints include current telemetry, previous run/comparison state, model and policy but ignore display metadata", () => {
  const input = validateAdvisorRequest(fixture());
  const key = advisorCacheKey(input, "gemini-test", "policy-v1");
  const textOnly = fixture(); textOnly.current.telemetry.workload_name = "Different display name";
  assert.equal(advisorCacheKey(validateAdvisorRequest(textOnly), "gemini-test", "policy-v1"), key);
  assert.notEqual(advisorCacheKey(input, "gemini-test", "policy-v2"), key);
  assert.notEqual(advisorCacheKey(input, "gemini-other", "policy-v1"), key);
  const changed = structuredClone(input); changed.current.telemetry.stages.stage_2_quantum_kernel.latency_ms = 0.04;
  assert.notEqual(advisorCacheKey(changed, "gemini-test", "policy-v1"), key);
  const withPrevious = { ...input, previous: structuredClone(input.current) };
  assert.notEqual(advisorCacheKey(withPrevious, "gemini-test", "policy-v1"), key);
  const previousKey = advisorCacheKey(withPrevious, "gemini-test", "policy-v1");
  withPrevious.previous.id = "4d9c09fa-7843-4c63-9d2b-556f74c4e5ac";
  assert.notEqual(advisorCacheKey(withPrevious, "gemini-test", "policy-v1"), previousKey);
});

test("changed comparisons and invalid, legacy, or fallback diagnostics are cache misses", async (t) => {
  const { rows } = repository(t); let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return response(); });
  const first = (await (await POST(request(fixture()))).json()).insight as AdvisorInsight;
  const variants = [
    { ...first, cacheKey: "0".repeat(64) },
    { ...first, cacheKey: undefined },
    { ...first, previousRunId: "4d9c09fa-7843-4c63-9d2b-556f74c4e5ac" },
    { ...first, sections: { ...sections, optimizationRecommendation: "Perform pulse calibration to improve survival." } },
    { ...deterministicInsight(validateAdvisorRequest(fixture()).current, undefined, "missing_key"), cacheKey: first.cacheKey },
  ];
  for (const invalid of variants) {
    rows.set(first.runId, { advisorInsight: invalid });
    assert.equal((await (await POST(request(fixture()))).json()).insight.source, "gemini");
  }
  assert.equal(calls, variants.length + 1);
  const input = validateAdvisorRequest(fixture());
  const compared = await (await POST(request({ ...input, previous: input.current }))).json();
  assert.equal(compared.insight.source, "gemini");
  assert.equal(compared.insight.previousRunId, input.current.id);
});

test("concurrent requests coalesce into one database lookup, generation, and write", async (t) => {
  const { stats } = repository(t); let calls = 0;
  let release!: () => void, started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  t.mock.method(globalThis, "fetch", async () => {
    calls++; started(); await new Promise<void>((resolve) => { release = resolve; }); return response();
  });
  const first = POST(request(fixture())); await ready;
  const second = POST(request(fixture()));
  await new Promise((resolve) => setTimeout(resolve, 0)); release();
  const responses = await Promise.all([first, second]);
  const results = await Promise.all(responses.map((result) => result.json()));
  assert.deepEqual(results.map((result) => result.insight.source), ["gemini", "cached"]);
  assert.equal(results[0].insight.generatedAt, results[1].insight.generatedAt);
  assert.equal(calls, 1); assert.equal(stats.reads, 1); assert.equal(stats.writes, 1);
});

test("database failures preserve valid live analysis or deterministic fallback without exposing driver errors", async (t) => {
  const { stats, rows } = repository(t); stats.failRead = true; stats.failWrite = true;
  let rateLimited = false;
  t.mock.method(globalThis, "fetch", async () => rateLimited ? Response.json({}, { status: 429 }) : response());
  let result = await (await POST(request(fixture()))).json();
  assert.equal(result.insight.source, "gemini");
  assert.equal(result.persistence.status, "unavailable");
  assert.ok(!JSON.stringify(result).includes("secret-driver-password"));
  rateLimited = true;
  result = await (await POST(request(fixture()))).json();
  assert.equal(result.insight.source, "fallback");
  assert.equal(result.insight.fallbackReason, "rate_limited");
  assert.equal(rows.get(fixture().current.id)!.advisorInsight, null, "Fallbacks are not AI cache entries");
  stats.failRead = false; stats.failWrite = false; rows.clear(); rateLimited = false;
  result = await (await POST(request(fixture()))).json();
  assert.equal(result.insight.source, "gemini");
  assert.equal(result.persistence.status, "pending", "An unsaved original run stays in the frontend save queue");
});

test("a stalled database lookup is bounded and does not hang fallback analysis", async (t) => {
  repository(t);
  const global = globalThis as unknown as { qSplitDatabase: { client: { simulationRun: { findUnique: () => Promise<never> } } } };
  global.qSplitDatabase.client.simulationRun.findUnique = () => new Promise<never>(() => {});
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const input = validateAdvisorRequest(fixture());
  const work = adviseWithCache(input, "gemini-test", "timeout-policy", async () => deterministicInsight(input.current, undefined, "missing_key"));
  t.mock.timers.tick(1500);
  const result = await work;
  assert.equal(result.insight.source, "fallback");
  assert.equal(result.insight.fallbackReason, "missing_key");
  assert.equal(result.persistence?.status, "unavailable");
});

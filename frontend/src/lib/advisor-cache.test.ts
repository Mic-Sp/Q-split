import { SESSION_A, SESSION_B, SESSION_C } from "./test-support/api";
import assert from "node:assert/strict";
import { beforeEach, test, type TestContext } from "node:test";
import { POST } from "@/app/api/advisor/route";
import { POST as analyzeTelemetry } from "@/app/api/analyze-telemetry/route";
import { advisorCacheKey, adviseWithCache } from "@/lib/advisor-cache";
import { deterministicInsight, parseAdvisorInsight } from "@/lib/advisor";
import { validateAdvisorRequest } from "@/lib/advisor-input";
import { DATABASE_CLIENT_SCHEMA } from "@/lib/db";
import { createRunRecord, serializeRun } from "@/lib/run-record";
import type { SimulationRun } from "@/generated/prisma/client";
import type { PrismaClient } from "@/generated/prisma/client";
import type { AdvisorInsight } from "@/types/advisor";
import { createSessionClient } from "./client-session";
import { readRunSession, RUN_SESSION_HEADER } from "./run-session";
import { advisorRateLimiter } from "./advisor-rate-limit";

beforeEach(() => advisorRateLimiter.clear());

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
const request = (value: unknown, sessionId: string = SESSION_A) => new Request("http://localhost/api/advisor", { method: "POST", body: JSON.stringify(value),
  headers: { "X-Session-Id": sessionId },
});
const response = () => Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(sections) }] } }],
  usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 90, totalTokenCount: 1090 } });

function repository(t: TestContext) {
  const global = globalThis as unknown as { qSplitDatabase?: { url: string; client: PrismaClient; schemaVersion?: string } };
  const original = global.qSplitDatabase;
  const env = { DATABASE_URL: process.env.DATABASE_URL, GEMINI_API_KEY: process.env.GEMINI_API_KEY, GEMINI_MODEL: process.env.GEMINI_MODEL, VERCEL: process.env.VERCEL };
  const url = "postgresql://test:test@cache-test.invalid/test";
  const rows = new Map<string, { advisorInsight: AdvisorInsight | null; sessionId: string | null }>([[fixture().current.id, { advisorInsight: null, sessionId: SESSION_A }]]);
  const entries = new Map<string, { runId: string; advisorInsight: AdvisorInsight }>();
  const stats = { reads: 0, writes: 0, cacheWrites: 0, failRead: false, failWrite: false };
  process.env.DATABASE_URL = url; process.env.GEMINI_API_KEY = "test-key"; process.env.GEMINI_MODEL = "gemini-3.5-flash-lite";
  global.qSplitDatabase = { url, schemaVersion: DATABASE_CLIENT_SCHEMA, client: { advisorCache: {
    findUnique: async ({ where }: { where: { cacheKey: string } }) => {
      stats.reads++;
      if (stats.failRead) throw new Error("secret-driver-password");
      return entries.get(where.cacheKey) ?? null;
    },
    upsert: async ({ where, create }: { where: { cacheKey: string }; create: { runId: string; advisorInsight: AdvisorInsight } }) => {
      stats.cacheWrites++;
      if (stats.failWrite) throw new Error("secret-driver-password");
      entries.set(where.cacheKey, structuredClone(create));
      return create;
    },
  }, simulationRun: {
    updateMany: async ({ where, data }: { where: { id: string; sessionId: string | null }; data: { advisorInsight: AdvisorInsight } }) => {
      stats.writes++;
      if (stats.failWrite) throw new Error("secret-driver-password");
      if (!rows.has(where.id) || rows.get(where.id)!.sessionId !== where.sessionId) return { count: 0 };
      rows.set(where.id, { ...rows.get(where.id)!, advisorInsight: structuredClone(data.advisorInsight) });
      return { count: 1 };
    },
  } } as unknown as PrismaClient };
  t.after(() => {
    global.qSplitDatabase = original;
    for (const [key, value] of Object.entries(env)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  });
  return { rows, entries, stats };
}

test("validated Neon cache hits bypass Gemini, including when its API key is absent", async (t) => {
  const { rows, stats } = repository(t); let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return response(); });
  const first = await (await POST(request(fixture()))).json();
  assert.equal(first.insight.source, "gemini");
  assert.equal(first.persistence.status, "saved");
  assert.match(first.insight.cacheKey, /^[a-f0-9]{64}$/);
  assert.deepEqual(rows.get(fixture().current.id)!.advisorInsight, first.insight, "Server persists before returning");
  assert.deepEqual(first.insight.usage, { inputTokens: 1000, outputTokens: 90, totalTokens: 1090, tokenSource: "provider", estimatedCostUsd: 0.000204 });
  assert.equal(first.insight.telemetry.estimatedCostUsd, 0.000204);
  assert.equal(first.insight.telemetry.totalTokens, 1090);
  assert.ok(Number.isFinite(first.insight.telemetry.latencyMs) && first.insight.telemetry.latencyMs >= 0);
  process.env.GEMINI_API_KEY = "";
  const second = await (await POST(request(fixture()))).json();
  assert.equal(second.insight.source, "cached");
  assert.deepEqual(second.insight.usage, first.insight.usage);
  assert.deepEqual([second.insight.telemetry.inputTokens, second.insight.telemetry.outputTokens, second.insight.telemetry.totalTokens], [0, 0, 0]);
  assert.equal(second.insight.telemetry.estimatedCostUsd, 0);
  assert.equal(second.insight.telemetry.costSavedUsd, first.insight.usage.estimatedCostUsd);
  assert.ok(Number.isFinite(second.insight.telemetry.latencyMs) && second.insight.telemetry.latencyMs >= 0);
  const record = createRunRecord({ ...validateAdvisorRequest(fixture()).current, advisorInsight: second.insight });
  const historical = serializeRun({ ...record, createdAt: new Date() } as SimulationRun);
  assert.deepEqual(historical.advisorInsight, second.insight, "History validation and serialization retain original usage and free lookup metrics");
  assert.equal(parseAdvisorInsight(second.insight, fixture().current.id).cacheKey, first.insight.cacheKey);
  assert.equal(second.insight.generatedAt, first.insight.generatedAt);
  assert.deepEqual(second.insight.sections, first.insight.sections);
  assert.equal(second.persistence.status, "saved");
  assert.equal(calls, 1);
  assert.equal(stats.writes, 2, "Each response persists its own lookup accounting");
});

function rateRequest(index: number, sessionId: string, ip = "203.0.113.1") {
  const input = fixture();
  input.current.telemetry.stages.stage_2_quantum_kernel.metrics.circuit_depth += index;
  const wire = request(input, sessionId);
  wire.headers.set("x-vercel-forwarded-for", ip);
  wire.headers.set("x-forwarded-for", `198.51.100.${index + 1}`);
  return wire;
}

test("five session provider attempts exhaust the quota while persistent cache hits bypass the limiter entirely", async t => {
  const { stats } = repository(t);
  process.env.VERCEL = "1";
  let calls = 0;
  const gate = t.mock.method(advisorRateLimiter, "consume", advisorRateLimiter.consume.bind(advisorRateLimiter));
  t.mock.method(globalThis, "fetch", async () => { calls++; return response(); });
  for (let index = 0; index < 5; index++) {
    const result = await (await POST(rateRequest(index, SESSION_A))).json();
    assert.equal(result.insight.source, "gemini");
  }
  const limited = await POST(rateRequest(5, SESSION_A));
  const body = await limited.json();
  assert.equal(limited.status, 200, "Local limits preserve the deterministic-fallback response contract");
  assert.equal(body.insight.source, "fallback");
  assert.equal(body.insight.fallbackReason, "rate_limited");
  assert.match(body.insight.notice, /Live AI request limit reached.*Try again in \d+ seconds.*cached insights remain available/);
  assert.deepEqual([body.insight.telemetry.totalTokens, body.insight.telemetry.estimatedCostUsd], [0, 0]);
  assert.equal(calls, 5);
  const checks = gate.mock.callCount(), reads = stats.reads;
  for (let index = 0; index < 10; index++) {
    const cached = await (await POST(rateRequest(0, SESSION_A))).json();
    assert.equal(cached.insight.source, "cached");
    assert.equal(cached.insight.telemetry.totalTokens, 0);
  }
  assert.equal(stats.reads, reads + 10, "Each cache hit is resolved from the persistent cache");
  assert.equal(gate.mock.callCount(), checks, "Cache hits neither check nor consume a rate-limit token");
  assert.equal(calls, 5);
  assert.equal(stats.cacheWrites, 5, "A local rate-limit fallback cannot populate the advisor cache");
});

test("eight concurrent provider attempts across sessions exhaust the trusted IP quota across both API aliases", async t => {
  repository(t);
  process.env.VERCEL = "1";
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return response(); });
  const replies = await Promise.all(Array.from({ length: 9 }, (_, index) =>
    (index % 2 ? analyzeTelemetry : POST)(rateRequest(index, `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`))));
  const results = await Promise.all(replies.map(reply => reply.json()));
  assert.equal(results.filter(result => result.insight.source === "gemini").length, 8);
  const denied = results.findIndex(result => result.insight.fallbackReason === "rate_limited");
  assert.notEqual(denied, -1);
  assert.match(results[denied].insight.notice, /Live AI request limit reached.*Try again in/);
  assert.equal(calls, 8, "Rotating sessions and generic forwarding headers cannot bypass the connecting-IP quota");
  const cached = await (await POST(rateRequest(0, SESSION_C))).json();
  assert.equal(cached.insight.source, "cached", "An exhausted IP can still read valid cached insights");
  for (let index = 0; index < 5; index++) {
    const otherIp = await (await POST(rateRequest(20 + index, `00000000-0000-4000-8000-${String(denied).padStart(12, "0")}`, "203.0.113.2"))).json();
    assert.equal(otherIp.insight.source, "gemini", "An IP rejection never spends the rejected caller's session quota");
  }
  assert.equal(calls, 13);
});

test("coalesced diagnostics consume only the leader's provider token", async t => {
  repository(t);
  process.env.VERCEL = "1";
  const gate = t.mock.method(advisorRateLimiter, "consume", advisorRateLimiter.consume.bind(advisorRateLimiter));
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return response(); });
  const replies = await Promise.all(Array.from({ length: 12 }, (_, index) => POST(rateRequest(0, `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`))));
  const results = await Promise.all(replies.map(reply => reply.json()));
  assert.ok(results.every(result => result.insight.source === "gemini"));
  assert.equal(calls, 1);
  assert.equal(gate.mock.callCount(), 1);
  assert.equal(results.filter(result => result.insight.telemetry.shared).length, 11);
});

test("missing provider credentials consume no quota and failed outbound attempts remain limited", async t => {
  repository(t);
  const gate = t.mock.method(advisorRateLimiter, "consume", advisorRateLimiter.consume.bind(advisorRateLimiter));
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return Response.json({}, { status: 503 }); });
  delete process.env.GEMINI_API_KEY;
  for (let index = 0; index < 10; index++) {
    const result = await (await POST(request(fixture(), SESSION_A))).json();
    assert.equal(result.insight.fallbackReason, "missing_key");
  }
  assert.equal(gate.mock.callCount(), 0);
  assert.equal(calls, 0);
  process.env.GEMINI_API_KEY = "test-key";
  for (let index = 0; index < 5; index++) {
    const result = await (await POST(request(fixture(), SESSION_A))).json();
    assert.equal(result.insight.fallbackReason, "provider_error");
  }
  const limited = await (await POST(request(fixture(), SESSION_A))).json();
  assert.equal(limited.insight.fallbackReason, "rate_limited");
  assert.equal(calls, 5, "Unsuccessful provider attempts still count toward the live-call budget");
});

test("fingerprints include telemetry, comparison state, model and policy but ignore run identity and display metadata", () => {
  const input = validateAdvisorRequest(fixture());
  const key = advisorCacheKey(input, "gemini-test", "policy-v1");
  const textOnly = fixture(); textOnly.current.telemetry.workload_name = "Different display name";
  textOnly.current.id = "4d9c09fa-7843-4c63-9d2b-556f74c4e5ac";
  textOnly.current.completedAt = "2026-10-29T16:00:00.000Z";
  assert.equal(advisorCacheKey(validateAdvisorRequest(textOnly), "gemini-test", "policy-v1"), key);
  assert.notEqual(advisorCacheKey(input, "gemini-test", "policy-v2"), key);
  assert.notEqual(advisorCacheKey(input, "gemini-other", "policy-v1"), key);
  const changed = structuredClone(input); changed.current.telemetry.stages.stage_2_quantum_kernel.latency_ms = 0.04;
  assert.notEqual(advisorCacheKey(changed, "gemini-test", "policy-v1"), key);
  const withPrevious = { ...input, previous: structuredClone(input.current) };
  assert.notEqual(advisorCacheKey(withPrevious, "gemini-test", "policy-v1"), key);
  const previousKey = advisorCacheKey(withPrevious, "gemini-test", "policy-v1");
  withPrevious.previous.id = "4d9c09fa-7843-4c63-9d2b-556f74c4e5ac";
  assert.equal(advisorCacheKey(withPrevious, "gemini-test", "policy-v1"), previousKey);
  withPrevious.previous.telemetry.stages.stage_2_quantum_kernel.latency_ms = 0.05;
  assert.notEqual(advisorCacheKey(withPrevious, "gemini-test", "policy-v1"), previousKey);
});

test("changed comparisons and invalid, legacy, or fallback diagnostics are cache misses", async (t) => {
  const { entries } = repository(t); let calls = 0;
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
    advisorRateLimiter.clear(); // Isolate each malformed-cache scenario from provider quotas.
    entries.set(first.cacheKey!, { runId: first.runId, advisorInsight: invalid });
    assert.equal((await (await POST(request(fixture()))).json()).insight.source, "gemini");
  }
  assert.equal(calls, variants.length + 1);
  const input = validateAdvisorRequest(fixture());
  const compared = await (await POST(request({ ...input, previous: input.current }))).json();
  assert.equal(compared.insight.source, "gemini");
  assert.equal(compared.insight.previousRunId, input.current.id);
});

test("concurrent requests coalesce lookup and generation, then persist each caller's accounting", async (t) => {
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
  assert.deepEqual(results.map((result) => result.insight.source), ["gemini", "gemini"]);
  assert.equal(results[0].insight.telemetry.shared, false);
  assert.equal(results[1].insight.telemetry.shared, true);
  assert.equal(results[1].insight.telemetry.estimatedCostUsd, 0);
  assert.equal(results[1].insight.telemetry.totalTokens, 0);
  assert.deepEqual(results[0].insight.usage, results[1].insight.usage);
  assert.equal(results[0].insight.generatedAt, results[1].insight.generatedAt);
  assert.equal(calls, 1); assert.equal(stats.reads, 1); assert.equal(stats.writes, 2);
  assert.equal(stats.cacheWrites, 1);
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
  const global = globalThis as unknown as { qSplitDatabase: { client: { advisorCache: { findUnique: () => Promise<never> } } } };
  global.qSplitDatabase.client.advisorCache.findUnique = () => new Promise<never>(() => {});
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const input = validateAdvisorRequest(fixture());
  const work = adviseWithCache(input, "gemini-test", "timeout-policy", async () => deterministicInsight(input.current, undefined, "missing_key"));
  t.mock.timers.tick(1500);
  const result = await work;
  assert.equal(result.insight.source, "fallback");
  assert.equal(result.insight.fallbackReason, "missing_key");
  assert.equal(result.persistence?.status, "unavailable");
});

test("Advisor cache hits are global across sessions while IDs and persistence remain scoped, including the endpoint alias", async t => {
  const { rows, stats } = repository(t); let calls = 0;
  const a = fixture(), b = fixture();
  b.current.id = "4d9c09fa-7843-4c63-9d2b-556f74c4e5ac";
  b.current.completedAt = "2026-10-29T16:00:00.000Z";
  rows.set(a.current.id, { sessionId: SESSION_A, advisorInsight: null });
  rows.set(b.current.id, { sessionId: SESSION_B, advisorInsight: null });
  t.mock.method(globalThis, "fetch", async () => { calls++; return response(); });
  const first = await (await POST(request(a, SESSION_A))).json();
  assert.equal(first.insight.source, "gemini"); assert.equal(first.persistence.status, "saved");
  const originalA = structuredClone(rows.get(a.current.id)!);
  process.env.GEMINI_API_KEY = "";
  const second = await (await analyzeTelemetry(request(b, SESSION_B))).json();
  assert.equal(second.insight.source, "cached"); assert.equal(second.persistence.status, "saved");
  assert.equal(second.insight.cacheKey, first.insight.cacheKey);
  assert.equal(second.insight.runId, b.current.id); assert.equal(second.insight.previousRunId, null);
  assert.equal(second.insight.telemetry.totalTokens, 0); assert.equal(second.insight.telemetry.estimatedCostUsd, 0);
  assert.deepEqual(second.insight.sections, first.insight.sections);
  assert.deepEqual(rows.get(a.current.id), originalA, "Reading a shared diagnostic cannot mutate its source run");
  assert.deepEqual(rows.get(b.current.id)!.advisorInsight, second.insight);
  assert.ok(!JSON.stringify(second).includes(a.current.id), "A shared response must not expose another run's identity");
  for (const session of [SESSION_B, SESSION_C]) {
    const foreign = await (await POST(request(a, session))).json();
    assert.equal(foreign.persistence.status, "pending");
    assert.deepEqual(rows.get(a.current.id), originalA, "Foreign requests cannot update another session's insight");
  }
  assert.equal(calls, 1);
  const reads = stats.reads, writes = stats.writes;
  assert.equal((await POST(request(a, ""))).status, 400);
  assert.equal(stats.reads, reads); assert.equal(stats.writes, writes);
  rows.clear();
  const afterDeletion = await (await POST(request(b, SESSION_B))).json();
  assert.equal(afterDeletion.insight.source, "cached", "Deleting runs does not evict the global Advisor cache");
  assert.equal(afterDeletion.persistence.status, "pending"); assert.equal(calls, 1);
});

test("client-supplied run insights cannot populate or poison the shared Advisor cache", async t => {
  const { rows, entries } = repository(t); let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return response(); });
  const first = await (await POST(request(fixture()))).json();
  entries.clear();
  rows.get(fixture().current.id)!.advisorInsight = { ...first.insight, sections: { ...sections,
    routingDiagnosis: "This client-supplied diagnostic must never be served as shared generated output.",
  } };
  const other = fixture(); other.current.id = "4d9c09fa-7843-4c63-9d2b-556f74c4e5ac";
  const result = await (await POST(request(other, SESSION_B))).json();
  assert.equal(result.insight.source, "gemini"); assert.equal(calls, 2);
  assert.equal(result.insight.sections.routingDiagnosis, sections.routingDiagnosis);
});

test("automatic client tokens scope Advisor writes across reloads and sessions without partitioning the global cache", async t => {
  const { rows } = repository(t);
  const values = new Map<string, string>();
  const browser = { sessionStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } } };
  const a = createSessionClient(() => browser);
  const b = createSessionClient(() => ({ get sessionStorage(): Storage { throw new Error("Storage blocked"); } }));
  const first = fixture(), second = fixture(); second.current.id = "4d9c09fa-7843-4c63-9d2b-556f74c4e5ac";
  rows.set(first.current.id, { sessionId: a.getSessionId(), advisorInsight: null });
  rows.set(second.current.id, { sessionId: b.getSessionId(), advisorInsight: null });
  let providerCalls = 0;
  const tokens: (string | null)[] = [];
  t.mock.method(globalThis, "fetch", async (path: RequestInfo | URL, options?: RequestInit) => {
    if (String(path).startsWith("/api/")) {
      const wire = new Request(`http://localhost${path}`, options); tokens.push(readRunSession(wire));
      return path === "/api/advisor" ? POST(wire) : analyzeTelemetry(wire);
    }
    assert.equal(new Headers(options?.headers).has(RUN_SESSION_HEADER), false, "Session tokens stay on same-origin API requests");
    providerCalls++; return response();
  });
  const insightA = await (await a.fetch("/api/advisor", { method: "POST", body: JSON.stringify(first) })).json();
  const insightB = await (await b.fetch("/api/analyze-telemetry", { method: "POST", body: JSON.stringify(second) })).json();
  assert.equal(insightA.persistence.status, "saved"); assert.equal(insightB.persistence.status, "saved");
  assert.equal(insightA.insight.source, "gemini"); assert.equal(insightB.insight.source, "cached");
  assert.equal(insightB.insight.runId, second.current.id); assert.equal(insightB.insight.telemetry.totalTokens, 0);
  const reloaded = createSessionClient(() => browser);
  const again = await (await reloaded.fetch("/api/advisor", { method: "POST", body: JSON.stringify(first) })).json();
  assert.equal(again.insight.source, "cached"); assert.equal(again.persistence.status, "saved");
  assert.deepEqual(tokens, [a.getSessionId(), b.getSessionId(), a.getSessionId()]);
  assert.notEqual(tokens[0], tokens[1]); assert.equal(providerCalls, 1);
  assert.equal(rows.get(first.current.id)!.advisorInsight!.runId, first.current.id);
  assert.equal(rows.get(second.current.id)!.advisorInsight!.runId, second.current.id);
});

test("concurrent sessions share generation and bind current and previous UUIDs to each caller", async t => {
  const { rows } = repository(t); let calls = 0;
  const a = validateAdvisorRequest(fixture()), b = validateAdvisorRequest(fixture());
  const aPrevious = structuredClone(a.current), bPrevious = structuredClone(b.current);
  aPrevious.id = "4d9c09fa-7843-4c63-9d2b-556f74c4e5ad";
  b.current.id = "4d9c09fa-7843-4c63-9d2b-556f74c4e5ac";
  bPrevious.id = "4d9c09fa-7843-4c63-9d2b-556f74c4e5ae";
  rows.set(a.current.id, { sessionId: SESSION_A, advisorInsight: null });
  rows.set(b.current.id, { sessionId: SESSION_B, advisorInsight: null });
  let release!: () => void, started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  t.mock.method(globalThis, "fetch", async () => {
    calls++; started(); await new Promise<void>(resolve => { release = resolve; }); return response();
  });
  const first = POST(request({ ...a, previous: aPrevious }, SESSION_A)); await ready;
  const second = POST(request({ ...b, previous: bPrevious }, SESSION_B));
  await new Promise(resolve => setTimeout(resolve, 0)); release();
  const [resultA, resultB] = await Promise.all([first.then(r => r.json()), second.then(r => r.json())]);
  assert.equal(calls, 1); assert.equal(resultB.insight.telemetry.shared, true);
  assert.equal(resultB.insight.telemetry.totalTokens, 0);
  for (const [result, current, previous] of [[resultA, a.current, aPrevious], [resultB, b.current, bPrevious]] as const) {
    assert.equal(result.insight.runId, current.id); assert.equal(result.insight.previousRunId, previous.id);
    assert.equal(result.persistence.status, "saved");
    assert.equal(rows.get(current.id)!.advisorInsight!.runId, current.id);
  }
  const cachedB = await (await POST(request({ ...b, previous: bPrevious }, SESSION_B))).json();
  assert.equal(cachedB.insight.source, "cached"); assert.equal(cachedB.insight.previousRunId, bPrevious.id);
  assert.equal(calls, 1);
});

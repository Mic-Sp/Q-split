import assert from "node:assert/strict";
import { test } from "node:test";
import { POST } from "@/app/api/advisor/route";
import { deterministicInsight, parseAdvisorInsight } from "./advisor";
import { createRunRecord, serializeRun } from "./run-record";
import type { CompletedRun } from "@/types/run-history";
import type { SimulationRun } from "@/generated/prisma/client";

const fixture = (): CompletedRun => ({
  id: "4d9c09fa-7843-4c63-9d2b-556f74c4e5ab", completedAt: "2026-10-26T16:00:00.000Z",
  request: { workload_id: "shors_crypto", scale_param: 2048, hardware_profile: "ibm_heron_nisq", available_qubits: 4096 },
  telemetry: { workload_id: "shors_crypto", workload_name: "Shor", scale_label: "RSA-2048", execution_mode: "NISQ_ANALYTICAL_PROFILER", primary_bottleneck: "INSUFFICIENT QPU QUBIT CAPACITY", stages: {
    stage_1_classical_pre: { name: "Preprocess", node: "CPU", latency_ms: 1.32, status: "OPTIMAL", output_summary: "Ready", metrics: {} },
    stage_2_quantum_kernel: { name: "Kernel", node: "QPU", latency_ms: 0, status: "CRITICAL_BOTTLENECK", output_summary: "Blocked", metrics: { available_qubits: 4096, qubits_allocated: 0, minimum_qubits_required: 4099, qubits_required: 4099, circuit_depth: 0, parallelization_tier: "Blocked · insufficient capacity", depth_complexity: "Not executed", coherence_survival_pct: 0, execution_feasible: false } },
    stage_3_classical_post: { name: "Postprocess", node: "CPU", latency_ms: 0, status: "CRITICAL_BOTTLENECK", output_summary: "Starved", metrics: {} },
  } },
});
const request = (body: unknown) => new Request("http://localhost/api/advisor", { method: "POST", body: JSON.stringify(body) });

test("deterministic diagnostics prioritize real blocking causes and compare the previous run", () => {
  const current = fixture();
  const previous = fixture(); previous.id = "4d9c09fa-7843-4c63-9d2b-556f74c4e5ac";
  const insight = deterministicInsight(current, previous, "missing_key");
  assert.equal(insight.source, "fallback");
  assert.equal(insight.previousRunId, previous.id);
  assert.match(insight.sections.optimizationRecommendation, /4,099/);
  assert.match(insight.sections.routingDiagnosis, /Δ 0 ms/);
  assert.deepEqual(insight.sections, deterministicInsight(current, previous, "missing_key").sections);
  current.telemetry.stages.stage_1_classical_pre.node = "QPU";
  assert.match(deterministicInsight(current, undefined, "missing_key").sections.optimizationRecommendation, /Move classical preprocessing/);
  current.telemetry.stages.stage_1_classical_pre.node = "CPU";
  current.telemetry.stages.stage_2_quantum_kernel.node = "GPU";
  assert.match(deterministicInsight(current, undefined, "rate_limited").sections.optimizationRecommendation, /CPU\/GPU statevector RAM/);
});

test("insights serialize independently from telemetry and are bound to their run", () => {
  const current = fixture();
  current.advisorInsight = deterministicInsight(current, undefined, "rate_limited");
  const record = createRunRecord(current);
  const saved = serializeRun({ ...record, createdAt: new Date() } as SimulationRun);
  assert.deepEqual(saved.advisorInsight, current.advisorInsight);
  assert.deepEqual(record.telemetry, current.telemetry);
  assert.throws(() => parseAdvisorInsight({ ...current.advisorInsight, runId: "another-run" }, current.id));
  assert.throws(() => parseAdvisorInsight({ ...current.advisorInsight, sections: {} }, current.id));
  assert.throws(() => parseAdvisorInsight({ ...current.advisorInsight, source: "gemini" }, current.id));
});

test("advisor route handles Gemini success, missing keys, limits, timeouts, and malformed responses", async (t) => {
  const priorKey = process.env.GEMINI_API_KEY;
  const priorModel = process.env.GEMINI_MODEL;
  let behavior = "success";
  let calls = 0;
  const sections = { routingDiagnosis: "The QPU stage is blocked by insufficient capacity.", spaceTimeTradeOff: "4,096 is below the 4,099-qubit minimum.", optimizationRecommendation: "Try 6,144 qubits for Windowed Parallel." };
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    calls++;
    assert.equal(url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent");
    assert.equal((options.headers as Record<string, string>)["x-goog-api-key"], "test-server-secret");
    const body = JSON.parse(String(options.body));
    assert.match(body.systemInstruction.parts[0].text, /Principal Quantum-Classical Systems Architect/);
    const context = JSON.parse(body.contents[0].parts[0].text);
    assert.equal(context.current.request.available_qubits, 4096);
    assert.equal(context.current.request.routing.stage_2_node, "QPU");
    assert.ok(context.previous);
    assert.equal(body.generationConfig.responseMimeType, "application/json");
    if (behavior === "network") throw new Error("test-server-secret");
    if (behavior === "timeout") throw new DOMException("secret timeout detail", "TimeoutError");
    if (behavior === "429" || behavior === "503") return Response.json({ error: "test-server-secret" }, { status: Number(behavior) });
    return Response.json({ candidates: [{ finishReason: behavior === "truncated" ? "MAX_TOKENS" : "STOP", content: { parts: [{ text: JSON.stringify(behavior === "malformed" ? {} : sections) }] } }] });
  });
  try {
    delete process.env.GEMINI_API_KEY;
    let response = await POST(request({ current: fixture() }));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).insight.fallbackReason, "missing_key");
    assert.equal(calls, 0);
    process.env.GEMINI_API_KEY = "test-server-secret";
    process.env.GEMINI_MODEL = "gemini-3.5-flash-lite";
    for (const [mode, expected] of [["success", null], ["429", "rate_limited"], ["503", "provider_error"], ["timeout", "timeout"], ["network", "network_error"], ["truncated", "invalid_response"], ["malformed", "invalid_response"]]) {
      behavior = mode!;
      response = await POST(request({ current: fixture(), previous: fixture() }));
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("Cache-Control"), "no-store");
      const result = await response.json();
      assert.equal(result.insight.fallbackReason, expected);
      assert.equal(result.insight.source, mode === "success" ? "gemini" : "fallback");
      assert.ok(!JSON.stringify(result).includes("test-server-secret"));
    }
    assert.equal((await POST(request({}))).status, 400);
    assert.equal((await POST(request({ current: fixture(), previous: {} }))).status, 400);
    assert.equal((await POST(new Request("http://localhost/api/advisor", { method: "POST", headers: { "Content-Length": "262145" }, body: "{}" }))).status, 413);
  } finally {
    if (priorKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = priorKey;
    if (priorModel === undefined) delete process.env.GEMINI_MODEL; else process.env.GEMINI_MODEL = priorModel;
  }
});

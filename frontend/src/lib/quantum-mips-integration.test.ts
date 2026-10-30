import { apiRequest, parseAdvisorPrompt } from "./test-support/api";
import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { POST as simulateProxy } from "@/app/api/simulate/route";
import { POST as advisorProxy } from "@/app/api/analyze-telemetry/route";
import { validateAdvisorRequest, advisorDigest } from "./advisor-input";
import { deterministicInsight } from "./advisor";
import { createRunRecord, serializeRun } from "./run-record";
import { restoredConfiguration } from "./benchmark-snapshot";
import { benchmarkCsv, benchmarkJson } from "./benchmark-export";
import { benchmarkComparison } from "./benchmark-comparison";
import { offloadVerdict } from "./offload-verdict";
import { parseTelemetry, describeChanges } from "./telemetry";
import { WORKLOADS, workloadThresholds } from "./workloads";
import type { CompletedRun, SavedSimulationRun } from "@/types/run-history";
import type { SimulationRun } from "@/generated/prisma/client";

const python = resolve("../backend/venv/bin/python");

// Integrates the actual backend model with the Next proxy, advisor trust boundary,
// benchmark serialization/restore, and numeric exports. No network or database.
test("actual Quantum-MIPS backend payloads survive frontend proxy/advisor/history across 1,620 configurations", { skip: !existsSync(python) }, async t => {
  const generated = spawnSync(python, ["-c", `
import itertools, json
from functools import lru_cache
from backend import main
main.execute_live_quantum_mips_64 = lru_cache(maxsize=1)(main.execute_live_quantum_mips_64)
runs = []
for scale, profile, tier, nodes in itertools.product(main.QUANTUM_MIPS_SCALES, main.HARDWARE_PROFILES, range(3), itertools.product(["CPU", "GPU", "QPU"], repeat=3)):
    thresholds = main.quantum_mips_qubit_thresholds(scale)
    capacity = [thresholds["minimum_qubits_required"], thresholds["windowed_qubits_required"], thresholds["ceiling_qubits_required"]][tier]
    request = dict(workload_id="quantum_mips", scale_param=scale, hardware_profile=profile, available_qubits=capacity,
        routing=dict(zip(["stage_1_node", "stage_2_node", "stage_3_node"], nodes)))
    data = main.run_quantum_mips_pipeline(scale, profile, main.RoutingConfig(**request["routing"]), capacity)
    runs.append(dict(request=request, telemetry=data.model_dump()))
print(json.dumps(runs))
`], { cwd: resolve(".."), encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  assert.equal(generated.status, 0, generated.stderr);
  const fixtures = JSON.parse(generated.stdout) as Pick<CompletedRun, "request" | "telemetry">[];
  assert.equal(fixtures.length, 1620);
  let expected: typeof fixtures[number];
  t.mock.method(globalThis, "fetch", async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    assert.deepEqual(JSON.parse(String(init?.body)), expected.request);
    return Response.json(expected.telemetry);
  });
  const representatives: SavedSimulationRun[] = [];
  for (const [index, fixture] of fixtures.entries()) {
    expected = fixture;
    const proxy = await simulateProxy(new Request("http://localhost/api/simulate", { method: "POST", body: JSON.stringify(fixture.request) }));
    assert.equal(proxy.status, 200, JSON.stringify(fixture.request));
    assert.deepEqual(parseTelemetry(await proxy.json()), fixture.telemetry);
    const run: CompletedRun = { ...fixture, id: `c367fe2e-f083-4996-8cbd-${String(index).padStart(12, "0")}`, completedAt: "2026-10-27T12:00:00.000Z" };
    const validated = validateAdvisorRequest({ current: run }).current;
    assert.equal(validated.request.workload_id, "quantum_mips");
    assert.match(validated.telemetry.scale_label, /^M =/);
    assert.match(validated.telemetry.stages.stage_2_quantum_kernel.name, /Grover’s search \/ amplitude amplification/);
    const insight = deterministicInsight(validated, undefined, "missing_key");
    assert.doesNotMatch(Object.values(insight.sections).join(" "), /RSA-|Carry-Lookahead|period finding|2n \+ 3/);
    assert.match(insight.sections.spaceTimeTradeOff, /Multi-Oracle/);
    assert.equal(advisorDigest(run).request.scale_param, run.request.scale_param);
    const record = createRunRecord({ ...run, advisorInsight: insight });
    const saved = serializeRun({ ...record, createdAt: new Date(run.completedAt), snapshotName: "MIPS test", isSnapshot: true,
      snapshotUpdatedAt: null } as unknown as SimulationRun);
    assert.deepEqual(restoredConfiguration(saved), run.request);
    const verdict = offloadVerdict(run.telemetry, run.request);
    assert.match(verdict.message, /Grover.*Multi-Oracle/);
    if (run.request.scale_param === 64) assert.match(verdict.message, /CPU → QPU → CPU/);
    else assert.match(verdict.message, /GPU → QPU → GPU/);
    if (run.request.scale_param >= 1024 && verdict.title === "Interconnect Dominated") {
      assert.doesNotMatch(verdict.message, /CPU placement for short host routines/);
    }
    const kernel = run.telemetry.stages.stage_2_quantum_kernel;
    if (kernel.node !== "QPU" && kernel.metrics.execution_feasible === false && run.request.routing?.stage_1_node !== "QPU" && run.request.routing?.stage_3_node !== "QPU") {
      assert.equal(verdict.title, "Classical Memory Wall");
      assert.match(verdict.message, /Select the Sequential tier/);
    }
    if (index % 324 === 0) representatives.push(saved);
  }
  const json = JSON.parse(benchmarkJson(representatives)) as SavedSimulationRun[];
  assert.deepEqual(json.map(run => run.request.workload_id), Array(5).fill("quantum_mips"));
  assert.deepEqual(json.map(run => run.request.scale_param), WORKLOADS.quantum_mips.scales);
  for (const run of json) assert.equal(typeof run.telemetry.stages.stage_2_quantum_kernel.latency_ms, "number");
  assert.match(benchmarkCsv(representatives), /Quantum-MIPS/);
  assert.doesNotMatch(benchmarkCsv(representatives), /RSA-/);
  assert.equal(benchmarkComparison(representatives.slice(0, 3)).length, 3);
  const first = representatives[0], last = representatives[4];
  assert.ok(describeChanges({ id: first.id, completedAt: first.completedAt, request: first.request, data: first.telemetry },
    { id: last.id, completedAt: last.completedAt, request: last.request, data: last.telemetry }).some(change => change.label === "Scale" && change.after.startsWith("M =")));
});

test("Quantum-MIPS advisor alias preserves trusted model facts and returns a zero-cost fallback offline", async () => {
  const priorKey = process.env.GEMINI_API_KEY, priorDb = process.env.DATABASE_URL;
  delete process.env.GEMINI_API_KEY; delete process.env.DATABASE_URL;
  try {
    for (const scale of WORKLOADS.quantum_mips.scales) {
      const run = mipsRun(scale);
      const response = await advisorProxy(apiRequest("http://localhost/api/analyze-telemetry", { method: "POST", body: JSON.stringify({ current: run }) }));
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.insight.source, "fallback");
      assert.equal(body.insight.telemetry.estimatedCostUsd, 0);
      assert.match(body.insight.sections.routingDiagnosis, scale === 64 ? /CPU → QPU → CPU/ : /GPU → QPU → GPU/);
      assert.match(body.insight.sections.spaceTimeTradeOff, /O\(√M\).*NISQ/);
    }
  } finally {
    if (priorKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = priorKey;
    if (priorDb === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = priorDb;
  }
});

function mipsRun(scale: number): CompletedRun {
  const minimum = workloadThresholds(scale, "quantum_mips").minimum;
  return { id: "c367fe2e-f083-4996-8cbd-000000000001", completedAt: "2026-10-27T12:00:00.000Z",
    request: { workload_id: "quantum_mips", scale_param: scale, hardware_profile: "ideal_sim", available_qubits: minimum },
    telemetry: { workload_id: "quantum_mips", workload_name: "Quantum-MIPS", scale_label: `M = ${scale}`, execution_mode: "NISQ_ANALYTICAL_PROFILER", primary_bottleneck: "NONE", stages: {
      stage_1_classical_pre: { name: "LSH", node: "CPU", latency_ms: 0.25, status: "OPTIMAL", output_summary: "", metrics: {} },
      stage_2_quantum_kernel: { name: "Grover", node: "QPU", latency_ms: 0.1, status: "OPTIMAL", output_summary: "", metrics: { available_qubits: minimum, qubits_required: minimum, qubits_allocated: minimum, coherence_survival_pct: 100, parallelization_tier: "Sequential Minimum", execution_feasible: true } },
      stage_3_classical_post: { name: "FP16", node: "CPU", latency_ms: 0.18, status: "OPTIMAL", output_summary: "", metrics: {} },
    } } };
}

test("simulation proxy rejects invalid workloads before lookup and reports backend outages gracefully", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; throw new TypeError("offline"); });
  const request = (body: unknown) => new Request("http://localhost/api/simulate", { method: "POST", body: JSON.stringify(body) });
  assert.equal((await simulateProxy(request({ ...mipsRun(64).request, scale_param: 15 }))).status, 400);
  assert.equal(calls, 0);
  assert.equal((await simulateProxy(request(mipsRun(64).request))).status, 502);
  assert.equal(calls, 1);
});

test("live advisor requests include Quantum-MIPS policy and scale-specific suggested experiments", async t => {
  const priorKey = process.env.GEMINI_API_KEY, priorDb = process.env.DATABASE_URL;
  process.env.GEMINI_API_KEY = "unit-test-key"; delete process.env.DATABASE_URL;
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls++;
    const body = JSON.parse(String(init?.body));
    const policy = body.systemInstruction.parts[0].text;
    assert.match(policy, /CPU → QPU → CPU.*M=64/);
    assert.match(policy, /GPU → QPU → GPU/);
    assert.match(policy, /Multi-Oracle Ceiling 4k\+16/);
    assert.match(policy, /selected ancilla tier/);
    assert.match(policy, /not actual inner products/);
    const context = parseAdvisorPrompt(body.contents[0].parts[0].text);
    assert.equal(context.current.request.workload_id, "quantum_mips");
    assert.match(context.suggestedNextExperiment, /GPU → QPU → GPU.*0.12×.*0.10×/);
    return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({
      routingDiagnosis: "The CPU host stages can be compared with GPU placement at this candidate scale.",
      spaceTimeTradeOff: "Multi-Oracle uses extra ancilla qubits to reduce modeled Grover circuit depth.",
      optimizationRecommendation: "Try GPU placement for LSH pruning and FP16 reranking while keeping the quantum route fixed.",
    }) }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 40, totalTokenCount: 140 } });
  });
  try {
    const response = await advisorProxy(apiRequest("http://localhost/api/analyze-telemetry", { method: "POST", body: JSON.stringify({ current: mipsRun(1024) }) }));
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.insight.source, "gemini");
    assert.equal(result.insight.telemetry.totalTokens, 140);
    assert.equal(calls, 1);
  } finally {
    if (priorKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = priorKey;
    if (priorDb === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = priorDb;
  }
});

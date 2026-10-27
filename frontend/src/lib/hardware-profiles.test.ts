import assert from "node:assert/strict";
import { test } from "node:test";
import { HARDWARE_PROFILE_IDS, type HardwareProfile } from "@/types/telemetry";
import { HARDWARE_PROFILES, hardwareLabel, isHardwareProfile } from "./hardware-profiles";
import { advisorDigest, validateAdvisorRequest } from "./advisor-input";
import { deterministicInsight } from "./advisor";
import { offloadVerdict } from "./offload-verdict";
import { createRunRecord, serializeRun } from "./run-record";
import { restoredConfiguration } from "./benchmark-snapshot";
import { describeChanges, hardwareDefaultQubits, qubitThresholds } from "./telemetry";
import { advisorCacheKey } from "./advisor-cache";
import { POST } from "@/app/api/advisor/route";
import type { CompletedRun } from "@/types/run-history";
import type { SimulationRun } from "@/generated/prisma/client";

function fixture(profile: HardwareProfile): CompletedRun {
  const arch = HARDWARE_PROFILES[profile];
  const depth = Math.ceil(122 * arch.depthMultiplier);
  return { id: "4d9c09fa-7843-4c63-9d2b-556f74c4e5ab", completedAt: "2026-10-27T12:00:00.000Z",
    request: { workload_id: "shors_crypto", scale_param: 21, hardware_profile: profile, available_qubits: 28, routing: { stage_1_node: "CPU", stage_2_node: "QPU", stage_3_node: "CPU" } },
    telemetry: { workload_id: "shors_crypto", workload_name: "Shor", scale_label: "N = 21", execution_mode: "NISQ_ANALYTICAL_PROFILER", primary_bottleneck: "NONE", stages: {
      stage_1_classical_pre: { name: "Pre", node: "CPU", latency_ms: 0.28, status: "OPTIMAL", output_summary: "Ready", metrics: {} },
      stage_2_quantum_kernel: { name: "Kernel", node: "QPU", latency_ms: depth * 0.00025 * arch.gateTimeMultiplier, status: "WARNING", output_summary: "Ready", metrics: {
        available_qubits: 28, qubits_allocated: 28, qubits_required: 13, minimum_qubits_required: 13, circuit_depth: depth, reference_circuit_depth: 122, io_state_prep_ms: arch.prepMs,
        coherence_survival_pct: arch.decayScale === null ? 100 : Math.round(10000 * Math.exp(-depth / arch.decayScale)) / 100,
        parallelization_tier: "Carry-Lookahead Parallel", depth_complexity: "O(n log^2 n)", execution_feasible: true,
        hardware_architecture: profile, connectivity_topology: arch.topology, routing_depth_multiplier: arch.depthMultiplier, gate_time_multiplier: arch.gateTimeMultiplier,
        ...(arch.referenceQubits === null ? {} : { reference_qubits: arch.referenceQubits }), ...(arch.decayScale === null ? {} : { coherence_decay_scale: arch.decayScale }),
        classical_cpu_baseline: { feasible: true, total_ms: 224.59, kernel_ms: 224 },
      } },
      stage_3_classical_post: { name: "Post", node: "CPU", latency_ms: 0.31, status: "OPTIMAL", output_summary: "Ready", metrics: {} },
    } } };
}

test("hardware registry exposes exactly four profiles and explicit comparative assumptions", () => {
  assert.equal(HARDWARE_PROFILE_IDS.length, 4);
  assert.deepEqual(HARDWARE_PROFILE_IDS.map(id => { const arch = HARDWARE_PROFILES[id]; return [arch.referenceQubits, arch.depthMultiplier, arch.gateTimeMultiplier, arch.prepMs, arch.decayScale]; }), [
    [133, 1, 1, 0.15, 1200], [72, 0.78, 0.45, 0.12, 850], [36, 0.55, 180, 0.85, 8500], [null, 1, 1, 0.15, null],
  ]);
  assert.match(HARDWARE_PROFILES.google_weber_grid.description, /72.*exploratory.*53/);
  assert.equal(hardwareLabel("ionq_forte_trapped_ion"), "IonQ Forte (Trapped Ion)");
  for (const value of ["unknown", "google", "__proto__", null, true]) assert.equal(isHardwareProfile(value), false);
});

test("profile selection defaults to native capacity or the current scale's full ideal register", () => {
  for (const [scale, ceiling] of [[15, 22], [21, 28], [35, 33], [512, 2816], [2048, 11264]]) {
    assert.equal(hardwareDefaultQubits("ibm_heron_nisq", scale), 133);
    assert.equal(hardwareDefaultQubits("google_weber_grid", scale), 72);
    assert.equal(hardwareDefaultQubits("ionq_forte_trapped_ion", scale), 36);
    assert.equal(hardwareDefaultQubits("ideal_sim", scale), ceiling);
    assert.ok(hardwareDefaultQubits("ideal_sim", scale) >= qubitThresholds(scale).minimum);
  }
});

test("all architecture requests validate, serialize, restore and export exact saved profile metadata", () => {
  for (const id of HARDWARE_PROFILE_IDS) {
    const run = fixture(id);
    assert.equal(validateAdvisorRequest({ current: run }).current.request.hardware_profile, id);
    const saved = serializeRun({ ...createRunRecord(run), createdAt: new Date() } as SimulationRun);
    assert.equal(saved.hardwareProfile, id);
    assert.deepEqual(saved.telemetry, run.telemetry);
    assert.deepEqual(restoredConfiguration(saved), run.request);
    assert.deepEqual(JSON.parse(JSON.stringify(saved)).telemetry.stages.stage_2_quantum_kernel.metrics.hardware_architecture, id);
  }
  const before = fixture("google_weber_grid"), after = fixture("ionq_forte_trapped_ion");
  const changes = describeChanges({ id: before.id, completedAt: before.completedAt, request: before.request, data: before.telemetry }, { id: after.id, completedAt: after.completedAt, request: after.request, data: after.telemetry });
  assert.deepEqual(changes.find(change => change.label === "Hardware"), { label: "Hardware", before: "Google Weber (2D Grid)", after: "IonQ Forte (Trapped Ion)" });
  assert.ok(changes.some(change => change.label.endsWith("connectivity topology")));
});

test("advisor digests include trusted architecture constants and reject mismatched or arbitrary model metadata", () => {
  const input = { current: fixture("google_weber_grid") };
  const digest = advisorDigest(input.current);
  assert.equal(digest.architecture.depthMultiplier, 0.78);
  assert.equal(digest.architecture.topology, "2D Square Grid");
  assert.equal(digest.telemetry.stages.stage_2_quantum_kernel.metrics.gate_time_multiplier, 0.45);
  const changed = { current: fixture("ionq_forte_trapped_ion") };
  assert.notEqual(advisorCacheKey(input, "model", "policy"), advisorCacheKey(changed, "model", "policy"));
  for (const [key, value] of [["hardware_architecture", "ibm_heron_nisq"], ["connectivity_topology", "All-to-All Ion Trap"], ["gate_time_multiplier", 1], ["routing_depth_multiplier", 0.1], ["coherence_decay_scale", 1200], ["reference_qubits", 133]]) {
    const invalid = structuredClone(input);
    invalid.current.telemetry.stages.stage_2_quantum_kernel.metrics[String(key)] = value;
    assert.throws(() => validateAdvisorRequest(invalid));
  }
});

test("architecture verdicts and fallback explain SWAP savings separately from ion gate-time penalties", () => {
  const google = fixture("google_weber_grid"), ion = fixture("ionq_forte_trapped_ion");
  assert.match(offloadVerdict(google.telemetry, google.request).message, /Square-grid.*0\.78×.*0\.45×.*850/);
  ion.telemetry.stages.stage_2_quantum_kernel.latency_ms = 300;
  const verdict = offloadVerdict(ion.telemetry, ion.request);
  assert.equal(verdict.title, "Trapped-Ion Gate Latency"); assert.equal(verdict.status, "warning");
  assert.match(verdict.message, /180×.*0\.85 ms/);
  const insight = deterministicInsight(ion, google, "missing_key");
  assert.match(insight.sections.spaceTimeTradeOff, /All-to-all.*0\.55×.*180×.*8500/);
  assert.match(insight.sections.routingDiagnosis, /Hardware changed from Google Weber.*IonQ Forte/);
  assert.match(insight.sections.optimizationRecommendation, /Compare Google Weber.*180×/);
  assert.match(deterministicInsight(google, undefined, "missing_key").sections.spaceTimeTradeOff, /SWAP.*0\.78×/);
  ion.request.available_qubits = 12;
  Object.assign(ion.telemetry.stages.stage_2_quantum_kernel.metrics, { available_qubits: 12, qubits_allocated: 0, execution_feasible: false });
  assert.equal(offloadVerdict(ion.telemetry, ion.request).title, "Capacity Blocked");
  assert.match(deterministicInsight(ion, undefined, "missing_key").sections.optimizationRecommendation, /at least 13 qubits/);
});

test("advisor route uses four-profile system facts for live output and deterministic fallback", async t => {
  const oldKey = process.env.GEMINI_API_KEY, oldUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = ""; process.env.GEMINI_API_KEY = "test-key";
  t.after(() => { if (oldKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = oldKey; if (oldUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = oldUrl; });
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => {
    calls++;
    const body = JSON.parse(String(options.body));
    const system = body.systemInstruction.parts[0].text;
    for (const profile of HARDWARE_PROFILE_IDS) assert.ok(system.includes(profile));
    for (const fact of ["0.78x", "0.55x", "180x", "8500", "53 active qubits"]) assert.ok(system.includes(fact));
    const prompt = JSON.parse(body.contents[0].parts[0].text);
    assert.equal(prompt.current.architecture.topology, "All-to-All Ion Trap");
    assert.equal(prompt.previous.architecture.topology, "2D Square Grid");
    return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({
      routingDiagnosis: "CPU to QPU to CPU routing remains unchanged across architectures.",
      spaceTimeTradeOff: "All-to-all connectivity lowers depth but slower ion gates can offset SWAP savings.",
      optimizationRecommendation: "Compare Google Weber at the same capacity and scale to isolate gate-time differences.",
    }) }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 60, totalTokenCount: 160 } });
  });
  const request = (current: CompletedRun, previous?: CompletedRun) => new Request("http://localhost/api/advisor", { method: "POST", body: JSON.stringify({ current, previous }) });
  const response = await POST(request(fixture("ionq_forte_trapped_ion"), fixture("google_weber_grid")));
  assert.equal(response.status, 200); assert.equal((await response.json()).insight.source, "gemini");
  delete process.env.GEMINI_API_KEY;
  for (const profile of ["google_weber_grid", "ionq_forte_trapped_ion"] as const) {
    const result = await (await POST(request(fixture(profile)))).json();
    assert.equal(result.insight.source, "fallback");
    assert.match(result.insight.sections.spaceTimeTradeOff, /SWAP/);
    assert.equal(result.insight.usage.totalTokens, 0);
  }
  assert.equal(calls, 1);
});

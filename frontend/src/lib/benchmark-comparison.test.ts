import assert from "node:assert/strict";
import { test } from "node:test";
import { benchmarkComparison, benchmarkExportRuns, benchmarkMetrics, selectedBenchmarkRuns, toggleBenchmarkSelection } from "./benchmark-comparison";
import { BENCHMARK_CSV_HEADERS, benchmarkCsv, benchmarkJson } from "./benchmark-export";
import type { SavedSimulationRun } from "@/types/run-history";

function fixture(id = "run-1"): SavedSimulationRun {
  return {
    id, completedAt: "2026-10-27T12:00:00.000Z", createdAt: "2026-10-27T12:00:01.000Z", snapshotName: "Baseline", isSnapshot: true, snapshotUpdatedAt: "2026-10-27T12:05:00.000Z",
    workloadId: "shors_crypto", workloadName: "Shor's pipeline", scaleParam: 21, scaleLabel: "N = 21", hardwareProfile: "ibm_heron_nisq",
    stage1Node: "GPU", stage2Node: "QPU", stage3Node: "CPU", executionMode: "NISQ_ANALYTICAL_PROFILER",
    // Legacy persisted summary omits exclusive QPU I/O; exports must match live KPIs instead.
    totalLatencyMs: 3.75, bottleneckStatus: "WARNING", primaryBottleneck: "Interconnect", qubitsRequired: 13, circuitDepth: "38654705664", coherenceSurvivalPct: 70,
    request: { workload_id: "shors_crypto", scale_param: 21, hardware_profile: "ibm_heron_nisq", available_qubits: 28, routing: { stage_1_node: "GPU", stage_2_node: "QPU", stage_3_node: "CPU" } },
    telemetry: { workload_id: "shors_crypto", workload_name: "Shor's pipeline", scale_label: "N = 21", execution_mode: "NISQ_ANALYTICAL_PROFILER", primary_bottleneck: "Interconnect", stages: {
      stage_1_classical_pre: { name: "Pre", node: "GPU", latency_ms: 1.25, status: "WARNING", output_summary: "Ready", metrics: { launch_transfer_overhead_ms: 1 } },
      stage_2_quantum_kernel: { name: "Kernel", node: "QPU", latency_ms: 2, status: "WARNING", output_summary: "Ready", metrics: { io_state_prep_ms: 0.5, io_readout_ms: 0.25, available_qubits: 28, qubits_allocated: 12, parallelization_tier: "Windowed Parallel", circuit_depth: 38654705664, coherence_survival_pct: 70, nested: { phases: [0, 0.5] } } },
      stage_3_classical_post: { name: "Post", node: "CPU", latency_ms: 0.5, status: "OPTIMAL", output_summary: "Ready", metrics: {} },
    } },
    advisorInsight: null,
  };
}

// Independent RFC-style reader verifies complete rows, including multiline diagnostics.
function parseCsv(text: string) {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
    } else if (char === "," && !quoted) { row.push(cell); cell = ""; }
    else if (char === "\r" && text[i + 1] === "\n" && !quoted) { row.push(cell); rows.push(row); row = []; cell = ""; i++; }
    else cell += char;
  }
  assert.equal(quoted, false, "CSV quotes must be balanced");
  return rows;
}

test("selection is ordered, capped at three, deduplicated, and prunes deleted IDs", () => {
  const runs = [1, 2, 3, 4].map(i => fixture(`run-${i}`));
  let ids: string[] = [];
  for (const id of ["run-3", "run-1", "run-2", "run-4"]) ids = toggleBenchmarkSelection(runs, ids, id);
  assert.deepEqual(ids, ["run-3", "run-1", "run-2"]);
  ids = toggleBenchmarkSelection(runs, ids, "run-1");
  assert.deepEqual(toggleBenchmarkSelection(runs, ids, "run-4"), ["run-3", "run-2", "run-4"]);
  assert.deepEqual(selectedBenchmarkRuns(runs, ["missing", "run-2", "run-2", "run-1"]).map(run => run.id), ["run-2", "run-1"]);
  assert.deepEqual(toggleBenchmarkSelection(runs.slice(1), ["run-1", "run-2", "run-3"], "run-4"), ["run-2", "run-3", "run-4"]);
  assert.deepEqual(toggleBenchmarkSelection(runs, [], "missing"), []);
});

test("export chooses checked runs across filters, otherwise exactly the displayed rows", () => {
  const runs = [1, 2, 3, 4, 5, 6].map(i => fixture(`run-${i}`));
  const visible = runs.slice(0, 5);
  assert.deepEqual(benchmarkExportRuns(runs, visible, []), visible);
  assert.deepEqual(benchmarkExportRuns(runs, visible, ["run-6", "run-2"]), [runs[5], runs[1]]);
  assert.deepEqual(benchmarkExportRuns(runs, [], ["run-6"]), [runs[5]]);
  assert.deepEqual(benchmarkExportRuns(runs, visible, ["deleted"]), visible);
  assert.deepEqual(benchmarkExportRuns(runs, [], []), []);
});

test("comparison matrix uses the first run as reference with correct compute, overhead and gate deltas", () => {
  const baseline = fixture(), candidate = fixture("run-2");
  candidate.telemetry.stages.stage_2_quantum_kernel.latency_ms = 1;
  candidate.telemetry.stages.stage_2_quantum_kernel.metrics.coherence_survival_pct = 34;
  candidate.telemetry.stages.stage_2_quantum_kernel.metrics.parallelization_tier = "Sequential";
  candidate.telemetry.stages.stage_2_quantum_kernel.metrics.qubits_allocated = 8;
  candidate.circuitDepth = "38654705764";
  candidate.bottleneckStatus = "CRITICAL_BOTTLENECK"; candidate.primaryBottleneck = "Decoherence";
  const columns = benchmarkComparison([baseline, candidate]);
  assert.equal(columns.length, 2);
  assert.ok(columns[0].metrics.every(metric => metric.delta === null && !metric.changed));
  const metrics = Object.fromEntries(columns[1].metrics.map(metric => [metric.label, metric]));
  assert.equal(metrics["Total latency"].value, "3.50 ms");
  assert.equal(metrics["Total latency"].delta, "−1.00 ms vs reference");
  assert.equal(metrics["Pure compute"].value, "1.75 ms");
  assert.equal(metrics["Interconnect overhead"].delta, "0.00 ms vs reference");
  assert.equal(metrics["Interconnect overhead"].changed, false);
  assert.equal(metrics["Allocated QPU qubits"].delta, "-4 qubits vs reference");
  assert.equal(metrics["Parallel tier"].delta, "Changed from reference");
  assert.equal(metrics["Circuit depth"].delta, "+100 gates vs reference");
  assert.equal(metrics["Coherence survival"].value, "34 % · EXCEEDED");
  assert.equal(metrics["Coherence survival"].delta, "-36 pp vs reference");
  assert.match(metrics["Bottleneck status"].value, /CRITICAL_BOTTLENECK.*Decoherence/);
  assert.equal(metrics["Bottleneck status"].changed, true);
  const reversed = benchmarkComparison([candidate, baseline]);
  assert.equal(reversed[1].metrics[0].delta, "+1.00 ms vs reference");
  assert.deepEqual(benchmarkComparison([]), []);
});

test("matrix handles zero baselines, blocked stages, absent metrics, and classical coherence", () => {
  const zero = fixture();
  for (const stage of Object.values(zero.telemetry.stages)) { stage.latency_ms = 0; stage.metrics.execution_feasible = false; }
  zero.telemetry.stages.stage_2_quantum_kernel.metrics.qubits_allocated = 0;
  const missing = fixture("missing");
  missing.telemetry.stages.stage_2_quantum_kernel.metrics = {}; missing.circuitDepth = null;
  const columns = benchmarkComparison([zero, missing]);
  assert.match(columns[0].metrics[0].value, /^0\.00 ms$/);
  assert.match(columns[0].metrics[7].value, /EXCEEDED/);
  assert.match(columns[1].metrics[0].delta!, /^\+/);
  for (const index of [3, 6, 7]) { assert.match(columns[1].metrics[index].value, /Not reported/); assert.equal(columns[1].metrics[index].delta, null); }
  assert.ok(!JSON.stringify(columns).includes("NaN"));
  const classical = fixture("classical");
  classical.telemetry.stages.stage_2_quantum_kernel.node = "CPU";
  assert.equal(benchmarkMetrics(classical).coherenceSurvival, 100);
  assert.equal(benchmarkMetrics(classical).allocatedQubits, null);
  assert.equal(benchmarkMetrics(classical).parallelTier, "Classical emulation");
  delete classical.request.available_qubits;
  delete classical.telemetry.stages.stage_2_quantum_kernel.metrics.available_qubits;
  assert.equal(benchmarkMetrics(classical).availableQubits, 133);
});

test("comparison retains exact integer circuit depths and tiny latency deltas", () => {
  const baseline = fixture(), candidate = fixture("large");
  baseline.circuitDepth = "9007199254740993"; candidate.circuitDepth = "9007199254740994";
  candidate.telemetry.stages.stage_2_quantum_kernel.latency_ms += 0.000001;
  const column = benchmarkComparison([baseline, candidate])[1];
  assert.equal(column.metrics[6].value, "9,007,199,254,740,994 gates");
  assert.equal(column.metrics[6].delta, "+1 gates vs reference");
  assert.equal(column.metrics[0].delta, "+<0.01 ms vs reference");
  assert.match(column.metrics[0].rawDelta!, /^\+0\.000001/);
});

test("CSV flattens system metrics consistently with KPI math and round-trips Unicode, quotes, commas, and diagnostics", () => {
  const run = fixture();
  run.snapshotName = 'Benchmark, "quoted"\r\nΔ';
  run.advisorInsight = { runId: run.id, previousRunId: null, source: "fallback", model: null, generatedAt: run.completedAt, fallbackReason: "missing_key", notice: null,
    sections: { routingDiagnosis: 'Bus, transfer and "prep"\nacross stages', spaceTimeTradeOff: "Δ qubits", optimizationRecommendation: "Reduce I/O" } };
  const rows = parseCsv(benchmarkCsv([run]));
  assert.deepEqual(rows[0], BENCHMARK_CSV_HEADERS);
  assert.equal(rows.length, 2); assert.equal(rows[1].length, rows[0].length);
  const record = Object.fromEntries(rows[0].map((key, index) => [key, rows[1][index]]));
  assert.equal(record["Snapshot Name"], run.snapshotName);
  assert.equal(record["Timestamp (UTC)"], run.completedAt);
  assert.equal(record.Workload, "Shor's Algorithm");
  assert.equal(record["Pure Compute ms"], "2.75");
  assert.equal(record["Interconnect & State-Prep Overhead ms"], "1.75");
  assert.equal(record["Total Latency ms"], "4.5");
  assert.equal(record["Circuit Depth"], "38654705664");
  assert.equal(record["Available Qubits"], "28"); assert.equal(record["Allocated Qubits"], "12");
  assert.equal(record["Parallel Tier"], "Windowed Parallel");
  assert.equal(record["Coherence Survival %"], "70"); assert.equal(record["Coherence Budget Status"], "NOMINAL");
  assert.equal(record["Stage 1 Node"], "GPU"); assert.equal(record["Stage 2 Node"], "QPU"); assert.equal(record["Stage 3 Node"], "CPU");
  assert.match(record["AI Diagnostic Summary"], /Bus, transfer and "prep"\nacross stages/);
  assert.match(record["AI Diagnostic Summary"], /Reduce I\/O/);
  assert.equal(record["Run ID"], run.id);
});

test("CSV distinguishes zero from missing values, emits headers for empty input, and neutralizes spreadsheet formulas", () => {
  const run = fixture();
  run.snapshotName = '=HYPERLINK("https://example.invalid")';
  run.telemetry.stages.stage_2_quantum_kernel.metrics.qubits_allocated = 0;
  run.telemetry.stages.stage_2_quantum_kernel.metrics.coherence_survival_pct = 0;
  const rows = parseCsv(benchmarkCsv([run]));
  const value = (key: string) => rows[1][rows[0].indexOf(key)];
  assert.equal(value("Allocated Qubits"), "0"); assert.equal(value("Coherence Survival %"), "0");
  assert.equal(value("AI Diagnostic Summary"), "");
  assert.equal(value("Snapshot Name"), `'${run.snapshotName}`);
  for (const name of ["+SUM(1,2)", "-1+2", "@SUM(A1)", " \t=1+1"]) {
    run.snapshotName = name;
    assert.equal(parseCsv(benchmarkCsv([run]))[1][0], `'${name}`);
  }
  assert.deepEqual(parseCsv(benchmarkCsv([])), [BENCHMARK_CSV_HEADERS]);
});

test("JSON export preserves complete payloads, snapshot metadata, token usage, and decimal strings without mutation", () => {
  const run = fixture();
  run.advisorInsight = { runId: run.id, previousRunId: null, source: "gemini", model: "model", generatedAt: run.completedAt, fallbackReason: null, notice: null,
    sections: { routingDiagnosis: "Bus", spaceTimeTradeOff: "Qubits", optimizationRecommendation: "Route" },
    usage: { inputTokens: 123, outputTokens: 45, totalTokens: 168, tokenSource: "provider", estimatedCostUsd: 0.00004545 } };
  const before = structuredClone(run);
  benchmarkCsv([run]);
  const text = benchmarkJson([run]);
  assert.deepEqual(JSON.parse(text), [run]);
  assert.match(text, /\n  \{/); assert.ok(text.endsWith("\n"));
  assert.deepEqual(run, before);
  assert.equal(JSON.parse(text)[0].telemetry.stages.stage_2_quantum_kernel.metrics.nested.phases[1], 0.5);
  assert.equal(benchmarkJson([]), "[]\n");
});

test("large-duration displays do not change numeric millisecond CSV or JSON exports", () => {
  for (const latency of [2_687.44, 151_000, 9_663_805.05, 273_600_000]) {
    const run = fixture();
    for (const stage of Object.values(run.telemetry.stages)) { stage.latency_ms = 0; stage.metrics = {}; }
    run.telemetry.stages.stage_2_quantum_kernel.latency_ms = latency;
    const original = structuredClone(run);
    const display = benchmarkComparison([run])[0].metrics[0];
    assert.doesNotMatch(display.value, /ms$/);
    const csv = parseCsv(benchmarkCsv([run]));
    for (const key of ["Pure Compute ms", "Total Latency ms"]) {
      const value = csv[1][csv[0].indexOf(key)];
      assert.equal(Number(value), latency); assert.match(value, /^\d+(\.\d+)?$/);
    }
    assert.equal(JSON.parse(benchmarkJson([run]))[0].telemetry.stages.stage_2_quantum_kernel.latency_ms, latency);
    assert.deepEqual(run, original);
  }
});

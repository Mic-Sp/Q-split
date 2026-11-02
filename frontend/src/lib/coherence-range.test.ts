import assert from "node:assert/strict";
import { test } from "node:test";
import { coherenceBudget, coherenceRangeLabel, formatSurvivalPercent } from "./kpi-metrics";
import type { StageTelemetry } from "@/types/telemetry";

const stage = (): StageTelemetry => ({ name: "QPU", node: "QPU", latency_ms: 1, status: "OPTIMAL", output_summary: "",
  metrics: { coherence_survival_pct: 80, coherence_survival_best: 0.8, coherence_survival_worst: 0.00011, execution_feasible: true } });

test("point percentage formatting preserves tiny nonzero values", () => {
  for (const value of [1.990308556161859e-6, 1.7192681428902257e-26, 0.00035885857366650177]) {
    assert.match(formatSurvivalPercent(value), /e-/);
  }
  assert.equal(formatSurvivalPercent(0), "0");
  assert.equal(formatSurvivalPercent(100), "100");
  assert.equal(formatSurvivalPercent(34.999999), "34.999999");
  assert.equal(formatSurvivalPercent(69.999999), "69.999999");
  for (const value of [undefined, NaN, Infinity, -1, 101]) assert.equal(formatSurvivalPercent(value), "—");
});

test("coherence classification uses unrounded values at both thresholds", () => {
  const kernel = stage();
  const data = { workload_id: "shors_crypto", workload_name: "Shor", scale_label: "N=21", execution_mode: "NISQ_ANALYTICAL_PROFILER" as const,
    primary_bottleneck: "NONE", stages: { stage_2_quantum_kernel: kernel } };
  for (const [value, expected] of [[34.999999, "EXCEEDED"], [35, "DEGRADED"], [69.999999, "DEGRADED"], [70, "NOMINAL"]] as const) {
    kernel.metrics.coherence_survival_pct = value;
    assert.equal(coherenceBudget(data).status, expected);
    assert.equal(kernel.metrics.coherence_survival_pct, value);
  }
});

test("existing survival displays get bounded percentages without changing the point-based status", () => {
  const kernel = stage();
  assert.equal(coherenceRangeLabel(kernel), "Best / worst case: 80% / 0.011%");
  assert.equal(coherenceBudget({ workload_id: "shors_crypto", workload_name: "Shor", scale_label: "N=21", execution_mode: "NISQ_ANALYTICAL_PROFILER",
    primary_bottleneck: "NONE", stages: { stage_2_quantum_kernel: kernel } }).status, "NOMINAL");
  kernel.metrics.coherence_survival_worst = 1e-20;
  assert.equal(coherenceRangeLabel(kernel), "Best / worst case: 80% / 1.00e-18%");
});

test("legacy, classical, blocked and malformed ranges do not add annotations", () => {
  assert.equal(coherenceRangeLabel(), null);
  for (const node of ["CPU", "GPU"] as const) assert.equal(coherenceRangeLabel({ ...stage(), node }), null);
  for (const overrides of [{ coherence_survival_best: undefined }, { coherence_survival_worst: undefined },
    { execution_feasible: false }, { routing_supported: false }, { qubits_allocated: 0 },
    { coherence_survival_best: 1.1 }, { coherence_survival_worst: -1 }, { coherence_survival_worst: 0.9 },
    { coherence_survival_best: NaN }]) {
    const kernel = stage(); Object.assign(kernel.metrics, overrides);
    assert.equal(coherenceRangeLabel(kernel), null);
  }
  const ideal = stage(); Object.assign(ideal.metrics, { coherence_survival_best: 1, coherence_survival_worst: 1 });
  assert.equal(coherenceRangeLabel(ideal), "Best / worst case: 100% / 100%");
});

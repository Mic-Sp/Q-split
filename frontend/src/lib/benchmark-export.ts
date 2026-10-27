import { ADVISOR_HEADINGS } from "@/types/advisor";
import { benchmarkMetrics } from "@/lib/benchmark-comparison";
import type { SavedSimulationRun } from "@/types/run-history";

export const BENCHMARK_CSV_HEADERS = [
  "Snapshot Name", "Timestamp", "Workload", "Scale", "Hardware Profile", "Available Qubits", "Allocated Qubits", "Parallel Tier",
  "Stage 1 Node", "Stage 2 Node", "Stage 3 Node", "Pure Compute ms", "Interconnect Overhead ms", "Total Latency ms", "Circuit Depth",
  "Coherence Survival %", "Coherence Budget Status", "Primary Bottleneck", "AI Diagnostic Summary", "Bottleneck Status", "Run ID",
];

function csvCell(value: string | number | null) {
  let text = value === null ? "" : String(value);
  // Quoting alone does not stop spreadsheet formula evaluation in text fields.
  if (typeof value === "string" && /^[\s\u0000-\u001f]*[=+@-]/u.test(value)) text = `'${text}`;
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function benchmarkCsv(runs: SavedSimulationRun[]) {
  const rows = runs.map(run => {
    const metrics = benchmarkMetrics(run);
    const insight = run.advisorInsight;
    const summary = insight ? (Object.keys(ADVISOR_HEADINGS) as (keyof typeof ADVISOR_HEADINGS)[])
      .map(key => `${ADVISOR_HEADINGS[key]}: ${insight.sections[key]}`).join("\n\n") : null;
    return [run.snapshotName, run.completedAt, run.workloadName, run.scaleLabel, run.hardwareProfile,
      metrics.availableQubits, metrics.allocatedQubits, metrics.parallelTier,
      run.stage1Node, run.stage2Node, run.stage3Node, metrics.computeMs, metrics.overheadMs, metrics.totalMs, metrics.circuitDepth,
      metrics.coherenceSurvival, metrics.coherenceStatus, run.primaryBottleneck, summary, run.bottleneckStatus, run.id];
  });
  return [BENCHMARK_CSV_HEADERS, ...rows].map(row => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

export function benchmarkJson(runs: SavedSimulationRun[]) {
  // Keep the original structured request, telemetry, advisor usage, and metadata.
  return JSON.stringify(runs, null, 2) + "\n";
}

export function downloadBenchmark(runs: SavedSimulationRun[], format: "csv" | "json") {
  const content = format === "csv" ? "\uFEFF" + benchmarkCsv(runs) : benchmarkJson(runs);
  const blob = new Blob([content], { type: format === "csv" ? "text/csv;charset=utf-8" : "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `q-split-benchmarks-${new Date().toISOString().replaceAll(/[:.]/g, "-")}.${format}`;
  try {
    document.body.append(link);
    link.click();
  } finally {
    link.remove();
    // Leave time for the browser to consume the URL before releasing the Blob.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { SkqdControls } from "@/components/skqd-controls";
import { SkqdFamilyDiagnostics, SkqdClassicalDiagnostics } from "@/components/skqd-diagnostics";
import { StructuredTelemetryDetails } from "@/components/structured-telemetry-details";
import { InverseDesignPanel } from "@/components/inverse-design-panel";
import { skqdDraft } from "@/lib/skqd";
import type { CompletedRun } from "@/types/run-history";

function fixture(): CompletedRun {
  const result = spawnSync(resolve("../backend/venv/bin/python"), ["-B", "-c", `
from backend.main import SimulationRequest, simulate_workload
r = SimulationRequest(workload_id="skqd", hardware_profile="ideal_sim", scale_param=85)
import json
print(json.dumps(dict(request=r.model_dump(), telemetry=simulate_workload(r).model_dump())))
`], { cwd: resolve(".."), encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return { ...JSON.parse(result.stdout), id: "c367fe2e-f083-4996-8cbd-000000000001", completedAt: "2026-11-18T12:00:00.000Z" };
}

describe("SKQD cockpit rendering", () => {
  it("renders bounded draft controls and effective subspace cap", () => {
    const html = renderToStaticMarkup(createElement(SkqdControls, { draft: skqdDraft(), onChange: () => {}, qubits: 12 }));
    expect(html).toContain("Krylov dimension d");
    expect(html).toContain("Trotter steps per power m");
    expect(html).toContain("Shots per Krylov state");
    expect(html).toContain("Retained subspace dimension R");
    expect(html).toContain("4,096 states");
    expect(html).toContain('min="2" max="15"');
    expect(html).toContain('min="1000" max="1000000"');
    const invalid = renderToStaticMarkup(createElement(SkqdControls, { draft: { ...skqdDraft(), krylov_dimension: "16" }, onChange: () => {}, qubits: 22 }));
    expect(invalid).toContain('aria-invalid="true"');
  });
  it("renders per-power depth, gate counts and shot-aware survival alongside Stage 3 runtime/memory", () => {
    const run = fixture(), kernel = run.telemetry.stages.stage_2_quantum_kernel;
    const html = renderToStaticMarkup(createElement(SkqdFamilyDiagnostics, { metrics: kernel.metrics }));
    expect(html).toContain("Shot-weighted mean");
    expect(html).toContain("Deepest-member survival");
    expect(html).toContain("Expected surviving samples");
    for (const column of ["Logical depth", "Native depth", "Native 2Q", "Shot duration", "Worst T2", "Log survival"]) expect(html).toContain(column);
    expect(html.match(/<tr/g)?.length).toBe(6);
    expect(html).toContain("1.75 µs");
    expect(html).not.toContain("0.00 ms");
    const post = renderToStaticMarkup(createElement(SkqdClassicalDiagnostics, { stage: run.telemetry.stages.stage_3_classical_post }));
    expect(post).toContain("Classical diagonalization bound");
    expect(post).toContain("Subspace peak memory");
    expect(post).toContain("Lanczos / Davidson");
    expect(post).toContain("complex128");
    const details = renderToStaticMarkup(createElement(StructuredTelemetryDetails, { metrics: kernel.metrics }));
    expect(details).toContain("Krylov family diagnostics");
    expect(details).toContain("Krylov power diagnostics");
    const inverse = renderToStaticMarkup(createElement(InverseDesignPanel, { run }));
    expect(inverse).toContain("Unavailable for multi-circuit Krylov families");
    expect(inverse).not.toContain("Apply Target Recipe");
  });
});

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { GqeControls } from "@/components/gqe-controls";
import { GqeStageDiagnostics, GqeLoopDiagnostics } from "@/components/gqe-diagnostics";
import { StructuredTelemetryDetails } from "@/components/structured-telemetry-details";
import { InverseDesignPanel } from "@/components/inverse-design-panel";
import { TargetScales } from "@/components/target-scales";
import { GQE_FIELDS, GQE_SURVIVAL_SCOPE, gqeDraft, editGqeDraft, changeGqePreset } from "@/lib/gqe";
import type { CompletedRun } from "@/types/run-history";

function fixture(middle: "QPU" | "CPU" | "GPU" = "QPU"): CompletedRun {
  const result = spawnSync(resolve("../backend/venv/bin/python"), ["-B", "-c", `
from backend.main import SimulationRequest, simulate_workload
import json
r = SimulationRequest(workload_id="gqe", hardware_profile="ideal_sim", scale_param=10, gqe={"training_mode":"pretrained_finetune"}, routing={"stage_1_node":"GPU","stage_2_node":"${middle}","stage_3_node":"CPU"})
print(json.dumps(dict(request=r.model_dump(), telemetry=simulate_workload(r).model_dump())))
`], { cwd: resolve(".."), encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return { ...JSON.parse(result.stdout), id: "c367fe2e-f083-4996-8cbd-000000000001", completedAt: "2026-11-18T12:00:00.000Z" };
}

describe("GQE cockpit rendering", () => {
  it("renders both modes, all bounded controls and molecule presets", () => {
    const html = renderToStaticMarkup(createElement(GqeControls, { draft: changeGqePreset(gqeDraft(), 10, "pretrained_finetune"), onChange: () => {}, qubits: 10 }));
    for (const field of GQE_FIELDS) {
      expect(html).toContain(field.label);
      expect(html).toContain(`min="${field.min}" max="${field.max}"`);
    }
    expect(html).toContain("Online From-Scratch");
    expect(html).toContain("Pretrained Fine-Tuning");
    expect(html).toContain("Historical offline pretraining is a separate reference cost");
    const invalid = renderToStaticMarkup(createElement(GqeControls, { draft: editGqeDraft(gqeDraft(), "epochs", ""), onChange: () => {}, qubits: 4 }));
    expect(invalid).toContain('aria-invalid="true"');
    expect(invalid).toContain("Complete the bounded fields");
    const scales = renderToStaticMarkup(createElement(TargetScales, { workload: "gqe", scale: 4, onSelect: () => {} }));
    for (const label of ["4-qubit H2 STO-3G", "10-qubit LiH Active Space", "12-qubit BeH2 / N2 Active Space"]) expect(scales).toContain(label);
  });
  it("renders serial categories, AI memory, epoch multiplicities and excluded historical cost", () => {
    const run = fixture(), stages = Object.values(run.telemetry.stages);
    const first = renderToStaticMarkup(createElement(GqeStageDiagnostics, { stage: stages[0], index: 0 }));
    for (const text of ["Autoregressive generation", "Historical offline pretraining reference", "excluded from active run latency", "Model weights", "Gradients", "AdamW + FP32 master", "Inference KV cache", "Training activations / logits", "Replay buffer", "Operator pool", "separate devices"]) expect(first).toContain(text);
    const post = renderToStaticMarkup(createElement(GqeStageDiagnostics, { stage: stages[2], index: 2 }));
    for (const text of ["Logit-matching gradients", "Replay buffer updates", "Cross-device synchronization"]) expect(post).toContain(text);
    const quantum = renderToStaticMarkup(createElement(GqeStageDiagnostics, { stage: stages[1], index: 1 }));
    for (const text of ["Total shots", "Logical depth / native depth", "QPU launch total", "pre-measurement state"]) expect(quantum).toContain(text);
    const loop = renderToStaticMarkup(createElement(GqeLoopDiagnostics, { data: run.telemetry }));
    expect(loop).toContain("Update/Train (Stage 3)");
    expect(loop).toContain("200 epochs");
    expect(loop).toContain(GQE_SURVIVAL_SCOPE);
    expect(loop).toContain("AI / QPU");
    expect(loop).toContain("Reused CPU statevector");
    const details = renderToStaticMarkup(createElement(StructuredTelemetryDetails, { metrics: stages[0].metrics }));
    expect(details).toContain("Transformer model provenance");
    expect(details).toContain("Coexisting AI memory");
    const custom = structuredClone(run); custom.request.hardware_profile = "custom";
    expect(renderToStaticMarkup(createElement(InverseDesignPanel, { run: custom }))).toContain(GQE_SURVIVAL_SCOPE);
    const blocked = structuredClone(stages[2]); blocked.metrics.execution_feasible = false;
    expect(renderToStaticMarkup(createElement(GqeStageDiagnostics, { stage: blocked, index: 2 }))).toContain("no epoch loop executed");
  });
  it("labels classical emulation depth and launch costs without presenting them as native QPU diagnostics", () => {
    const run = fixture("GPU"), kernel = run.telemetry.stages.stage_2_quantum_kernel;
    const html = renderToStaticMarkup(createElement(GqeStageDiagnostics, { stage: kernel, index: 1 }));
    expect(html).toContain("not reported on classical route");
    expect(html).toContain("Classical epoch launch / transfer");
    expect(html).toContain("QPU evaluation comparison");
    expect(renderToStaticMarkup(createElement(GqeLoopDiagnostics, { data: run.telemetry }))).toContain("Representative logical depth");
  });

});

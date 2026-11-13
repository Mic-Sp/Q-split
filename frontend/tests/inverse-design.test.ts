import { beforeAll, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
vi.mock("server-only", () => ({}));
import { applyInverseDesignRecipe, evaluateInverseCircuit, inverseDesignTargets } from "@/lib/inverse-design";
import { cloneBuiltinProfile, customProfileDraft, customProfileFromDraft, encodeCustomPresets, readCustomPresets, saveCustomPreset } from "@/lib/custom-profile";
import { applySurfaceCodeParameters, calculateSurfaceCode, SURFACE_CODE_DEFAULTS } from "@/lib/surface-code";
import { advisorDigest, validateAdvisorRequest } from "@/lib/advisor-input";
import { deterministicInsight } from "@/lib/advisor";
import { createRunRecord, serializeRun } from "@/lib/run-record";
import { restoredConfiguration } from "@/lib/benchmark-snapshot";
import type { CircuitSpec, CustomQPUProfileSpec, SimulationRequest } from "@/types/telemetry";
import type { CompletedRun } from "@/types/run-history";
import type { SimulationRun } from "@/generated/prisma/client";

const spec: CircuitSpec = { n_qubits: 20, depth: 1000, n_1q: 3000, n_2q: 2000, n_meas: 20, stage1_ms: 1, stage3_ms: 1 };
const base = () => cloneBuiltinProfile("ibm_nighthawk_r3_dual");
function fixture(profile: CustomQPUProfileSpec = base(), circuit = spec, config?: SimulationRequest["interconnect"]): CompletedRun {
  const f = evaluateInverseCircuit(circuit, profile, config);
  const metrics = { qpu_profile: { ...profile, id: "custom", provenance: { base_profile_id: profile.base_profile_id } },
    circuit_spec: circuit, resource_model_version: 2, execution_feasible: true, n_2q: f.N2, circuit_depth: f.depth,
    t_circuit_us: f.circuit_us, transfers_per_shot: f.transfers_per_shot, scheduled_transfer_rounds: f.scheduled_transfer_rounds,
    link_time_ns: f.link_time_ns, coherence_log_survival: Number.isFinite(f.point_log) ? f.point_log : null,
    coherence_survival_pct: f.survival * 100, log_survival_terms: Object.fromEntries(Object.entries(f.terms).map(([k, v]) => [k, Number.isFinite(v) ? v : null])) };
  return { id: "4d9c09fa-7843-4c63-9d2b-556f74c4e5a0", completedAt: "2026-11-12T12:00:00.000Z",
    request: { workload_id: "shors_crypto", scale_param: 21, hardware_profile: "custom", available_qubits: 16,
      custom_profile: profile, interconnect: config, routing: { stage_1_node: "CPU", stage_2_node: "QPU", stage_3_node: "CPU" } },
    telemetry: { scale_label: "Shor N=21", stages: { stage_1_classical_pre: { node: "CPU" },
      stage_2_quantum_kernel: { node: "QPU", metrics }, stage_3_classical_post: { node: "CPU" } } } } as unknown as CompletedRun;
}
// Source circuit needs enough captured execution capacity, independently of the
// characterization capacity and single/dual placement boundary.
function available(run: CompletedRun, n = 128) { run.request.available_qubits = n; return run; }
function targets(run: CompletedRun) {
  const r = inverseDesignTargets(run);
  expect(r.status, r.status === "unavailable" ? r.reason : "").toBe("available");
  if (r.status !== "available") throw new Error(r.reason);
  return r;
}

it.each([undefined, { placement: "dual" as const }, { placement: "dual" as const, fidelity_scenario: "target_2027" as const, transfer_duration_ns: 80 }])("round-trips both targets through every loss with placement %j", config => {
  const run = available(fixture(base(), spec, config));
  const result = targets(run);
  for (const target of result.targets) {
    expect(target.balanced.status).toBe("verified");
    const applied = applyInverseDesignRecipe(run, target.target_survival);
    const checked = evaluateInverseCircuit(spec, applied.custom_profile!, applied.interconnect);
    expect(checked.survival).toBeCloseTo(target.target_survival, 12);
    expect(checked.worst_survival).toBeLessThan(checked.survival);
    expect(applied.available_qubits).toBe(run.request.available_qubits);
    expect(applied.routing).toEqual(run.request.routing);
    expect(applied.interconnect).toEqual(config);
    expect(checked.circuit_us).toBe(result.source.circuit_us);
    if (config?.placement === "dual") {
      expect(checked.transfers_per_shot).toBeGreaterThan(0);
      if (config.fidelity_scenario === "target_2027") expect(applied.custom_profile!.state_transfer_fidelity).toBe(base().state_transfer_fidelity);
    } else expect(checked.transfers_per_shot).toBe(0);
  }
});

it.each([[null, null], [200, null], [null, 160]] as const)("handles logical mode and nullable lifetime fallback T1=%s T2=%s", (t1, t2) => {
  const run = available(fixture({ ...base(), t1_us: t1, t2_us: t2 }));
  for (const goal of targets(run).targets) {
    const request = applyInverseDesignRecipe(run, goal.target_survival);
    expect(request.custom_profile!.t1_us === null).toBe(t1 === null);
    expect(request.custom_profile!.t2_us === null).toBe(t2 === null);
    const check = evaluateInverseCircuit(spec, request.custom_profile!, request.interconnect);
    expect(check.survival).toBeCloseTo(goal.target_survival, 12);
    expect(check.worst_survival).toBeLessThanOrEqual(check.survival);
  }
});

it("retains finite log information when probability underflows", () => {
  const run = available(fixture(base(), { ...spec, depth: 1e8, n_1q: 1e8, n_2q: 2e8 }));
  const result = targets(run);
  expect(result.source.current_survival).toBe(0);
  expect(Number.isFinite(result.source.current_log_survival)).toBe(true);
  expect(result.targets[0].balanced.status).toBe("verified");
});

it("does not claim a proportional solution to certain failure or worsen an already viable profile", () => {
  const failure = targets(available(fixture({ ...base(), err_2q: 1 })));
  expect(failure.targets[0].balanced.status).toBe("certain_failure");
  expect(JSON.stringify(failure)).not.toContain("NaN");
  const ideal = available(fixture({ ...base(), err_1q: 0, err_2q: 0, err_meas: 0, t1_us: null, t2_us: null }));
  expect(targets(ideal).targets.every(t => t.balanced.status === "already_met")).toBe(true);
  expect(() => applyInverseDesignRecipe(ideal, 0.5)).toThrow();
});

it("does not charge unused operations, link channels or idle_t2 twice", () => {
  const circuit = { ...spec, n_1q: 0, n_meas: 0 };
  const run = available(fixture({ ...base(), err_1q: 1, err_meas: 1 }, circuit));
  const target = targets(run).targets[0];
  expect(target.balanced.status).toBe("verified");
  const request = applyInverseDesignRecipe(run, 0.5);
  expect(request.custom_profile!.err_1q).toBe(1);
  expect(request.custom_profile!.err_meas).toBe(1);
  expect(evaluateInverseCircuit(circuit, request.custom_profile!).survival).toBeCloseTo(0.5, 12);
});

it("detects a single-bottleneck ceiling below the target", () => {
  const goal = targets(available(fixture())).targets[0];
  expect(goal.single_bottleneck.status).toBe("ceiling_below_target");
  expect(goal.single_bottleneck.ceiling_survival).toBeLessThan(0.5);
});

it("reports the infinite-lifetime boundary rather than a finite recipe", () => {
  const run = available(fixture({ ...base(), err_1q: 0, err_2q: 0, err_meas: 0.5 }, { ...spec, n_meas: 1 }));
  const single = targets(run).targets[0].single_bottleneck;
  expect(single.subsystem).toBe("idle_t1");
  expect(single.ceiling_survival).toBe(0.5);
  expect(single.status).toBe("infinite_lifetime_required");
});

it("withholds Apply when a many-transfer fidelity target cannot be represented accurately", () => {
  const run = available(fixture({ ...base(), t1_us: null, t2_us: null }, { ...spec, n_2q: 1e12 }, { placement: "dual" }));
  expect(targets(run).targets[0].balanced.status).toBe("numeric_limits");
  expect(() => applyInverseDesignRecipe(run, 0.5)).toThrow();
});

it.each(["two_qubit", "idle_t1", "interconnect"] as const)("solves isolated %s losses including a certain-failure term", subsystem => {
  const p = { ...base(), err_1q: 0, err_2q: subsystem === "two_qubit" ? 1 : 0, err_meas: 0,
    t1_us: subsystem === "idle_t1" ? 200 : null, t2_us: null, state_transfer_fidelity: subsystem === "interconnect" ? 0.9 : 1 };
  const run = available(fixture(p, spec, { placement: "dual" }));
  const single = targets(run).targets[0].single_bottleneck;
  expect(single.status).toBe("solved");
  expect(single.subsystem).toBe(subsystem);
  if (single.status !== "solved") throw new Error("isolated failed");
  const fixed = { ...p, [single.parameter === "l_coupler_fidelity" ? "state_transfer_fidelity" : single.parameter]: single.value };
  expect(evaluateInverseCircuit(spec, fixed, run.request.interconnect).survival).toBeCloseTo(0.5, 12);
});

it("finds the minimum error-budget distance and separately verifies the whole-circuit alternative", () => {
  const run = available(fixture({ ...base(), err_2q: 0.001 }));
  const goal = targets(run).targets[0], surface = goal.surface_code;
  expect(surface?.status).toBe("verified");
  if (surface?.status !== "verified") throw new Error("no bridge");
  const d = surface.minimum_verified_distance;
  const inputs = { ...SURFACE_CODE_DEFAULTS, logical_qubits_target: run.request.available_qubits! };
  const required = surface.required_logical_2q_error!;
  expect(calculateSurfaceCode({ ...inputs, code_distance_d: surface.minimum_error_distance }).err_2q).toBeLessThanOrEqual(required);
  if (surface.minimum_error_distance > 3) expect(calculateSurfaceCode({ ...inputs, code_distance_d: surface.minimum_error_distance - 2 }).err_2q).toBeGreaterThan(required);
  const applied = applyInverseDesignRecipe(run, 0.5, "surface_code");
  expect(applied.interconnect).toBeUndefined();
  expect(applied.available_qubits).toBe(run.request.available_qubits);
  expect(applied.custom_profile!.surface_code!.code_distance_d).toBe(d);
  expect(applied.custom_profile!.n_physical_qubits).toBe(2 * d * d * run.request.available_qubits!);
  expect(evaluateInverseCircuit(spec, applied.custom_profile!).survival).toBeGreaterThanOrEqual(0.5);
});

it("rejects above-threshold suppression, and does not silently replace a physical error with an optimistic baseline", () => {
  const run = available(fixture({ ...base(), err_2q: 0.02 }));
  expect(targets(run).targets[0].surface_code?.status).toBe("above_threshold");
  expect(() => applyInverseDesignRecipe(run, 0.5, "surface_code")).toThrow();
});

it("requires a larger distance when meeting the 2Q gate budget alone is insufficient", () => {
  const run = available(fixture({ ...base(), err_1q: 0, err_2q: 0.001 }, { ...spec, n_1q: 1e9 }));
  const surface = targets(run).targets[0].surface_code;
  expect(surface?.status).toBe("verified");
  if (surface?.status !== "verified") throw new Error("no bridge");
  expect(surface.minimum_verified_distance).toBeGreaterThan(surface.minimum_error_distance);
  const previous = applySurfaceCodeParameters(run.request.custom_profile!, { ...surface.generator, code_distance_d: surface.minimum_verified_distance - 2 });
  expect(evaluateInverseCircuit({ ...spec, n_1q: 1e9 }, previous).survival).toBeLessThan(0.5);
});

it("reports unreachable d<=35 for a demanding physical profile", () => {
  const run = available(fixture({ ...base(), err_2q: 0.009 }));
  expect(targets(run).targets[0].surface_code?.status).toBe("unreachable_in_range");
});

it("clears stale generator provenance on arbitrary balanced rate edits, preserves it for surface-code alternatives and local presets", () => {
  const generated = applySurfaceCodeParameters(base(), { ...SURFACE_CODE_DEFAULTS, code_distance_d: 15, logical_qubits_target: 128 });
  const run = available(fixture(generated));
  const applied = applyInverseDesignRecipe(run, 0.8);
  expect(applied.custom_profile!.surface_code).toBeUndefined();
  expect(customProfileFromDraft(customProfileDraft(applied.custom_profile!))).toEqual(applied.custom_profile);
  const preset = readCustomPresets(encodeCustomPresets(saveCustomPreset([], applied.custom_profile!)))[0].spec;
  expect(preset).toEqual(applied.custom_profile);
  const alternative = applyInverseDesignRecipe(run, 0.8, "surface_code");
  expect(alternative.custom_profile!.surface_code).toBeDefined();
});

it.each(["circuit_spec", "log_survival_terms", "qpu_profile", "n_2q"])("disables Apply for missing historical resources: %s", key => {
  const run = available(fixture()); delete run.telemetry.stages.stage_2_quantum_kernel.metrics[key];
  expect(inverseDesignTargets(run).status).toBe("unavailable");
  expect(() => applyInverseDesignRecipe(run, 0.5)).toThrow();
});

it("refuses blocked, inconsistent or forged telemetry", () => {
  for (const [key, value] of [["execution_feasible", false], ["n_2q", 99], ["t_circuit_us", 999], ["coherence_survival_pct", 50]] as const) {
    const run = available(fixture()); Object.assign(run.telemetry.stages.stage_2_quantum_kernel.metrics, { [key]: value });
    expect(inverseDesignTargets(run).status).toBe("unavailable");
  }
  expect(inverseDesignTargets(fixture()).status).toBe("unavailable");
  const mismatch = available(fixture()); mismatch.request.routing!.stage_2_node = "CPU";
  expect(inverseDesignTargets(mismatch).status).toBe("unavailable");
});

it("restores captured execution capacity from telemetry rather than assuming profile capacity", () => {
  const run = available(fixture(), 1040);
  delete run.request.available_qubits;
  run.telemetry.stages.stage_2_quantum_kernel.metrics.available_qubits = 1040;
  expect(targets(run).source.transfers_per_shot).toBe(0);
  expect(applyInverseDesignRecipe(run, 0.5).available_qubits).toBe(1040);
});

const python = resolve("../backend/venv/bin/python");
function backend(request: SimulationRequest) {
  const out = spawnSync(python, ["-c", "import sys; from backend.main import SimulationRequest, simulate_workload; print(simulate_workload(SimulationRequest.model_validate_json(sys.stdin.read())).model_dump_json())"], { cwd: resolve(".."), encoding: "utf8", input: JSON.stringify(request) });
  expect(out.status, out.stderr).toBe(0); return JSON.parse(out.stdout);
}
describe("real Python forward verification, advisor and persistence", () => {
  let runs: CompletedRun[];
  beforeAll(() => {
    const out = spawnSync(python, ["-c", `
import json
from backend.main import SimulationRequest, simulate_workload
from backend.profiles import HARDWARE_PROFILES
samples=[]
for index,(base,scale,workload,placement) in enumerate([
 ("ibm_nighthawk_r2",21,"shors_crypto","auto"),
 ("ibm_nighthawk_r3_dual",21,"shors_crypto","dual"),
 ("ibm_nighthawk_r3_dual",512,"shors_crypto","auto"),
 ("ibm_nighthawk_r3_dual",1024,"quantum_mips","dual"),
 ("ftqc_surface_code",512,"shors_crypto","auto")]):
    fields=HARDWARE_PROFILES[base].model_dump(exclude={"id","provenance"})
    fields.update(name="Inverse experiment "+str(index),base_profile_id=base)
    request=dict(workload_id=workload,scale_param=scale,hardware_profile="custom",available_qubits=1200 if base=="ftqc_surface_code" else fields["n_qubits_max"],custom_profile=fields)
    if fields["module_count"]==2: request["interconnect"]=dict(placement=placement,fidelity_scenario="target_2027",transfer_duration_ns=80.)
    telemetry=simulate_workload(SimulationRequest(**request)).model_dump()
    samples.append(dict(id="4d9c09fa-7843-4c63-9d2b-556f74c4e5a"+str(index),completedAt="2026-11-12T12:00:00.000Z",request=request,telemetry=telemetry))
print(json.dumps(samples))
`], { cwd: resolve(".."), encoding: "utf8" });
    expect(out.status, out.stderr).toBe(0); runs = JSON.parse(out.stdout);
  });
  it("replays real Shor21, forced-dual, RSA512 and MIPS circuits to 50/80% in the backend", () => {
    for (const run of runs) {
      const result = targets(run);
      for (const goal of result.targets) {
        if (goal.balanced.status === "already_met") continue;
        if (goal.balanced.status === "numeric_limits") {
          expect(run.request.scale_param).toBe(512);
          expect(result.source.transfers_per_shot).toBeGreaterThan(1e6);
          expect(() => applyInverseDesignRecipe(run, goal.target_survival)).toThrow();
          continue;
        }
        expect(goal.balanced.status, JSON.stringify({ scale: run.request.scale_param, hardware: run.request.custom_profile!.base_profile_id, goal })).toBe("verified");
        const request = applyInverseDesignRecipe(run, goal.target_survival);
        const response = backend(request);
        expect(response.stages.stage_2_quantum_kernel.metrics.coherence_survival_pct).toBeCloseTo(goal.target_survival * 100, 8);
      }
    }
  });
  it("validates resources idempotently, recomputes the digest and grounds offline recommendations", () => {
    const parsed = validateAdvisorRequest({ current: runs[0], inverse_design_targets: { err_2q: 0.5 } }).current;
    expect(advisorDigest(parsed).inverse_design_targets).toEqual(inverseDesignTargets(runs[0]));
    const insight = deterministicInsight(parsed, undefined, "missing_key");
    expect(insight.sections.optimizationRecommendation).toContain("50% per-shot T1 point");
    expect(insight.sections.optimizationRecommendation).toContain("readout error");
    expect(insight.sections.optimizationRecommendation).toContain("survival ceiling");
  });
  it("restores applied recipes from saved runs without changing their circuit or losing precision", () => {
    const request = applyInverseDesignRecipe(runs[1], 0.8);
    const run = { ...runs[1], request, telemetry: backend(request) };
    const saved = serializeRun({ ...createRunRecord(run), createdAt: new Date() } as SimulationRun);
    const restored = restoredConfiguration(saved);
    expect(restored.custom_profile).toEqual(request.custom_profile);
    expect(restored.interconnect).toEqual(request.interconnect);
    expect(backend(restored).stages.stage_2_quantum_kernel.metrics.coherence_survival_pct).toBeCloseTo(80, 8);
  });
});

import { beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
vi.mock("server-only", () => ({}));
import { calculateSurfaceCode, applySurfaceCodeParameters, parseSurfaceCodeMetadata, SURFACE_CODE_DEFAULTS } from "@/lib/surface-code";
import { clearEditedSurfaceCode, cloneBuiltinProfile, customProfileDraft, customProfileFromDraft, encodeCustomPresets, parseCustomProfile, readCustomPresets, saveCustomPreset } from "@/lib/custom-profile";
import { parseSimulationRequest } from "@/lib/workloads";
import { advisorDigest, validateAdvisorRequest } from "@/lib/advisor-input";
import { deterministicInsight } from "@/lib/advisor";
import { createRunRecord, serializeRun } from "@/lib/run-record";
import { restoredConfiguration } from "@/lib/benchmark-snapshot";
import { benchmarkCsv, benchmarkJson } from "@/lib/benchmark-export";
import { describeChanges } from "@/lib/telemetry";
import type { SurfaceCodeInputs } from "@/types/telemetry";
import type { CompletedRun } from "@/types/run-history";
import type { SimulationRun } from "@/generated/prisma/client";

const reference = { ...SURFACE_CODE_DEFAULTS, logical_qubits_target: 1024 };

it("matches the reference timings/errors while exposing the raw round proxy and exact rotated footprint", () => {
  const result = calculateSurfaceCode(reference);
  expect(result).toMatchObject({ t_1q_ns: 1000, t_2q_ns: 27000, t_meas_ns: 27000, t_reset_ns: 1000,
    err_1q: 1e-10, err_2q: 1e-9, err_meas: 1e-9, is_below_threshold: true,
    physical_qubits_per_logical: 1458, total_physical_qubits: 1492992,
    nighthawk_r3_modules_required: 2872, physical_element_equivalent_modules: 735 });
  expect(Math.abs(result.logical_error_per_round / 1e-15 - 1)).toBeLessThan(1e-12);
  expect(result.logical_error_suppression_ratio).toBe(1e6);
});

it.each([0.001, 0.0037, Number.MIN_VALUE])("monotonically improves round and calibrated error below threshold at p=%s, including the floor", p => {
  let previous = calculateSurfaceCode({ ...reference, physical_2q_error: p, code_distance_d: 3 });
  for (let d = 5; d <= 35; d += 2) {
    const next = calculateSurfaceCode({ ...reference, physical_2q_error: p, code_distance_d: d });
    expect(next.logical_error_per_round).toBeLessThanOrEqual(previous.logical_error_per_round);
    expect(next.err_2q).toBeLessThanOrEqual(previous.err_2q);
    expect(next.err_1q).toBeLessThanOrEqual(previous.err_1q);
    expect(next.total_physical_qubits).toBeGreaterThan(previous.total_physical_qubits);
    expect(next.t_2q_ns).toBeGreaterThan(previous.t_2q_ns);
    previous = next;
  }
});

it("flags inversion above threshold and no exponential improvement exactly at threshold", () => {
  const above = [3, 7, 15, 27, 35].map(d => calculateSurfaceCode({ ...reference, code_distance_d: d, physical_2q_error: 0.011 }));
  expect(above.every(row => !row.is_below_threshold)).toBe(true);
  expect(above.at(-1)!.logical_error_per_round).toBeGreaterThan(above[0].logical_error_per_round);
  const equal = [3, 15, 35].map(d => calculateSurfaceCode({ ...reference, code_distance_d: d, physical_2q_error: 0.01 }));
  expect(equal.every(row => !row.is_below_threshold)).toBe(true);
  expect(equal[0].logical_error_per_round).toBe(equal[2].logical_error_per_round);
  expect(calculateSurfaceCode({ ...reference, physical_2q_error: 0.0037 }).err_2q).toBeGreaterThan(calculateSurfaceCode(reference).err_2q);
});

it("clamps safely without forming an overflowing physical/threshold ratio", () => {
  const high = calculateSurfaceCode({ ...reference, physical_2q_error: 0.99, threshold_error: Number.MIN_VALUE });
  expect(high.logical_error_per_round).toBe(1); expect(high.err_2q).toBe(1);
  const low = calculateSurfaceCode({ ...reference, physical_2q_error: Number.MIN_VALUE });
  expect(low.logical_error_per_round).toBe(1e-18);
  expect([low.err_1q, low.err_2q, low.logical_error_suppression_ratio, high.logical_error_per_round].every(Number.isFinite)).toBe(true);
  expect(calculateSurfaceCode({ ...reference, syndrome_cycle_ns: 2000 }).err_2q).toBe(1e-9);
  expect(calculateSurfaceCode({ ...reference, syndrome_cycle_ns: 2000 }).t_2q_ns).toBe(54000);
});

it.each([
  ["code_distance_d", 2], ["code_distance_d", 4], ["code_distance_d", 3.5], ["code_distance_d", true],
  ["physical_2q_error", 0], ["physical_2q_error", 1], ["physical_2q_error", NaN], ["physical_2q_error", "0.001"],
  ["threshold_error", 0], ["threshold_error", 1], ["threshold_error", Infinity],
  ["syndrome_cycle_ns", 0], ["syndrome_cycle_ns", -1], ["syndrome_cycle_ns", true], ["syndrome_cycle_ns", 1e308],
  ["logical_qubits_target", 0], ["logical_qubits_target", 1.5], ["logical_qubits_target", 2147483648],
  ["code_distance_d", 9007199254740991],
])("rejects invalid or unrepresentable input %s=%s", (field, value) => {
  expect(() => calculateSurfaceCode({ ...reference, [field]: value } as SurfaceCodeInputs)).toThrow();
});

it("applies logical parameters without carrying physical links, pacing or geometry into logical capacity", () => {
  const custom = applySurfaceCodeParameters(cloneBuiltinProfile("ibm_nighthawk_r3_dual"), reference);
  const parsed = parseSimulationRequest({ workload_id: "shors_crypto", scale_param: 21, hardware_profile: "custom", custom_profile: custom, available_qubits: 1024 });
  expect(parsed.custom_profile).toMatchObject({ n_qubits_max: 1024, n_physical_qubits: 1492992, module_count: 1,
    qubits_per_module: null, repetition_rate_hz: null, l_couplers_active: 0, l_couplers_installed: 0,
    state_transfer_fidelity: null, t1_us: null, t2_us: null, native_2q_per_cx: 1, topology_factor: 1,
    surface_code: { model_version: 1, code_distance_d: 27, physical_qubits_per_logical: 1458 } });
  expect(customProfileFromDraft(customProfileDraft(custom))).toEqual(parsed.custom_profile);
  expect(readCustomPresets(encodeCustomPresets(saveCustomPreset([], custom)))[0].spec).toEqual(parsed.custom_profile);
});

it("retains provenance for identity edits and clears it after changing generated physics", () => {
  const draft = customProfileDraft(applySurfaceCodeParameters(cloneBuiltinProfile("ftqc_surface_code"), reference));
  expect(clearEditedSurfaceCode(draft, { ...draft, name: "Renamed research" }).surface_code).toEqual(draft.surface_code);
  expect(clearEditedSurfaceCode(draft, { ...draft, err_2q: "1e-9" }).surface_code).toEqual(draft.surface_code);
  const edited = clearEditedSurfaceCode(draft, { ...draft, err_2q: "0.1" });
  expect(edited.surface_code).toBeUndefined(); expect(customProfileFromDraft(edited).err_2q).toBe(0.1);
  expect(() => parseCustomProfile({ ...customProfileFromDraft(draft), err_2q: 0.1 })).toThrow();
  expect(() => parseSurfaceCodeMetadata({ ...calculateSurfaceCode(reference).metadata, physical_qubits_per_logical: 1000 })).toThrow();
  expect(() => parseSurfaceCodeMetadata({ ...calculateSurfaceCode(reference).metadata, model_version: 2 })).toThrow();
});

const python = resolve("../backend/venv/bin/python");
describe.skipIf(!existsSync(python))("backend mirror and persisted generator", () => {
  let run: CompletedRun;
  beforeAll(() => {
    const custom = applySurfaceCodeParameters(cloneBuiltinProfile("ftqc_surface_code"), reference);
    const request = { workload_id: "shors_crypto", scale_param: 21, hardware_profile: "custom", custom_profile: custom, available_qubits: 1024 };
    const process = spawnSync(python, ["-c", "import json,sys; from backend.main import SimulationRequest,simulate_workload; request=json.load(sys.stdin); print(json.dumps(dict(request=request,telemetry=simulate_workload(SimulationRequest(**request)).model_dump())))"],
      { cwd: resolve(".."), input: JSON.stringify(request), encoding: "utf8" });
    expect(process.status, process.stderr).toBe(0);
    run = { ...JSON.parse(process.stdout), id: "4d9c09fa-7843-4c63-9d2b-556f74c4e5ab", completedAt: "2026-11-12T12:00:00.000Z" };
  });

  it("mirrors numeric outputs across thresholds, distances and clamp extremes", () => {
    const inputs = [reference, { ...reference, code_distance_d: 3 }, { ...reference, code_distance_d: 35, physical_2q_error: 0.0037 },
      { ...reference, physical_2q_error: 0.011 }, { ...reference, physical_2q_error: Number.MIN_VALUE }, { ...reference, threshold_error: Number.MIN_VALUE }];
    const process = spawnSync(python, ["-c", "import json,sys; from backend.surface_code import surface_code_parameters; print(json.dumps([surface_code_parameters(**item) for item in json.load(sys.stdin)]))"],
      { cwd: resolve(".."), input: JSON.stringify(inputs), encoding: "utf8" });
    expect(process.status, process.stderr).toBe(0);
    const output = JSON.parse(process.stdout);
    inputs.forEach((input, index) => {
      const actual = calculateSurfaceCode(input);
      for (const key of ["err_1q", "err_2q", "logical_error_per_round", "physical_qubits_per_logical", "total_physical_qubits", "nighthawk_r3_modules_required", "t_2q_ns"] as const) {
        expect(Math.abs(actual[key] / output[index][key] - 1)).toBeLessThan(1e-10);
      }
    });
  });

  it("preserves verified generator inputs in advisor, presets, history, exports and immutable restoration", () => {
    const parsed = validateAdvisorRequest({ current: run }).current;
    expect(advisorDigest(parsed).architecture).toMatchObject({ surfaceCode: calculateSurfaceCode(reference).metadata });
    expect(deterministicInsight(parsed, undefined, "missing_key").sections.spaceTimeTradeOff).toContain("Surface code d=27");
    const metrics = run.telemetry.stages.stage_2_quantum_kernel.metrics;
    expect(metrics.log_survival_terms).toMatchObject({ idle_t1: 0, idle_t2: 0 });
    expect(metrics.qpu_profile!.provenance.surface_code).toMatchObject({ code_distance_d: 27, model_version: 1 });
    const saved = serializeRun({ ...createRunRecord(run), createdAt: new Date() } as SimulationRun);
    const restored = restoredConfiguration(saved);
    expect(restored.custom_profile!.surface_code).toEqual(calculateSurfaceCode(reference).metadata);
    restored.custom_profile!.surface_code!.code_distance_d = 7;
    expect(saved.request.custom_profile!.surface_code!.code_distance_d).toBe(27);
    expect(benchmarkCsv([saved])).toContain('""code_distance_d"":27');
    expect(JSON.parse(benchmarkJson([saved]))[0].request.custom_profile.surface_code.code_distance_d).toBe(27);
    const bad = structuredClone(run); bad.telemetry.stages.stage_2_quantum_kernel.metrics.qpu_profile!.surface_code!.code_distance_d = 15;
    expect(() => validateAdvisorRequest({ current: bad })).toThrow();
    const lower = applySurfaceCodeParameters(cloneBuiltinProfile("ftqc_surface_code"), { ...reference, code_distance_d: 15 });
    const deltas = describeChanges({ id: run.id, completedAt: run.completedAt, request: run.request, data: run.telemetry },
      { id: "next", completedAt: run.completedAt, request: { ...run.request, custom_profile: lower }, data: run.telemetry });
    expect(deltas.find(delta => delta.label === "Surface code · code distance d")?.after).toBe("15");
  });
});

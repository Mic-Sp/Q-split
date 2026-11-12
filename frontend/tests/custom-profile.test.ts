import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
vi.mock("server-only", () => ({}));
import { BUILTIN_HARDWARE_PROFILE_IDS, type CustomQPUProfileSpec } from "@/types/telemetry";
import { cloneBuiltinProfile, customProfileDraft, customProfileFromDraft, parseCustomProfile, readCustomPresets, saveCustomPreset, encodeCustomPresets } from "@/lib/custom-profile";
import { parseSimulationRequest } from "@/lib/workloads";
import { advisorDigest, validateAdvisorRequest } from "@/lib/advisor-input";
import { createRunRecord, serializeRun } from "@/lib/run-record";
import { restoredConfiguration } from "@/lib/benchmark-snapshot";
import { benchmarkComparison } from "@/lib/benchmark-comparison";
import { benchmarkCsv, benchmarkJson } from "@/lib/benchmark-export";
import { deterministicInsight } from "@/lib/advisor";
import { describeChanges } from "@/lib/telemetry";
import { POST } from "@/app/api/simulate/route";
import type { CompletedRun } from "@/types/run-history";
import type { SimulationRun } from "@/generated/prisma/client";

afterEach(() => vi.unstubAllGlobals());

it.each(BUILTIN_HARDWARE_PROFILE_IDS)("clones and round-trips every editable parameter from %s", id => {
  const spec = cloneBuiltinProfile(id);
  expect(spec.base_profile_id).toBe(id);
  expect(customProfileFromDraft(customProfileDraft(spec))).toEqual(spec);
  expect(parseSimulationRequest({ workload_id: "shors_crypto", scale_param: 21, hardware_profile: "custom", custom_profile: spec }).custom_profile).toEqual(spec);
});

it.each([
  ["name", ""], ["name", "bad\nlabel"], ["name", "x".repeat(121)], ["n_qubits_max", true], ["err_1q", true],
  ["err_1q", "1e-4"], ["err_2q", 1.01], ["err_meas", -1], ["t1_us", 0], ["t2_us", Infinity],
  ["t_2q_ns", 0], ["t_meas_ns", NaN], ["topology_factor", 0.9], ["native_2q_per_cx", 0.5],
  ["repetition_rate_hz", 0], ["module_count", 3], ["l_couplers_active", 1], ["base_profile_id", "custom"],
])("rejects invalid physical value %s=%s", (field, value) => {
  expect(() => parseCustomProfile({ ...cloneBuiltinProfile("ibm_heron_nisq"), [field]: value })).toThrow();
});

it("accepts scientific notation in drafts and preserves FTQC nulls and independent zero errors", () => {
  const draft = customProfileDraft(cloneBuiltinProfile("ibm_heron_nisq"));
  draft.err_1q = "1e-4"; draft.err_2q = "0"; draft.t1_us = ""; draft.t2_us = "";
  const spec = customProfileFromDraft(draft);
  expect(spec.err_1q).toBe(0.0001); expect(spec.err_2q).toBe(0);
  expect(spec.t1_us).toBeNull(); expect(spec.t2_us).toBeNull();
  draft.err_1q = "1e-"; expect(() => customProfileFromDraft(draft)).toThrow();
});

it("rejects missing, extra, mismatched and inconsistent custom payloads", () => {
  const spec = cloneBuiltinProfile("ibm_heron_nisq");
  expect(() => parseSimulationRequest({ hardware_profile: "custom" })).toThrow();
  expect(() => parseSimulationRequest({ hardware_profile: "ibm_heron_nisq", custom_profile: spec })).toThrow();
  expect(() => parseCustomProfile({ ...spec, id: "spoofed" })).toThrow();
  expect(() => parseCustomProfile({ ...spec, module_count: 2 })).toThrow();
  expect(() => parseCustomProfile({ ...cloneBuiltinProfile("ibm_nighthawk_r3_dual"), n_qubits_max: 1041 })).toThrow();
});

it("saves and loads named presets without erasing zeros, nulls or clone lineage", () => {
  const spec = { ...cloneBuiltinProfile("ftqc_surface_code"), name: "Logical target", err_1q: 0 };
  let presets = saveCustomPreset([], spec);
  expect(readCustomPresets(encodeCustomPresets(presets))[0].spec).toEqual(spec);
  presets = saveCustomPreset(presets, { ...spec, err_2q: 1e-10 });
  expect(presets).toHaveLength(1); expect(presets[0].spec.err_2q).toBe(1e-10);
  expect(() => readCustomPresets("broken json")).toThrow();
  expect(() => readCustomPresets('{"version":1,"presets":[{"spec":{"name":"invalid"}}]}')).toThrow();
});

const python = resolve("../backend/venv/bin/python");
describe.skipIf(!existsSync(python))("real custom backend contract", () => {
  let runs: CompletedRun[];
  beforeAll(() => {
    const generated = spawnSync(python, ["-c", `
import json
from backend.main import SimulationRequest, simulate_workload
from backend.profiles import HARDWARE_PROFILES
samples=[]
for index,(base,logical,placement,scale,workload) in enumerate([
 ("ibm_heron_nisq",False,"auto",21,"shors_crypto"),
 ("ibm_nighthawk_r3_dual",False,"dual",21,"shors_crypto"),
 ("ftqc_surface_code",True,"auto",21,"shors_crypto"),
 ("ibm_nighthawk_r3_dual",False,"auto",512,"shors_crypto"),
 ("ibm_nighthawk_r3_dual",False,"dual",1024,"quantum_mips")]):
    fields=HARDWARE_PROFILES[base].model_dump(exclude={"id","provenance"})
    fields.update(name="Research sample " + str(index),base_profile_id=base,topology_factor=3.0)
    if logical: fields.update(t1_us=None,t2_us=None)
    if fields["module_count"]==2: fields.update(state_transfer_fidelity=0.987,transfer_duration_ns=80.0)
    request=dict(workload_id=workload,scale_param=scale,hardware_profile="custom",available_qubits=fields["n_qubits_max"],custom_profile=fields)
    if fields["module_count"]==2: request["interconnect"]=dict(placement=placement,fidelity_scenario="demonstrated")
    response=simulate_workload(SimulationRequest(**request)).model_dump()
    samples.append(dict(id="4d9c09fa-7843-4c63-9d2b-556f74c4e5a"+str(index),completedAt="2026-11-12T12:00:00.000Z",request=request,telemetry=response))
print(json.dumps(samples))
`], { cwd: resolve(".."), encoding: "utf8" });
    expect(generated.status, generated.stderr).toBe(0); runs = JSON.parse(generated.stdout);
  });

  it("validates custom single, linked, logical, RSA and MIPS runs against embedded physics", () => {
    for (const run of runs) {
      const parsed = validateAdvisorRequest({ current: run }).current;
      const digest = advisorDigest(parsed);
      expect(digest.architecture.label).toBe(run.request.custom_profile!.name);
      expect(digest.architecture).toMatchObject({ userDefined: true, baseProfileId: run.request.custom_profile!.base_profile_id, depthMultiplier: 3 });
      expect(parsed.telemetry.stages.stage_2_quantum_kernel.metrics.qpu_profile!.err_2q).toBe(run.request.custom_profile!.err_2q);
      const sections = deterministicInsight(parsed, undefined, "missing_key").sections;
      expect(sections.spaceTimeTradeOff).toContain(run.request.custom_profile!.name);
      expect(sections.spaceTimeTradeOff).toContain("Baseline:");
    }
    expect(runs[0].telemetry.stages.stage_2_quantum_kernel.metrics.modules_used).toBe(1);
    expect(runs[1].telemetry.stages.stage_2_quantum_kernel.metrics.modules_used).toBe(2);
    expect(runs[1].telemetry.stages.stage_2_quantum_kernel.metrics.selected_transfer_fidelity).toBe(0.987);
    expect(runs[1].telemetry.stages.stage_2_quantum_kernel.metrics.transfer_duration_ns).toBe(80);
    expect(runs[2].telemetry.stages.stage_2_quantum_kernel.metrics.log_survival_terms).toMatchObject({ idle_t1: 0, idle_t2: 0 });
  });

  it("rejects nonfinite or mismatched embedded profiles before advisor and persistence", () => {
    for (const key of ["err_2q", "name", "topology_factor", "module_count"] as const) {
      const bad = structuredClone(runs[1]);
      Object.assign(bad.telemetry.stages.stage_2_quantum_kernel.metrics.qpu_profile!, { [key]: key === "name" ? "Other profile" : 99 });
      expect(() => validateAdvisorRequest({ current: bad })).toThrow();
      expect(() => createRunRecord(bad)).toThrow();
    }
    const bad = structuredClone(runs[0]); bad.telemetry.stages.stage_2_quantum_kernel.metrics.qpu_profile!.t1_us = Infinity;
    expect(() => validateAdvisorRequest({ current: bad })).toThrow();
  });

  it("persists and restores full custom physics without sharing mutable controls", () => {
    for (const run of runs) {
      const saved = serializeRun({ ...createRunRecord(run), createdAt: new Date() } as SimulationRun);
      const restored = restoredConfiguration(saved);
      expect(restored.custom_profile).toEqual(parseCustomProfile(run.request.custom_profile));
      expect(restored.interconnect).toEqual(run.request.interconnect);
      restored.custom_profile!.err_2q = 0;
      expect(saved.request.custom_profile!.err_2q).toBe(run.request.custom_profile!.err_2q);
      expect(JSON.parse(benchmarkJson([saved]))[0].request.custom_profile.name).toBe(run.request.custom_profile!.name);
      expect(benchmarkCsv([saved])).toContain(run.request.custom_profile!.name);
      expect(benchmarkCsv([saved])).toContain(run.request.custom_profile!.base_profile_id!);
    }
  });

  it("shows custom identity and baseline in comparison rows and parameter changes in deltas", () => {
    const saved = runs.slice(0, 2).map(run => serializeRun({ ...createRunRecord(run), createdAt: new Date() } as SimulationRun));
    const columns = benchmarkComparison(saved);
    expect(columns[1].metrics.find(row => row.label === "Research profile")?.value).toBe(runs[1].request.custom_profile!.name);
    expect(columns[1].metrics.find(row => row.label === "Cloned baseline")?.value).toBe("ibm_nighthawk_r3_dual");
    expect(columns[0].metrics.map(row => row.label)).toEqual(columns[1].metrics.map(row => row.label));
    const changes = describeChanges({ id: runs[0].id, completedAt: runs[0].completedAt, request: runs[0].request, data: runs[0].telemetry },
      { id: runs[1].id, completedAt: runs[1].completedAt, request: runs[1].request, data: runs[1].telemetry });
    expect(changes.some(change => change.label === "Custom hardware · transfer duration ns")).toBe(true);
  });

  it("forwards custom configuration through the simulation proxy", async () => {
    const run = runs[1];
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json(run.telemetry)); vi.stubGlobal("fetch", fetcher);
    const response = await POST(new Request("http://localhost/api/simulate", { method: "POST", body: JSON.stringify(run.request) }));
    expect(response.status).toBe(200);
    const forwarded = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(forwarded.custom_profile).toEqual(parseCustomProfile(run.request.custom_profile));
    expect(forwarded.interconnect.placement).toBe("dual");
  });
});

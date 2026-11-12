import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { HARDWARE_GROUPS, MODULAR_QPU_PROFILES, HARDWARE_PROFILES, QUBIT_CAPACITY_PRESETS } from "./hardware-profiles";
import { hardwareDefaultQubits, describeChanges } from "./telemetry";
import { parseSimulationRequest } from "./workloads";
import { advisorDigest, validateAdvisorRequest } from "./advisor-input";
import { createRunRecord, serializeRun } from "./run-record";
import { restoredConfiguration } from "./benchmark-snapshot";
import { benchmarkComparison } from "./benchmark-comparison";
import { BENCHMARK_CSV_HEADERS, benchmarkCsv, benchmarkJson } from "./benchmark-export";
import { pipelineLatencyBuckets } from "./kpi-metrics";
import { interconnectKey, parseInterconnect } from "./interconnect";
import type { CompletedRun } from "@/types/run-history";
import type { SimulationRun } from "@/generated/prisma/client";

const python = resolve("../backend/venv/bin/python");
function fixtures(): CompletedRun[] {
  const generated = spawnSync(python, ["-c", `
import json
from backend.main import run_shors_pipeline, run_quantum_mips_pipeline
samples=[]
for profile,scale,options,workload in [
    ("ibm_nighthawk_r3",21,None,"shors_crypto"),
    ("ibm_nighthawk_r3_dual",21,None,"shors_crypto"),
    ("ibm_nighthawk_r3_dual",21,dict(placement="dual",fidelity_scenario="target_2027",transfer_duration_ns=80.0),"shors_crypto"),
    ("ibm_nighthawk_r3_dual",512,None,"shors_crypto"),
    ("ibm_nighthawk_r3_dual",1024,None,"quantum_mips")]:
    from backend.models import InterconnectConfig
    capacity=520 if profile=="ibm_nighthawk_r3" else 1040
    request=dict(workload_id=workload,scale_param=scale,hardware_profile=profile,available_qubits=capacity)
    if options: request["interconnect"]=options
    pipeline=run_shors_pipeline if workload=="shors_crypto" else run_quantum_mips_pipeline
    samples.append(dict(request=request,telemetry=pipeline(scale,profile,available_qubits=capacity,
        interconnect=InterconnectConfig(**options) if options else None).model_dump()))
print(json.dumps(samples))
`], { cwd: resolve(".."), encoding: "utf8" });
  assert.equal(generated.status, 0, generated.stderr);
  return JSON.parse(generated.stdout).map((run: CompletedRun, index: number) => ({ ...run,
    id: `4d9c09fa-7843-4c63-9d2b-556f74c4e5a${index}`, completedAt: "2026-11-12T12:00:00.000Z" }));
}

test("r3 categories retain IDs, exact system names and usable reference capacities", () => {
  assert.equal(HARDWARE_PROFILES.ibm_nighthawk_r3.label, "IBM Quantum System Two (Nighthawk r3 — 520Q)");
  assert.equal(HARDWARE_PROFILES.ibm_nighthawk_r3_dual.label, "IBM Quantum System Two (2x Nighthawk r3 Linked — 1,040Q)");
  assert.equal(hardwareDefaultQubits("ibm_nighthawk_r3", 512), 520);
  assert.equal(hardwareDefaultQubits("ibm_nighthawk_r3_dual", 512), 1040);
  assert.ok(QUBIT_CAPACITY_PRESETS.includes(520) && QUBIT_CAPACITY_PRESETS.includes(1040));
  const ids = HARDWARE_GROUPS.flatMap(group => group.ids);
  assert.equal(new Set(ids).size, 8);
  assert.ok(ids.includes("ibm_nighthawk_r3_dual"));
});

test("link request controls are strict, defaulted and never silently dropped", () => {
  const request = { workload_id: "shors_crypto", scale_param: 21, hardware_profile: "ibm_nighthawk_r3_dual",
    interconnect: { placement: "dual", fidelity_scenario: "target_2027", transfer_duration_ns: 80 } };
  assert.deepEqual(parseSimulationRequest(request).interconnect, request.interconnect);
  assert.equal(interconnectKey(), interconnectKey({ placement: "auto", fidelity_scenario: "demonstrated", transfer_duration_ns: 100 }));
  for (const interconnect of [{ placement: "arbitrary" }, { fidelity_scenario: "measured_r3" }, { transfer_duration_ns: 0 },
    { transfer_duration_ns: true }, { transfer_duration_ns: "100" }, { transfer_duration_ns: Infinity }, { transfer_duration_ns: 1000001 }, { injected: "text" }]) {
    assert.throws(() => parseSimulationRequest({ ...request, interconnect }));
  }
  assert.throws(() => parseInterconnect({}, "ibm_nighthawk_r3"));
});

test("actual backend r3 runs survive advisor, persistence, restoration, comparisons and exports", { skip: !existsSync(python) }, () => {
  const runs = fixtures();
  const saved = runs.map(run => {
    const parsed = validateAdvisorRequest({ current: run }).current;
    const original = run.telemetry.stages.stage_2_quantum_kernel.metrics;
    const metrics = parsed.telemetry.stages.stage_2_quantum_kernel.metrics;
    assert.deepEqual(metrics.log_survival_terms, original.log_survival_terms);
    assert.equal(metrics.transfers_per_shot, original.transfers_per_shot);
    assert.deepEqual(parsed.request.interconnect, run.request.interconnect);
    const digest = advisorDigest(run);
    assert.ok("physicalQubits" in digest.architecture);
    const id = run.request.hardware_profile as keyof typeof MODULAR_QPU_PROFILES;
    assert.equal(digest.architecture.physicalQubits, MODULAR_QPU_PROFILES[id].physicalQubits);
    assert.equal(original.qpu_profile!.n_physical_qubits, MODULAR_QPU_PROFILES[id].physicalQubits);
    assert.equal(original.qpu_profile!.l_couplers_active, MODULAR_QPU_PROFILES[id].activeLCouplers);
    const timing = pipelineLatencyBuckets(run.telemetry);
    assert.equal(timing.quantumMs, original.gate_execution_ms);
    const record = serializeRun({ ...createRunRecord(run), createdAt: new Date() } as SimulationRun);
    assert.deepEqual(restoredConfiguration(record).interconnect, run.request.interconnect);
    assert.equal(JSON.parse(benchmarkJson([record]))[0].telemetry.stages.stage_2_quantum_kernel.metrics.link_time_ns, original.link_time_ns);
    return record;
  });
  assert.equal(runs[1].telemetry.stages.stage_2_quantum_kernel.metrics.modules_used, 1);
  assert.equal(runs[2].telemetry.stages.stage_2_quantum_kernel.metrics.modules_used, 2);
  assert.equal(runs[3].telemetry.stages.stage_2_quantum_kernel.metrics.modules_used, 2);
  assert.equal(runs[4].telemetry.stages.stage_2_quantum_kernel.metrics.modules_used, 1);
  assert.equal(runs[3].telemetry.stages.stage_2_quantum_kernel.metrics.coherence_survival, 0);
  assert.ok(Number.isFinite(runs[3].telemetry.stages.stage_2_quantum_kernel.metrics.coherence_log_survival));
  const columns = benchmarkComparison([saved[1], saved[2]]);
  assert.ok(columns[1].metrics.find(metric => metric.label === "State transfers / shot")?.changed);
  assert.ok(columns[1].metrics.find(metric => metric.label === "Fidelity scenario")?.changed);
  const old = structuredClone(saved[0]);
  delete old.telemetry.stages.stage_2_quantum_kernel.metrics.modules_used;
  const mixed = benchmarkComparison([old, saved[2]]);
  assert.deepEqual(mixed[0].metrics.map(metric => metric.label), mixed[1].metrics.map(metric => metric.label));
  assert.equal(mixed[0].metrics.find(metric => metric.label === "Modules used")?.value, "Not reported");
  const changes = describeChanges({ id: runs[1].id, completedAt: runs[1].completedAt, request: runs[1].request, data: runs[1].telemetry },
    { id: runs[2].id, completedAt: runs[2].completedAt, request: runs[2].request, data: runs[2].telemetry });
  assert.ok(changes.some(change => change.label === "Module placement"));
  assert.ok(changes.some(change => change.label === "Transfer fidelity scenario"));
  const csv = benchmarkCsv([saved[2]]);
  assert.ok(BENCHMARK_CSV_HEADERS.includes("Transfer Fidelity"));
  assert.match(csv, /0\.999/);
  assert.match(csv, /target_2027/);
  const bad = structuredClone(runs[2]); bad.telemetry.stages.stage_2_quantum_kernel.metrics.selected_transfer_fidelity = 0.993;
  assert.throws(() => validateAdvisorRequest({ current: bad }));
  const legacy = structuredClone(runs[0]); delete legacy.telemetry.stages.stage_2_quantum_kernel.metrics.log_survival_terms!.interconnect;
  assert.equal(validateAdvisorRequest({ current: legacy }).current.telemetry.stages.stage_2_quantum_kernel.metrics.log_survival_terms!.interconnect, undefined);
});

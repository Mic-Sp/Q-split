import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { HARDWARE_PROFILES, RESOURCE_QPU_PROFILES, QUBIT_CAPACITY_PRESETS, architectureTradeOff } from "./hardware-profiles";
import { hardwareDefaultQubits } from "./telemetry";
import { advisorDigest, validateAdvisorRequest } from "./advisor-input";
import { pipelineLatencyBuckets } from "./kpi-metrics";
import { createRunRecord, serializeRun } from "./run-record";
import { restoredConfiguration } from "./benchmark-snapshot";
import { deterministicInsight } from "./advisor";
import type { CompletedRun } from "@/types/run-history";
import type { SimulationRun } from "@/generated/prisma/client";

const profile = "ibm_nighthawk_r2";
const python = resolve("../backend/venv/bin/python");

test("Nighthawk selector and trusted resource constants retain units and usable capacity", () => {
  assert.equal(HARDWARE_PROFILES[profile].label, "IBM Quantum System Two (Nighthawk r2)");
  assert.equal(hardwareDefaultQubits(profile, 21), 120);
  assert.ok(QUBIT_CAPACITY_PRESETS.includes(120));
  const p = RESOURCE_QPU_PROFILES[profile];
  assert.equal(p.t2qNs, 40); assert.equal(p.resetNs, 1000); assert.equal(p.repetitionRateHz, 100000);
  assert.equal(p.t1Us, 200); assert.equal(p.t2Us, 160);
  assert.match(architectureTradeOff(profile, 2), /10 µs.*longer circuits/);
  assert.match(architectureTradeOff(profile, 2), /not guaranteed runtime or a depth cutoff/);
});

test("actual Nighthawk responses pass advisor/history/export boundaries without double-billing pacing", { skip: !existsSync(python) }, () => {
  const generated = spawnSync(python, ["-c", `
import json
from backend.main import run_shors_pipeline, run_quantum_mips_pipeline
print(json.dumps([{"request":{"workload_id":workload,"scale_param":scale,"hardware_profile":"ibm_nighthawk_r2","available_qubits":120},
 "telemetry":pipeline(scale,"ibm_nighthawk_r2",available_qubits=120).model_dump()}
 for workload,scale,pipeline in [("shors_crypto",21,run_shors_pipeline),("quantum_mips",1024,run_quantum_mips_pipeline)]]))
`], { cwd: resolve(".."), encoding: "utf8" });
  assert.equal(generated.status, 0, generated.stderr);
  for (const fixture of JSON.parse(generated.stdout)) {
    const run = { ...fixture, id: "4d9c09fa-7843-4c63-9d2b-556f74c4e5ab", completedAt: "2026-11-07T12:00:00.000Z" } as CompletedRun;
    const parsed = validateAdvisorRequest({ current: run }).current;
    const original = run.telemetry.stages.stage_2_quantum_kernel.metrics;
    const m = parsed.telemetry.stages.stage_2_quantum_kernel.metrics;
    assert.equal(m.repetition_delay_ms, original.repetition_delay_ms);
    const digest = advisorDigest(parsed);
    assert.ok("repetitionRateHz" in digest.architecture);
    assert.equal(digest.architecture.repetitionRateHz, 100000);
    const timing = pipelineLatencyBuckets(run.telemetry);
    assert.ok(Math.abs(timing.overheadMs - (original.launch_overhead_ms! + original.measurement_reset_ms!)) < 1e-9);
    assert.equal(timing.quantumMs, original.gate_execution_ms);
    const saved = serializeRun({ ...createRunRecord(run), createdAt: new Date() } as SimulationRun);
    assert.equal(saved.hardwareProfile, profile);
    assert.deepEqual(restoredConfiguration(saved), { ...run.request, routing: { stage_1_node: "CPU", stage_2_node: "QPU", stage_3_node: "CPU" } });
    assert.equal(JSON.parse(JSON.stringify(saved)).telemetry.stages.stage_2_quantum_kernel.metrics.qpu_profile.repetition_rate_hz, 100000);
    assert.match(deterministicInsight(run, undefined, "missing_key").sections.spaceTimeTradeOff, /100 kHz/);
    const bad = structuredClone(run); bad.telemetry.stages.stage_2_quantum_kernel.metrics.reference_qubits = 458;
    assert.throws(() => validateAdvisorRequest({ current: bad }));
  }
});

"use client";

import { useEffect, useReducer, useState } from "react";
import Link from "next/link";
import { PersistentRunHistory } from "@/components/persistent-run-history";
import { ParallelizationTiers } from "@/components/parallelization-tiers";
import { TelemetryAdvisor } from "@/components/telemetry-advisor";
import { LatencyProportion } from "@/components/latency-proportion";
import { OffloadVerdictStrip } from "@/components/offload-verdict";
import { usePersistentRuns } from "@/hooks/use-persistent-runs";
import { coherenceBudget, pipelineTiming, type CoherenceBudgetStatus } from "@/lib/kpi-metrics";
import {
  Activity, ArrowDown, ArrowRight, Check, ChevronDown, CircleAlert, CircuitBoard, Cpu,
  FlaskConical, GitCompareArrows, Layers3, LoaderCircle, Play, Radio, Workflow, Zap,
} from "lucide-react";
import {
  DEFAULT_AVAILABLE_QUBITS, DEFAULT_ROUTING, describeChanges, formatValue, PIPELINE, simulate,
  type Snapshot, type Transition,
} from "@/lib/telemetry";
import type { HardwareProfile, RoutingConfig, SimulationRequest, StageNode, StageStatus, StageTelemetry, WorkloadId } from "@/types/telemetry";

const SCALES = [15, 21, 35, 512, 2048];
const QUBIT_PRESETS = [16, 133, 1121, 2048, 4096, 16384];
const scaleLabel = (scale: number) => scale < 512 ? `N = ${scale}` : `RSA-${scale}`;
const hardwareLabel = (profile: HardwareProfile) => profile === "ideal_sim" ? "Ideal Noise-Free" : "IBM Heron NISQ";
const summaryValue = (value: unknown) => typeof value === "number" && Math.abs(value) >= 1_000_000
  ? new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(value)
  : formatValue(value);
const STATUS = {
  OPTIMAL: { label: "Optimal", text: "text-emerald-400", border: "border-emerald-400/25", background: "bg-emerald-400/10", dot: "bg-emerald-400" },
  WARNING: { label: "Warning", text: "text-amber-300", border: "border-amber-400/30", background: "bg-amber-400/10", dot: "bg-amber-400" },
  CRITICAL_BOTTLENECK: { label: "Critical bottleneck", text: "text-rose-400", border: "border-rose-400/30", background: "bg-rose-400/10", dot: "bg-rose-400" },
} satisfies Record<StageStatus, { label: string; text: string; border: string; background: string; dot: string }>;

const NODE_STYLE = {
  CPU: { icon: Cpu, text: "text-sky-300", frame: "border-sky-400/20 bg-sky-400/10 text-sky-300" },
  GPU: { icon: CircuitBoard, text: "text-cyan-300", frame: "border-cyan-400/20 bg-cyan-400/10 text-cyan-300" },
  QPU: { icon: Layers3, text: "text-violet-300", frame: "border-violet-400/20 bg-violet-400/10 text-violet-300" },
};
const NODES: StageNode[] = ["CPU", "GPU", "QPU"];
const COHERENCE_BUDGET_STYLE: Record<CoherenceBudgetStatus, string> = {
  NOMINAL: "border-emerald-400/25 bg-emerald-400/10 text-emerald-300",
  DEGRADED: "border-amber-400/30 bg-amber-400/10 text-amber-300",
  EXCEEDED: "border-rose-400/30 bg-rose-400/10 text-rose-300",
};
const CAPACITY_PANEL_METRICS = new Set([
  "available_qubits", "qubits_allocated", "idle_qubits", "parallelization_tier",
  "depth_complexity", "parallel_speedup_ceiling_reached",
]);

interface DashboardState {
  loading: boolean;
  slow: boolean;
  error: string | null;
  snapshot: Snapshot | null;
  history: Transition[];
  completed: number;
}
type Action = { type: "start" } | { type: "slow" } | { type: "error"; error: string } | { type: "success"; snapshot: Snapshot };

function reducer(state: DashboardState, action: Action): DashboardState {
  if (action.type === "start") return { ...state, loading: true, slow: false, error: null };
  if (action.type === "slow") return { ...state, slow: true };
  if (action.type === "error") return { ...state, loading: false, slow: false, error: action.error };
  const transition = state.snapshot ? {
    id: state.completed + 1, before: state.snapshot, after: action.snapshot,
    changes: describeChanges(state.snapshot, action.snapshot),
  } : null;
  return {
    loading: false, slow: false, error: null, snapshot: action.snapshot, completed: state.completed + 1,
    history: transition ? [transition, ...state.history].slice(0, 6) : state.history,
  };
}

function StatusBadge({ status }: { status: StageStatus }) {
  const style = STATUS[status];
  return (
    <span className={["inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[10px] font-semibold uppercase tracking-wider", style.text, style.border, style.background].join(" ")}>
      <span className={["size-1.5 rounded-full", style.dot].join(" ")} />{style.label}
    </span>
  );
}

const metricLabels: Record<string, string> = {
  qubits_required: "Logical qubits", circuit_depth: "Circuit depth", io_state_prep_ms: "State preparation · ms",
  coherence_survival_pct: "Coherence survival · %", algorithm: "Algorithm", complexity: "Complexity",
  base_a: "Coprime base", factors_found: "Factors found",
  routing_model: "Latency estimate", routing_supported: "Route supported", execution_feasible: "Execution feasible",
  launch_transfer_overhead_ms: "Launch / transfer · ms", compute_latency_factor: "Compute latency factor",
  simulation_method: "Simulation method", statevector_memory_required: "Statevector memory required",
  statevector_memory_budget_gib: "Memory budget · GiB",
  available_qubits: "Available QPU qubits", qubits_allocated: "Qubits allocated",
  minimum_qubits_required: "Minimum qubits required", idle_qubits: "Idle qubits",
  parallelization_tier: "Parallelization tier", depth_complexity: "Depth scaling",
  parallel_speedup_ceiling_reached: "Parallel speedup ceiling reached", depth_model: "Depth model",
};

function PipelineCard({ index, stage, selectedNode, onNodeChange, pending }: {
  index: number;
  stage?: StageTelemetry;
  selectedNode: StageNode;
  onNodeChange: (node: StageNode) => void;
  pending: boolean;
}) {
  const config = PIPELINE[index];
  const node = selectedNode;
  const nodeStyle = NODE_STYLE[node];
  const NodeIcon = nodeStyle.icon;
  const style = stage ? STATUS[stage.status] : null;
  return (
    <article data-testid={"stage-" + (index + 1)} className={["relative flex h-full min-w-0 flex-col rounded-2xl border bg-slate-900/70 p-5 sm:p-6", style?.border ?? "border-slate-800"].join(" ")}>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <span className="font-mono text-xs tracking-wider text-slate-500">STAGE 0{index + 1}</span>
        {stage ? <StatusBadge status={stage.status} /> : <span className="text-xs text-slate-500">Awaiting telemetry</span>}
      </div>
      <div className="mb-5 flex items-center gap-3">
        <span className={["grid size-11 shrink-0 place-items-center rounded-xl border", nodeStyle.frame].join(" ")}>
          <NodeIcon size={22} />
        </span>
        <div>
          <p data-testid={"stage-node-" + (index + 1)} className={["text-sm font-semibold", nodeStyle.text].join(" ")}>{node}</p>
          <p className="mt-0.5 text-xs text-slate-400">{config.label}</p>
        </div>
      </div>
      <fieldset aria-label={`Stage ${index + 1} node assignment`} className="mb-5 min-w-0">
        <legend className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-slate-400">Run on</legend>
        <div className="grid grid-cols-3 gap-1 rounded-lg border border-slate-800 bg-slate-950 p-1">
          {NODES.map((target) => <button key={target} type="button" aria-pressed={selectedNode === target} onClick={() => onNodeChange(target)} className={["min-h-10 rounded-md px-2 py-2 text-xs font-semibold transition-colors", selectedNode === target ? "bg-cyan-400/15 text-cyan-200 ring-1 ring-inset ring-cyan-400/30" : "text-slate-400 hover:bg-slate-800 hover:text-slate-100"].join(" ")}>{target}</button>)}
        </div>
        <p className="mt-2 min-h-8 text-[10px] leading-4 text-slate-500">{stage && stage.node !== selectedNode ? `Selected ${selectedNode} · showing previous ${stage.node} result` : pending ? "Simulation in progress for the submitted route…" : "Selection applies when you click Run simulation"}</p>
      </fieldset>
      <h3 title={stage?.name ?? config.label} className="min-h-12 line-clamp-2 text-base font-semibold leading-6 text-slate-100 [overflow-wrap:anywhere]">{stage?.name ?? config.label}</h3>
      <div className="my-5 border-y border-slate-800/80 py-4">
        <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">Stage latency</span>
        <p data-testid={"stage-latency-" + (index + 1)} className="mt-1 font-mono text-2xl tracking-tight text-slate-100 [overflow-wrap:anywhere] sm:text-3xl">
          {stage ? formatValue(stage.latency_ms) : "—"}<span className="ml-2 text-sm text-slate-500">ms</span>
        </p>
      </div>
      {stage?.node === "QPU" && typeof stage.metrics.available_qubits === "number" && (
        <div data-testid={`qpu-capacity-${index + 1}`} className="mb-4 rounded-lg border border-cyan-400/20 bg-cyan-400/5 p-3">
          <p className="text-[10px] text-slate-400">Qubits Allocated / Available</p>
          <p className="mt-1 font-mono text-lg text-cyan-200">{formatValue(stage.metrics.qubits_allocated)} / {formatValue(stage.metrics.available_qubits)}</p>
          <p className="mt-2 text-xs font-medium text-cyan-300 [overflow-wrap:anywhere]">{formatValue(stage.metrics.parallelization_tier)}</p>
          <p className="mt-1 text-[10px] leading-5 text-slate-400">{formatValue(stage.metrics.idle_qubits)} idle · {formatValue(stage.metrics.depth_complexity)}{stage.metrics.parallel_speedup_ceiling_reached === true ? " · Speedup ceiling reached" : ""}</p>
        </div>
      )}
      <dl className="mb-6 grid grid-cols-2 gap-2">
        {stage ? Object.entries(stage.metrics).filter(([key]) => !CAPACITY_PANEL_METRICS.has(key) && key !== "classical_cpu_baseline").map(([key, value]) => (
          <div key={key} className="min-w-0 rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2.5">
            <dt className="text-[10px] leading-4 text-slate-400 [overflow-wrap:anywhere]">{metricLabels[key] ?? key.replaceAll("_", " ")}</dt>
            <dd className={["mt-1 font-mono text-xs leading-5 [overflow-wrap:anywhere]", key === "coherence_survival_pct" ? style?.text : "text-slate-200"].join(" ")}>{key === "routing_model" ? "Illustrative estimate" : typeof value === "boolean" ? value ? "Yes" : "No" : formatValue(value)}</dd>
          </div>
        )) : <div className={["col-span-2 h-24 rounded-lg bg-slate-800/40", pending ? "animate-pulse" : ""].join(" ")} aria-hidden="true" />}
      </dl>
      <div className="mt-auto rounded-lg bg-slate-950/70 p-3.5">
        <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">Stage output</p>
        <p className="text-xs leading-6 text-slate-400 [overflow-wrap:anywhere]">
          {stage?.output_summary ?? "Run a simulation to inspect this stage’s output and hardware metrics."}
        </p>
      </div>
    </article>
  );
}

export default function Home() {
  const persistentHistory = usePersistentRuns();
  const { saveRun } = persistentHistory;
  const [workload, setWorkload] = useState<WorkloadId>("shors_crypto");
  const [scale, setScale] = useState(15);
  const [hardware, setHardware] = useState<HardwareProfile>("ibm_heron_nisq");
  const [availableQubits, setAvailableQubits] = useState(String(DEFAULT_AVAILABLE_QUBITS));
  const [routing, setRouting] = useState<RoutingConfig>(DEFAULT_ROUTING);
  const [submittedRequest, setSubmittedRequest] = useState<SimulationRequest | null>(null);
  const [state, dispatch] = useReducer(reducer, {
    loading: false, slow: false, error: null, snapshot: null, history: [], completed: 0,
  });

  useEffect(() => {
    if (!submittedRequest) return;
    let active = true;
    const controller = new AbortController();
    const slowNotice = setTimeout(() => { if (active) dispatch({ type: "slow" }); }, 10000);
    const timeout = setTimeout(() => controller.abort(new Error("The engine took too long to respond. Please retry; it may be waking up.")), 90000);
    const request = submittedRequest;
    void simulate(request, controller.signal).then((data) => {
      if (active && !controller.signal.aborted) {
        const id = crypto.randomUUID();
        const completedAt = new Date().toISOString();
        dispatch({ type: "success", snapshot: { id, completedAt, request, data } });
        saveRun({ id, completedAt, request, telemetry: data });
      }
    }).catch((error: unknown) => {
      // Superseded requests never replace a newer selection's result.
      if (!active || (controller.signal.aborted && controller.signal.reason?.name === "AbortError")) return;
      const message = controller.signal.aborted
        ? String(controller.signal.reason?.message ?? "Request timed out. Please retry.")
        : error instanceof TypeError
          ? "Cannot reach the engine. Check your connection and backend URL, then retry."
          : error instanceof Error ? error.message : "The simulation could not be completed.";
      dispatch({ type: "error", error: message });
    }).finally(() => { clearTimeout(timeout); clearTimeout(slowNotice); });
    return () => { active = false; clearTimeout(timeout); clearTimeout(slowNotice); controller.abort(); };
  }, [submittedRequest, saveRun]);

  const { snapshot, loading, error } = state;
  const data = snapshot?.data;
  const quantum = data?.stages.stage_2_quantum_kernel;
  const timing = data ? pipelineTiming(data) : null;
  const coherence = data ? coherenceBudget(data) : null;
  const severity: StageStatus = data
    ? Object.values(data.stages).some((s) => s.status === "CRITICAL_BOTTLENECK") ? "CRITICAL_BOTTLENECK"
      : Object.values(data.stages).some((s) => s.status === "WARNING") || !data.primary_bottleneck.startsWith("NONE") ? "WARNING" : "OPTIMAL"
    : "OPTIMAL";
  const style = STATUS[severity];
  const limited = data && !data.primary_bottleneck.startsWith("NONE");
  const latest = state.history[0];
  const capacity = Number(availableQubits);
  const validCapacity = Number.isSafeInteger(capacity) && capacity >= 1 && capacity <= 2_147_483_647;
  const configurationChanged = snapshot && (
    snapshot.request.workload_id !== workload || snapshot.request.scale_param !== scale ||
    snapshot.request.hardware_profile !== hardware || snapshot.request.available_qubits !== capacity || PIPELINE.some(({ routingKey }) =>
      (snapshot.request.routing?.[routingKey] ?? DEFAULT_ROUTING[routingKey]) !== routing[routingKey])
  );
  const runSimulation = () => {
    if (!validCapacity) return;
    dispatch({ type: "start" });
    setSubmittedRequest({
      workload_id: workload, scale_param: scale, hardware_profile: hardware, available_qubits: capacity, routing: { ...routing },
    });
  };
  const updateNode = (key: keyof RoutingConfig, node: StageNode) => {
    setRouting((current) => current[key] === node ? current : { ...current, [key]: node });
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-slate-800/80 bg-slate-950/90">
        <div className="mx-auto flex max-w-[1440px] flex-wrap items-center justify-between gap-4 px-5 py-5 sm:px-8 lg:px-12">
          <Link href="/" className="flex items-center gap-3" aria-label="Q-Split home">
            <span className="grid size-10 place-items-center rounded-xl border border-cyan-400/25 bg-cyan-400/10 text-cyan-400"><Workflow size={23} /></span>
            <span className="text-xl font-semibold tracking-tight">Q<span className="text-cyan-400">-</span>Split
              <span className="ml-3 hidden border-l border-slate-800 pl-3 text-xs font-normal tracking-normal text-slate-500 sm:inline">Hybrid workload profiler</span>
            </span>
          </Link>
          <div role="status" className="flex items-center gap-2 rounded-full border border-slate-800 bg-slate-900/70 px-3 py-1.5 text-xs text-slate-400">
            <span className={["size-1.5 rounded-full", loading ? "animate-pulse bg-sky-400" : error ? "bg-rose-400" : data ? "bg-cyan-400" : "bg-slate-500"].join(" ")} />
            {loading ? "Simulation in progress" : error ? "Request unsuccessful" : data ? "Engine connected" : "Ready to simulate"}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1440px] px-5 py-9 sm:px-8 lg:px-12">
        <div className="mb-8 flex flex-wrap items-end justify-between gap-5">
          <div>
            <p className="mb-3 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-cyan-400"><FlaskConical size={13} /> Quantum / classical observatory</p>
            <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Workload simulator</h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-400">Trace the handoff. Find the bottleneck. Explore where quantum hardware meets its limits.</p>
          </div>
          <span className="rounded-md border border-slate-800 px-2.5 py-1 font-mono text-[10px] text-slate-500">ENGINE v2.0</span>
        </div>

        <section aria-label="Simulation controls" className="mb-6 rounded-2xl border border-slate-800 bg-slate-900/50 p-5 sm:p-6">
          <div className="flex flex-col gap-6 xl:flex-row xl:items-end">
            <div className="min-w-0 xl:w-64">
              <label htmlFor="workload" className="mb-3 block text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">01 / Workload preset</label>
              <div className="relative">
                <select id="workload" value={workload} onChange={(e) => setWorkload(e.target.value as WorkloadId)} className="w-full appearance-none rounded-lg border border-slate-700 bg-slate-950 py-3 pl-3 pr-9 text-sm text-slate-200">
                  <option value="shors_crypto">Shor’s cryptography</option>
                  <option value="quantum_mips">Quantum-MIPS AI · Preview</option>
                </select>
                <ChevronDown className="pointer-events-none absolute right-3 top-3.5 text-slate-500" size={16} />
              </div>
            </div>
            <fieldset className="min-w-0 flex-1">
              <legend className="mb-3 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">02 / Target scale</legend>
              <div className="flex flex-wrap gap-1.5">{SCALES.map((value) => (
                <button key={value} type="button" aria-pressed={scale === value} onClick={() => setScale(value)} className={["rounded-lg border px-3 py-3 font-mono text-xs transition-colors", scale === value ? "border-cyan-400/50 bg-cyan-400/10 text-cyan-300" : "border-slate-800 bg-slate-950/70 text-slate-400 hover:border-slate-600 hover:text-slate-200"].join(" ")}>{scaleLabel(value)}</button>
              ))}</div>
            </fieldset>
            <fieldset className="min-w-0">
              <legend className="mb-3 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">03 / Hardware profile</legend>
              <div className="flex flex-wrap gap-1 rounded-lg border border-slate-800 bg-slate-950 p-1">
                {(["ibm_heron_nisq", "ideal_sim"] as const).map((value) => (
                  <button key={value} type="button" aria-pressed={hardware === value} onClick={() => setHardware(value)} className={["rounded-md px-3 py-2 text-xs transition-colors", hardware === value ? "bg-slate-800 text-slate-100 shadow-sm" : "text-slate-500 hover:text-slate-200"].join(" ")}>{hardwareLabel(value)}</button>
                ))}
              </div>
            </fieldset>
            <button type="button" disabled={loading || !validCapacity} onClick={runSimulation} className="flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-lg bg-cyan-400 px-5 text-sm font-semibold text-slate-950 transition-colors hover:bg-cyan-300 disabled:cursor-wait disabled:opacity-60">
              {loading ? <LoaderCircle size={15} className="animate-spin" /> : <Play size={15} fill="currentColor" />}
              {loading ? "Simulating…" : "Run simulation"}
            </button>
          </div>
          <div className="mt-6 border-t border-slate-800 pt-5">
            <label htmlFor="available-qubits" className="mb-3 block text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400">04 / Available QPU Qubits</label>
            <div className="flex flex-wrap items-center gap-3">
              <input id="available-qubits" type="number" min={1} max={2147483647} step={1} value={availableQubits} onChange={(event) => setAvailableQubits(event.target.value)} aria-invalid={!validCapacity} aria-describedby="capacity-help" className="w-36 rounded-lg border border-slate-700 bg-slate-950 px-3 py-3 font-mono text-sm text-cyan-200" />
              <div role="group" aria-label="QPU capacity presets" className="flex flex-wrap gap-1.5">{QUBIT_PRESETS.map((value) => (
                <button key={value} type="button" aria-pressed={capacity === value} onClick={() => setAvailableQubits(String(value))} className={["rounded-lg border px-3 py-2 font-mono text-xs", capacity === value ? "border-cyan-400/50 bg-cyan-400/10 text-cyan-200" : "border-slate-800 text-slate-400 hover:border-slate-600"].join(" ")}>{formatValue(value)}</button>
              ))}</div>
            </div>
            <p id="capacity-help" className="mt-3 text-xs leading-6 text-slate-400">{validCapacity ? "Per QPU stage. Select a tier threshold below to explore the trade-off; changes apply on Run simulation." : "Enter a whole qubit count from 1 to 2,147,483,647."}</p>
            <ParallelizationTiers scale={scale} onSelect={(value) => setAvailableQubits(String(value))} />
            <p className="mt-3 text-[10px] leading-5 text-slate-500">133 and 1,121 reflect Heron r1 and Condor milestones; larger presets are exploratory capacities. These are modeled usable qubits; physical error-correction overhead is excluded. Extra capacity above the carry-lookahead threshold stays idle.</p>
          </div>
          <p className="mt-4 text-xs leading-5 text-slate-500">
            {workload === "quantum_mips" ? "Quantum-MIPS is a preview preset. Click Run simulation to request its availability from the engine." : "N = 15 in sequential mode runs a Qiskit Aer circuit. Parallel tiers and larger scales use an analytical hardware model. QPU capacity does not limit CPU/GPU emulation."}
          </p>
        </section>

        {loading && (
          <div role="status" aria-label="Simulation loading" className="mb-6 flex items-start gap-3 rounded-xl border border-cyan-400/20 bg-cyan-400/5 p-4">
            <LoaderCircle size={18} className="mt-0.5 shrink-0 animate-spin text-cyan-400 motion-reduce:animate-none" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-cyan-200">{state.slow ? "The engine is taking a little longer" : "Running your simulation"}</p>
              <p className="mt-1 text-xs leading-6 text-slate-400">{state.slow ? "The Render engine may be waking up. We’ll wait up to 90 seconds; you can keep this page open or try again." : "Fetching engine telemetry. Your controls remain available while the simulation runs."}</p>
            </div>
            {state.slow && <button type="button" onClick={runSimulation} className="shrink-0 rounded-md border border-cyan-400/30 px-3 py-2 text-xs text-cyan-200">Try again</button>}
          </div>
        )}

        {error && (
          <div role="alert" className="mb-6 flex items-start gap-3 rounded-xl border border-rose-400/30 bg-rose-400/10 p-4">
            <CircleAlert className="mt-0.5 shrink-0 text-rose-400" size={18} />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-rose-300">Simulation could not be completed</p>
              <p className="mt-1 text-sm leading-6 text-rose-200/75 [overflow-wrap:anywhere]">{error}</p>
              {snapshot && <p className="mt-2 text-xs text-slate-400">Showing the last successful simulation below.</p>}
            </div>
            <button type="button" onClick={runSimulation} className="rounded-md border border-rose-400/30 px-3 py-2 text-xs text-rose-200">Retry</button>
          </div>
        )}

        <section aria-label="Simulation results" aria-busy={loading} className="space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <p className="text-slate-400">{data && snapshot ? <><span className="font-medium text-slate-200">{data.scale_label}</span><span className="mx-2 text-slate-700">/</span>{hardwareLabel(snapshot.request.hardware_profile)}</> : "Choose a configuration, then click Run simulation"}</p>
            <p className="flex items-center gap-1.5 text-slate-500">{loading
              ? <><LoaderCircle size={12} className="animate-spin" />{data ? "Updating · previous result shown" : "Waiting for engine telemetry"}</>
              : configurationChanged ? "Configuration changed · previous result shown" : data ? <><Check size={13} className="text-emerald-400" />Simulation {state.completed} complete</> : "No simulation results yet"}</p>
          </div>
          <div aria-label="Primary bottleneck" className={["flex items-start gap-4 rounded-xl border p-5", data ? [style.border, style.background].join(" ") : "border-slate-800 bg-slate-900/50"].join(" ")}>
            <span className={["mt-0.5", data ? style.text : "text-slate-500"].join(" ")}>{limited ? <CircleAlert size={22} /> : <Activity size={22} />}</span>
            <div className="min-w-0">
              <p className={["mb-1.5 text-[10px] font-semibold uppercase tracking-[0.18em]", data ? style.text : "text-slate-500"].join(" ")}>{data ? limited ? "Hardware limitation detected" : "Pipeline operating within limits" : "Primary bottleneck"}</p>
              <h2 className="text-sm font-medium leading-6 text-slate-200 [overflow-wrap:anywhere]" data-testid="bottleneck">{data?.primary_bottleneck ?? "Run a simulation to evaluate this pipeline."}</h2>
              {data && <p className="mt-1 text-xs leading-5 text-slate-400">{data.execution_mode === "LIVE_QISKIT_AER" ? "Circuit executed on a classical Qiskit Aer simulator. Reported stage timings and coherence are model estimates." : "Analytical projections of hardware requirements and coherence; no large-scale quantum circuit is executed."}</p>}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[
              { label: "Pipeline latency", value: timing?.totalMs, unit: "ms", icon: Activity },
              { label: quantum?.node === "QPU" ? "Qubits allocated / available" : "Logical qubits", value: quantum?.node === "QPU" ? `${formatValue(quantum.metrics.qubits_allocated)} / ${formatValue(quantum.metrics.available_qubits)}` : quantum?.metrics.qubits_required, unit: "qubits", icon: Layers3 },
              { label: "Circuit depth", value: quantum?.metrics.circuit_depth, unit: "gates", icon: Workflow },
              { label: "Coherence survival", value: coherence?.survival, unit: "%", icon: Zap },
            ].map(({ label, value, unit, icon: Icon }) => (
              <div key={label} className="min-w-0 rounded-xl border border-slate-800 bg-slate-900/35 p-4 sm:p-5">
                <p className="flex items-center justify-between gap-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">{label}<Icon size={14} className="shrink-0 text-slate-600" /></p>
                <p title={formatValue(value) + " " + unit} className="mt-3 break-words font-mono text-xl tracking-tight sm:text-2xl">{summaryValue(value)}<span className="ml-2 text-xs text-slate-500">{unit}</span></p>
                {label === "Pipeline latency" && <dl aria-label="Pipeline latency breakdown" title="Includes separately reported QPU I/O; GPU launch/transfer overhead is counted once. Blocked stages contribute no time." className="mt-3 flex flex-wrap gap-x-4 gap-y-2 border-t border-slate-800/70 pt-2 text-[10px] leading-4">
                  <div className="min-w-0 flex-1 basis-20"><dt className="text-slate-500">Pure Compute Time</dt><dd className="mt-1 font-mono text-slate-300">{formatValue(timing?.computeMs)} ms</dd></div>
                  <div className="min-w-0 flex-1 basis-28"><dt className="text-slate-500">Interconnect &amp; State-Prep Overhead</dt><dd className="mt-1 font-mono text-slate-300">{formatValue(timing?.overheadMs)} ms</dd></div>
                </dl>}
                {label === "Coherence survival" && <div className="mt-2 space-y-2">
                  <p className="text-[10px] leading-4 text-slate-500">{coherence?.classical ? "Deterministic Classical Emulation" : "vs. 100% deterministic classical baseline"}</p>
                  {coherence?.status && <span aria-label={`Coherence Budget Status: ${coherence.status}`} className={["inline-flex rounded-md border px-2 py-1 text-[9px] font-semibold tracking-wider", COHERENCE_BUDGET_STYLE[coherence.status]].join(" ")}>{coherence.status}</span>}
                </div>}
              </div>
            ))}
          </div>

          <LatencyProportion data={data} />
          <OffloadVerdictStrip snapshot={snapshot} />

          <div>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-sm font-semibold">Execution pipeline</h2>
              <p aria-label="Selected stage routing" className="flex items-center gap-2 font-mono text-[10px] text-slate-500">{PIPELINE.map(({ routingKey }, index) => <span key={routingKey} className="inline-flex items-center gap-2">{index > 0 && <ArrowRight size={12} />}<span className={NODE_STYLE[routing[routingKey]].text}>{routing[routingKey]}</span></span>)}</p>
            </div>
            <div className="grid gap-4 lg:grid-cols-3">{PIPELINE.map(({ key, routingKey }, index) => (
              <div key={key} className="relative min-w-0">
                <PipelineCard index={index} stage={data?.stages[key]} selectedNode={routing[routingKey]} onNodeChange={(node) => updateNode(routingKey, node)} pending={loading} />
                {index < 2 && <span aria-hidden="true" className="pointer-events-none absolute -bottom-3 left-1/2 z-10 grid size-6 -translate-x-1/2 place-items-center rounded-full border border-slate-700 bg-slate-950 text-slate-500 lg:-right-5 lg:bottom-auto lg:left-auto lg:top-1/2 lg:-translate-y-1/2 lg:translate-x-0"><ArrowRight size={12} className="hidden lg:block" /><ArrowDown size={12} className="lg:hidden" /></span>}
              </div>
            ))}</div>
          </div>
        </section>

        <section aria-label="State delta tracker" className="mt-8 overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/35">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-5 py-5 sm:px-6">
            <div className="flex items-center gap-3"><GitCompareArrows size={18} className="text-slate-400" /><div><h2 className="text-sm font-semibold">State delta tracker</h2><p className="mt-1 text-xs text-slate-500">Compare consecutive successful runs. Last six transitions, this session.</p></div></div>
            <span className="rounded-md bg-slate-800 px-2 py-1 font-mono text-[10px] text-slate-400">{state.history.length} TRANSITIONS</span>
          </div>
          {latest ? (
            <div className="px-5 py-5 sm:px-6">
              <div className="mb-4 flex flex-wrap items-center gap-2 text-xs">
                <span className="text-slate-500">Latest change</span>
                <span className="rounded-md border border-slate-700 px-2 py-1 font-mono text-slate-300">{scaleLabel(latest.before.request.scale_param)}</span>
                <ArrowRight size={12} className="text-slate-500" />
                <span className="rounded-md border border-cyan-400/25 bg-cyan-400/10 px-2 py-1 font-mono text-cyan-300">{scaleLabel(latest.after.request.scale_param)}</span>
                <span className="text-slate-500">{hardwareLabel(latest.after.request.hardware_profile)}</span>
              </div>
              <DeltaTable changes={latest.changes} />
              {state.history.length > 1 && <div className="mt-5 space-y-2">{state.history.slice(1).map((transition) => (
                <details key={transition.id} className="rounded-lg border border-slate-800 px-4 py-3">
                  <summary className="cursor-pointer text-xs text-slate-400">Run {transition.id - 1} → {transition.id} · {scaleLabel(transition.before.request.scale_param)} → {scaleLabel(transition.after.request.scale_param)} · {transition.changes.length} changes</summary>
                  <div className="mt-4"><DeltaTable changes={transition.changes} /></div>
                </details>
              ))}</div>}
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
              <GitCompareArrows size={24} className="mb-1 text-slate-600" />
              <p className="text-sm text-slate-400">{data ? "Baseline captured. Adjust your configuration and run again to compare results." : "Your first successful run establishes a baseline."}</p>
              <p className="text-xs text-slate-600">Scale, hardware, status, latency, and stage metrics are tracked automatically.</p>
            </div>
          )}
        </section>
        <TelemetryAdvisor key={snapshot?.id ?? "idle"} snapshot={snapshot} previous={latest?.before}
          onInsight={saveRun} onPersisted={() => { void persistentHistory.refresh(); }} simulationLoading={loading} saving={persistentHistory.savingCount > 0}
          savedInsight={persistentHistory.runs.find((run) => run.id === snapshot?.id)?.advisorInsight}
          persistenceMessage={persistentHistory.message} />
        <PersistentRunHistory history={persistentHistory} />
        <footer className="mt-8 flex flex-wrap items-center justify-between gap-3 border-t border-slate-800/70 pt-5 text-[10px] leading-5 text-slate-500">
          <p className="flex items-center gap-2"><Radio size={12} />{data?.execution_mode.replaceAll("_", " ") ?? "AWAITING TELEMETRY"}</p>
          <p>Simulated workloads. Estimated hardware limits. No physical QPU connection.</p>
        </footer>
      </main>
    </div>
  );
}

function DeltaTable({ changes }: { changes: Transition["changes"] }) {
  if (!changes.length) return <p className="text-xs text-slate-400">No metric changes from the previous successful run.</p>;
  return (
    <div role="region" aria-label="Metric changes" tabIndex={0} className="overflow-x-auto rounded-sm">
      <table className="w-full min-w-[480px] table-fixed text-left text-xs">
        <thead><tr className="border-b border-slate-800 text-[10px] uppercase tracking-wider text-slate-500"><th className="pb-3 pr-4 font-medium">Parameter / metric</th><th className="pb-3 pr-4 font-medium">Previous</th><th className="pb-3 font-medium">Current</th></tr></thead>
        <tbody>{changes.map((change) => (
          <tr key={change.label} className="border-b border-slate-800/60 last:border-0">
            <th scope="row" className="py-3 pr-4 font-normal capitalize text-slate-400 [overflow-wrap:anywhere]">{change.label}</th>
            <td className="py-3 pr-4 font-mono text-slate-400 [overflow-wrap:anywhere]">{change.before}</td>
            <td className="py-3 font-mono text-slate-200 [overflow-wrap:anywhere]">{change.after}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}


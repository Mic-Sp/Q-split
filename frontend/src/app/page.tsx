"use client";

import { useEffect, useReducer, useState } from "react";
import Link from "next/link";
import { ThemeToggle } from "@/components/theme-toggle";
import { PersistentRunHistory } from "@/components/persistent-run-history";
import { TargetScales } from "@/components/target-scales";
import { ParallelizationTiers } from "@/components/parallelization-tiers";
import { TelemetryAdvisor } from "@/components/telemetry-advisor";
import { LatencyProportion } from "@/components/latency-proportion";
import { OffloadVerdictStrip } from "@/components/offload-verdict";
import { InfoPopover } from "@/components/info-popover";
import { CaptureBenchmark } from "@/components/capture-benchmark";
import { recordCompletedRun, sessionForWorkload, type SimulationSession } from "@/lib/simulation-session";
import { restoredConfiguration } from "@/lib/benchmark-snapshot";
import type { SavedSimulationRun } from "@/types/run-history";
import { createClientId } from "@/lib/client-session";
import { usePersistentRuns } from "@/hooks/use-persistent-runs";
import { coherenceBudget, pipelineTiming, type CoherenceBudgetStatus } from "@/lib/kpi-metrics";
import { formatDuration, formatRawMilliseconds } from "@/lib/duration";
import { HARDWARE_PROFILES, hardwareLabel } from "@/lib/hardware-profiles";
import { WORKLOADS, workloadScaleLabel } from "@/lib/workloads";
import { HARDWARE_PROFILE_IDS } from "@/types/telemetry";
import {
  Activity, ArrowDown, ArrowRight, Check, ChevronDown, CircleAlert, CircuitBoard, Cpu,
  GitCompareArrows, Layers3, LoaderCircle, Play, Radio, Workflow, Zap,
} from "lucide-react";
import {
  DEFAULT_AVAILABLE_QUBITS, DEFAULT_ROUTING, formatValue, hardwareDefaultQubits, PIPELINE, simulate,
  type Snapshot, type Transition,
} from "@/lib/telemetry";
import type { HardwareProfile, RoutingConfig, SimulationRequest, StageNode, StageStatus, StageTelemetry, WorkloadId } from "@/types/telemetry";
const QUBIT_PRESETS = [16, 36, 72, 133, 1121, 2048, 4096, 16384];
const summaryValue = (value: unknown) => typeof value === "number" && Math.abs(value) >= 1_000_000
  ? new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(value)
  : formatValue(value);
const STATUS = {
  OPTIMAL: { label: "Optimal", text: "text-emerald-700 dark:text-emerald-400", border: "border-emerald-700/25 dark:border-emerald-400/25", background: "bg-emerald-700/10 dark:bg-emerald-400/10", dot: "bg-emerald-600 dark:bg-emerald-400" },
  WARNING: { label: "Warning", text: "text-amber-700 dark:text-amber-300", border: "border-amber-700/30 dark:border-amber-400/30", background: "bg-amber-700/10 dark:bg-amber-400/10", dot: "bg-amber-600 dark:bg-amber-400" },
  CRITICAL_BOTTLENECK: { label: "Critical bottleneck", text: "text-rose-700 dark:text-rose-400", border: "border-rose-700/30 dark:border-rose-400/30", background: "bg-rose-700/10 dark:bg-rose-400/10", dot: "bg-rose-600 dark:bg-rose-400" },
} satisfies Record<StageStatus, { label: string; text: string; border: string; background: string; dot: string }>;

const NODE_STYLE = {
  CPU: { icon: Cpu, text: "text-sky-700 dark:text-sky-300", frame: "border-sky-700/20 dark:border-sky-400/20 bg-sky-700/10 dark:bg-sky-400/10 text-sky-700 dark:text-sky-300" },
  GPU: { icon: CircuitBoard, text: "text-cyan-700 dark:text-cyan-300", frame: "border-cyan-700/20 dark:border-cyan-400/20 bg-cyan-700/10 dark:bg-cyan-400/10 text-cyan-700 dark:text-cyan-300" },
  QPU: { icon: Layers3, text: "text-violet-700 dark:text-violet-300", frame: "border-violet-700/20 dark:border-violet-400/20 bg-violet-700/10 dark:bg-violet-400/10 text-violet-700 dark:text-violet-300" },
};
const NODES: StageNode[] = ["CPU", "GPU", "QPU"];
const COHERENCE_BUDGET_STYLE: Record<CoherenceBudgetStatus, string> = {
  NOMINAL: "border-emerald-700/25 dark:border-emerald-400/25 bg-emerald-700/10 dark:bg-emerald-400/10 text-emerald-700 dark:text-emerald-300",
  DEGRADED: "border-amber-700/30 dark:border-amber-400/30 bg-amber-700/10 dark:bg-amber-400/10 text-amber-700 dark:text-amber-300",
  EXCEEDED: "border-rose-700/30 dark:border-rose-400/30 bg-rose-700/10 dark:bg-rose-400/10 text-rose-700 dark:text-rose-300",
};
const CAPACITY_PANEL_METRICS = new Set([
  "available_qubits", "qubits_allocated", "idle_qubits", "parallelization_tier",
  "depth_complexity", "parallel_speedup_ceiling_reached",
  "hardware_architecture", "connectivity_topology", "reference_qubits", "reference_circuit_depth",
  "routing_depth_multiplier", "gate_time_multiplier", "coherence_decay_scale",
]);

interface DashboardState extends SimulationSession {
  loading: boolean;
  slow: boolean;
  error: string | null;
}
type Action = { type: "start" } | { type: "slow" } | { type: "error"; error: string } | { type: "success"; snapshot: Snapshot };

/**
 * Update request lifecycle without losing workload-specific snapshots; only successful runs create session transitions.
 */
function reducer(state: DashboardState, action: Action): DashboardState {
  if (action.type === "start") return { ...state, loading: true, slow: false, error: null };
  if (action.type === "slow") return { ...state, slow: true };
  if (action.type === "error") return { ...state, loading: false, slow: false, error: action.error };
  return { ...recordCompletedRun(state, action.snapshot), loading: false, slow: false, error: null };
}

/**
 * Present backend stage severity independently of the coherence-budget KPI classification.
 */
function StatusBadge({ status }: { status: StageStatus }) {
  const style = STATUS[status];
  return (
    <span className={["inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider", style.text, style.border, style.background].join(" ")}>
      <span className={["size-1.5 rounded-full", style.dot].join(" ")} />{style.label}
    </span>
  );
}

const metricLabels: Record<string, string> = {
  qubits_required: "Logical qubits", circuit_depth: "Circuit depth", io_state_prep_ms: "State preparation", io_readout_ms: "Readout",
  coherence_survival_pct: "Coherence survival · %", algorithm: "Algorithm", complexity: "Complexity",
  base_a: "Coprime base", factors_found: "Factors found",
  routing_model: "Latency estimate", routing_supported: "Route supported", execution_feasible: "Execution feasible",
  launch_transfer_overhead_ms: "Launch / transfer", compute_latency_factor: "Compute latency factor",
  simulation_method: "Simulation method", statevector_memory_required: "Statevector memory required",
  statevector_memory_budget_gib: "Memory budget · GiB",
  available_qubits: "Available QPU qubits", qubits_allocated: "Qubits allocated",
  minimum_qubits_required: "Minimum qubits required", idle_qubits: "Idle qubits",
  parallelization_tier: "Parallelization tier", depth_complexity: "Depth scaling",
  parallel_speedup_ceiling_reached: "Parallel speedup ceiling reached", depth_model: "Depth model",
};

/**
 * Render selected routing alongside an immutable completed-stage result.
 * Selection and measured/model output may differ during dirty/in-flight states;
 * route controls never mutate the stored result or submit work automatically.
 */
function PipelineCard({ index, stage, selectedNode, onNodeChange, pending, workload }: {
  index: number;
  workload: WorkloadId;
  stage?: StageTelemetry;
  selectedNode: StageNode;
  onNodeChange: (node: StageNode) => void;
  pending: boolean;
}) {
  const config = { ...PIPELINE[index], label: WORKLOADS[workload].stages[index] };
  const node = selectedNode;
  const nodeStyle = NODE_STYLE[node];
  const NodeIcon = nodeStyle.icon;
  const style = stage ? STATUS[stage.status] : null;
  return (
    <article data-testid={"stage-" + (index + 1)} className={["relative flex h-full min-w-0 flex-col overflow-hidden rounded-xl border console-panel bg-white dark:bg-slate-900/70 p-2.5", style?.border ?? "border-slate-200 dark:border-slate-800"].join(" ")}>
      <div className="console-header -mx-2.5 -mt-2.5 mb-[3px] flex flex-wrap items-center justify-between gap-2 border-b border-slate-300 dark:border-slate-700/80 px-2.5 pt-2.5">
        <span className="inline-flex items-center gap-2 font-mono text-[10px] font-bold tracking-wider text-cyan-900 dark:text-cyan-100"><span aria-hidden="true" className="h-3 w-0.5 rounded-full bg-cyan-700/80 dark:bg-cyan-300/80" />STAGE 0{index + 1}</span>
        {stage ? <StatusBadge status={stage.status} /> : <span className="text-[10px] text-slate-600 dark:text-slate-400">Awaiting telemetry</span>}
      </div>
      <div className="mb-1 flex items-center gap-2">
        <span className={["grid size-6 shrink-0 place-items-center rounded-md border", nodeStyle.frame].join(" ")}>
          <NodeIcon size={14} />
        </span>
        <div className="flex flex-wrap items-baseline gap-x-2">
          <p data-testid={"stage-node-" + (index + 1)} className={["text-xs font-semibold", nodeStyle.text].join(" ")}>{node}</p>
          <p className="text-[10px] text-slate-600 dark:text-slate-400">{config.label}</p>
        </div>
      </div>
      <fieldset aria-label={`Stage ${index + 1} node assignment`} className="mb-1 min-w-0">
        <legend className="sr-only">Run on</legend>
        <div className="flex items-center gap-2"><span aria-hidden="true" className="shrink-0 text-[9px] font-semibold uppercase text-slate-600 dark:text-slate-400">Run on</span><div className="grid flex-1 grid-cols-3 gap-1 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 p-0.5">
          {NODES.map((target) => <button key={target} type="button" aria-pressed={selectedNode === target} onClick={() => onNodeChange(target)} className={["min-h-7 rounded px-2 py-1 text-[11px] font-semibold transition-colors", selectedNode === target ? "bg-cyan-700/15 dark:bg-cyan-400/15 text-cyan-800 dark:text-cyan-200 ring-1 ring-inset ring-cyan-700/30 dark:ring-cyan-400/30" : "text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-slate-100"].join(" ")}>{target}</button>)}
        </div></div>
        <p className={pending || (stage && stage.node !== selectedNode) ? "mt-1 text-[9px] leading-3 text-slate-600 dark:text-slate-400" : "sr-only"}>{stage && stage.node !== selectedNode ? `Selected ${selectedNode} · showing previous ${stage.node} result` : pending ? "Simulation in progress for the submitted route…" : "Selection applies when you click Run simulation"}</p>
      </fieldset>
      <h3 title={stage?.name ?? config.label} className="line-clamp-1 text-[11px] font-semibold leading-4 text-slate-900 dark:text-slate-100 [overflow-wrap:anywhere]">{stage?.name ?? config.label}</h3>
      <div className="console-header -mx-2.5 my-1.5 flex items-center justify-between gap-2 border-y border-slate-300 dark:border-slate-700/80 px-2.5 py-1">
        <span className="text-[9px] font-bold uppercase tracking-wider text-slate-800 dark:text-slate-200">Stage latency</span>
        <p data-testid={"stage-latency-" + (index + 1)} title={formatRawMilliseconds(stage?.latency_ms)} className="font-mono text-base tracking-tight text-slate-900 dark:text-slate-100 [overflow-wrap:anywhere]">
          {formatDuration(stage?.latency_ms)}
        </p>
      </div>
      {stage?.node === "QPU" && typeof stage.metrics.available_qubits === "number" && (
        <div data-testid={`qpu-capacity-${index + 1}`} className="mb-1.5 overflow-hidden rounded-md border border-cyan-700/20 dark:border-cyan-400/20 bg-cyan-700/5 dark:bg-cyan-400/5">
          <p className="console-header border-b border-cyan-700/20 dark:border-cyan-400/20 px-2 py-1 text-[9px] font-semibold leading-3 text-cyan-900 dark:text-cyan-100">Qubits Allocated / Available</p>
          <div className="px-2 py-1.5">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1"><p className="font-mono text-sm leading-5 text-cyan-800 dark:text-cyan-200">{formatValue(stage.metrics.qubits_allocated)} / {formatValue(stage.metrics.available_qubits)}</p><p className="max-w-full rounded border border-cyan-700/20 dark:border-cyan-400/20 bg-cyan-700/10 dark:bg-cyan-400/10 px-1.5 py-0.5 text-[10px] font-medium leading-3 text-cyan-700 dark:text-cyan-300 [overflow-wrap:anywhere]">{formatValue(stage.metrics.parallelization_tier)}</p></div>
            <p className="mt-0.5 text-[9px] leading-4 text-slate-600 dark:text-slate-400">{formatValue(stage.metrics.idle_qubits)} idle · {stage.metrics.depth_complexity !== undefined ? formatValue(stage.metrics.depth_complexity) : typeof stage.metrics.depth_multiplier === "number" ? `${stage.metrics.depth_multiplier.toFixed(2)}× reference depth` : "Not executed"}{stage.metrics.parallel_speedup_ceiling_reached === true ? " · Speedup ceiling reached" : ""}</p>
          </div>
        </div>
      )}
      <dl className="mb-2 grid grid-cols-2 gap-1 xl:grid-cols-3">
        {stage ? Object.entries(stage.metrics).filter(([key]) => !CAPACITY_PANEL_METRICS.has(key) && key !== "classical_cpu_baseline").map(([key, value]) => (
          <div key={key} className="min-w-0 rounded-md border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/60 px-2 py-1">
            <dt className="text-[9px] leading-3 text-slate-600 dark:text-slate-400 [overflow-wrap:anywhere]">{metricLabels[key] ?? key.replace(/_ms$/, "").replaceAll("_", " ")}</dt>
            <dd title={key.endsWith("_ms") ? formatRawMilliseconds(value) : formatValue(value)} className={["mt-0.5 font-mono text-[10px] leading-4 [overflow-wrap:anywhere]", key === "coherence_survival_pct" ? style?.text : "text-slate-800 dark:text-slate-200"].join(" ")}>{key.endsWith("_ms") ? formatDuration(value) : key === "routing_model" ? "Modeled" : key === "depth_model" ? String(value).startsWith("Compiled") ? "Aer reference" : "Analytical" : typeof value === "boolean" ? value ? "Yes" : "No" : formatValue(value)}</dd>
          </div>
        )) : <div className={["col-span-full h-12 rounded-lg bg-slate-100 dark:bg-slate-800/40", pending ? "animate-pulse" : ""].join(" ")} aria-hidden="true" />}
      </dl>
      <div className="mt-auto rounded-lg bg-slate-50 dark:bg-slate-950/70 p-1.5">
        <p className="mb-1 text-[9px] font-semibold uppercase tracking-wider text-slate-600 dark:text-slate-400">Stage output</p>
        <p className="text-[11px] leading-4 text-slate-600 dark:text-slate-400 [overflow-wrap:anywhere]">
          {stage?.output_summary ?? "Run a simulation to inspect this stage’s output and hardware metrics."}
        </p>
      </div>
    </article>
  );
}

/**
 * Coordinate editable controls, submitted requests, per-workload sessions, and persistence.
 * Only explicit run actions capture/submit configuration; request completion and
 * background database saving have separate lifecycles. Restore loads saved controls
 * without reapplying profile defaults or automatically executing the simulation.
 */
export default function Home() {
  const [workload, setWorkload] = useState<WorkloadId>("shors_crypto");
  const persistentHistory = usePersistentRuns(workload);
  const { saveRun } = persistentHistory;
  const [scale, setScale] = useState(15);
  const [hardware, setHardware] = useState<HardwareProfile>("ibm_heron_nisq");
  const [availableQubits, setAvailableQubits] = useState(String(DEFAULT_AVAILABLE_QUBITS));
  const [routing, setRouting] = useState<RoutingConfig>(DEFAULT_ROUTING);
  // Separate submitted configuration from live edits; only an explicit run changes this effect input.
  const [submittedRequest, setSubmittedRequest] = useState<SimulationRequest | null>(null);
  const [restoreMessage, setRestoreMessage] = useState<string | null>(null);
  const [state, dispatch] = useReducer(reducer, {
    loading: false, slow: false, error: null, snapshots: {}, history: [], completed: 0,
  });

  useEffect(() => {
    if (!submittedRequest) return;
    let active = true;
    const controller = new AbortController();
    const slowNotice = setTimeout(() => { if (active) dispatch({ type: "slow" }); }, 10000);
    const timeout = setTimeout(() => controller.abort(new Error("The engine took too long to respond. Please retry; it may be waking up.")), 90000);
    // Keep one captured request with its result/UUID even if controls change before the response arrives.
    const request = submittedRequest;
    void simulate(request, controller.signal).then((data) => {
      if (active && !controller.signal.aborted) {
        const id = createClientId();
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

  const { loading, error } = state;
  const { snapshot, history } = sessionForWorkload(state, workload);
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
  const latest = history[0];
  const capacity = Number(availableQubits);
  const validCapacity = Number.isSafeInteger(capacity) && capacity >= 1 && capacity <= 2_147_483_647;
  const configurationChanged = snapshot && (
    snapshot.request.workload_id !== workload || snapshot.request.scale_param !== scale ||
    snapshot.request.hardware_profile !== hardware || snapshot.request.available_qubits !== capacity || PIPELINE.some(({ routingKey }) =>
      (snapshot.request.routing?.[routingKey] ?? DEFAULT_ROUTING[routingKey]) !== routing[routingKey])
  );
  /** Capture current controls for one execution; persistence receives that same captured request. */
  const runSimulation = () => {
    if (!validCapacity) return;
    setRestoreMessage(null);
    dispatch({ type: "start" });
    setSubmittedRequest({
      workload_id: workload, scale_param: scale, hardware_profile: hardware, available_qubits: capacity, routing: { ...routing },
    });
  };
  const updateNode = (key: keyof RoutingConfig, node: StageNode) => {
    setRouting((current) => current[key] === node ? current : { ...current, [key]: node });
  };
  /** Explicit profile clicks apply native/ideal defaults; restoration intentionally bypasses this handler. */
  const selectHardware = (profile: HardwareProfile) => {
    setHardware(profile);
    setAvailableQubits(String(hardwareDefaultQubits(profile, scale, workload)));
  };
  /** Switch control defaults without clearing the other workload's completed snapshots or pending saves. */
  const selectWorkload = (next: WorkloadId) => {
    const target = WORKLOADS[next].scales[0];
    setWorkload(next); setScale(target);
    setRouting({ ...DEFAULT_ROUTING });
    if (hardware === "ideal_sim") setAvailableQubits(String(hardwareDefaultQubits(hardware, target, next)));
  };
  /** Restore captured controls verbatim, leaving execution to the next explicit Run action. */
  const restoreRun = (run: SavedSimulationRun) => {
    const restored = restoredConfiguration(run);
    setWorkload(restored.workload_id); setScale(restored.scale_param); setHardware(restored.hardware_profile);
    setAvailableQubits(String(restored.available_qubits));
    setRouting({ ...DEFAULT_ROUTING, ...restored.routing });
    setRestoreMessage(`Restored ${run.snapshotName ?? run.scaleLabel} into the controls. Run simulation to execute this configuration.`);
    document.querySelector('[aria-label="Simulation controls"]')?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-slate-200 dark:border-slate-800/80 bg-white/95 dark:bg-slate-950/90">
        <div className="mx-auto flex max-w-[1440px] flex-wrap items-center justify-between gap-2 px-4 py-1.5 sm:px-6">
          <Link href="/" className="flex items-center gap-3" aria-label="Q-Split home">
            <span className="grid size-8 place-items-center rounded-lg border border-cyan-700/25 dark:border-cyan-400/25 bg-cyan-700/10 dark:bg-cyan-400/10 text-cyan-700 dark:text-cyan-400"><Workflow size={19} /></span>
            <span className="text-lg font-semibold tracking-tight">Q<span className="text-cyan-700 dark:text-cyan-400">-</span>Split
              <span className="ml-3 hidden border-l border-slate-200 dark:border-slate-800 pl-3 text-xs font-normal tracking-normal text-slate-600 dark:text-slate-400 sm:inline">Hybrid workload profiler</span>
            </span>
          </Link>
          <div className="flex items-center gap-2">
            <div role="status" className="flex items-center gap-2 rounded-full border border-slate-200 dark:border-slate-800 console-panel bg-white dark:bg-slate-900/70 px-3 py-1.5 text-xs text-slate-600 dark:text-slate-400">
              <span className={["size-1.5 rounded-full", loading ? "animate-pulse bg-sky-600 dark:bg-sky-400" : error ? "bg-rose-600 dark:bg-rose-400" : data ? "bg-cyan-600 dark:bg-cyan-400" : "bg-slate-500"].join(" ")} />
              {loading ? "Simulation in progress" : error ? "Request unsuccessful" : data ? "Engine connected" : "Ready to simulate"}
            </div>
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1440px] px-4 py-1.5 sm:px-6">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <h1 className="text-lg font-semibold tracking-tight">Workload simulator</h1>
            <p className="text-xs text-slate-600 dark:text-slate-400">Trace the handoff. Find the bottleneck. Explore hardware limits.</p>
          </div>
          <span className="rounded-md border border-slate-200 dark:border-slate-800 px-2.5 py-1 font-mono text-[10px] text-slate-600 dark:text-slate-400">ENGINE v2.0</span>
        </div>

        <section aria-label="Simulation controls" className="mb-2 rounded-xl border border-slate-200 dark:border-slate-800 console-panel bg-white dark:bg-slate-900/50 p-2.5">
          <div className="grid items-end gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(150px,1fr)_minmax(0,1.6fr)_auto_auto]">
            <div className="min-w-0">
              <label htmlFor="workload" className="mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-slate-600 dark:text-slate-400">01 / Workload preset</label>
              <div className="relative">
                <select id="workload" value={workload} onChange={(e) => selectWorkload(e.target.value as WorkloadId)} className="min-h-9 w-full appearance-none rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 py-2 pl-3 pr-8 text-xs text-slate-800 dark:text-slate-200">
                  <option value="shors_crypto">{WORKLOADS.shors_crypto.label}</option>
                  <option value="quantum_mips">{WORKLOADS.quantum_mips.label}</option>
                </select>
                <ChevronDown className="pointer-events-none absolute right-3 top-2.5 text-slate-600 dark:text-slate-400" size={14} />
              </div>
            </div>
            <fieldset className="min-w-0 flex-1">
              <legend className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-600 dark:text-slate-400">02 / Target scale</legend>
              <TargetScales key={workload} workload={workload} scale={scale} onSelect={setScale} />
            </fieldset>
            <fieldset className="min-w-0">
              <legend className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-600 dark:text-slate-400">03 / Hardware profile</legend>
              <div className="grid grid-cols-2 gap-1 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 p-1">
                {HARDWARE_PROFILE_IDS.map((value) => (
                  <div key={value} className={`flex min-w-0 items-center rounded-md ${hardware === value ? "bg-slate-100 dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-sm" : "text-slate-600 dark:text-slate-400"}`}>
                    <button type="button" aria-pressed={hardware === value} onClick={() => selectHardware(value)} className="min-h-7 min-w-0 flex-1 px-2 py-1.5 text-left text-[10px] transition-colors hover:text-cyan-800 dark:hover:text-cyan-200">{hardwareLabel(value)}</button>
                    <InfoPopover label={`About ${hardwareLabel(value)}`}><p className="font-semibold text-cyan-800 dark:text-cyan-200">{hardwareLabel(value)}</p><p className="mt-2">{HARDWARE_PROFILES[value].description}</p><p className="mt-2 text-[10px] text-slate-600 dark:text-slate-400">Selecting a profile sets its reference capacity; Ideal Noise-Free selects this workload’s parallelization ceiling. You can then override capacity manually or with presets and tiers. Restoring a snapshot preserves its saved capacity. Architecture assumptions are not device benchmarks.</p></InfoPopover>
                  </div>
                ))}
              </div>
            </fieldset>
            <button type="button" disabled={loading || !validCapacity} onClick={runSimulation} className="flex min-h-9 shrink-0 items-center justify-center gap-2 rounded-lg bg-cyan-700 dark:bg-cyan-400 px-4 text-xs font-semibold text-white dark:text-slate-950 transition-colors hover:bg-cyan-800 dark:hover:bg-cyan-300 disabled:cursor-wait disabled:opacity-60">
              {loading ? <LoaderCircle size={15} className="animate-spin" /> : <Play size={15} fill="currentColor" />}
              {loading ? "Simulating…" : "Run simulation"}
            </button>
          </div>
          <div className="mt-2 border-t border-slate-200 dark:border-slate-800 pt-1">
            <div className="mb-1 flex items-center gap-1"><label htmlFor="available-qubits" className="text-[10px] font-semibold uppercase tracking-wider text-slate-600 dark:text-slate-400">04 / Available QPU Qubits</label>
              <InfoPopover label="About QPU capacity">
                <p className="font-semibold text-cyan-800 dark:text-cyan-200">Available QPU capacity</p>
                <p className="mt-2">Per QPU stage. Select a tier threshold to explore the trade-off; changes apply on Run simulation.</p>
                <p className="mt-2">36 references Forte; 72 is the exploratory Google grid preset (published Weber: 53 active qubits). 133 and 1,121 reference Heron r1 and Condor milestones; larger presets are exploratory capacities. These are modeled usable qubits; physical error-correction overhead is excluded. Extra capacity above the workload’s parallelization ceiling stays idle.</p>
                <p className="mt-2">Shor N = 15 and Quantum-MIPS M = 64 in sequential mode run Qiskit Aer reference circuits. Parallel tiers and larger scales use an analytical hardware model. Quantum-MIPS emulation uses the selected ancilla tier and is limited by CPU/GPU RAM.</p>
              </InfoPopover>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <input id="available-qubits" type="number" min={1} max={2147483647} step={1} value={availableQubits} onChange={(event) => setAvailableQubits(event.target.value)} aria-invalid={!validCapacity} aria-describedby="capacity-help" className="min-h-8 w-24 rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-2 py-1.5 font-mono text-xs text-cyan-800 dark:text-cyan-200" />
              <div role="group" aria-label="QPU capacity presets" className="flex flex-wrap gap-1.5">{QUBIT_PRESETS.map((value) => (
                <button key={value} type="button" aria-pressed={capacity === value} onClick={() => setAvailableQubits(String(value))} className={["min-h-8 rounded-md border px-2 py-1.5 font-mono text-[11px]", capacity === value ? "border-cyan-700/50 dark:border-cyan-400/50 bg-cyan-700/10 dark:bg-cyan-400/10 text-cyan-800 dark:text-cyan-200" : "border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400 hover:border-slate-400 dark:hover:border-slate-600"].join(" ")}>{formatValue(value)}</button>
              ))}</div>
              <div className="ml-2 flex min-w-0 flex-wrap items-center gap-2 border-l border-slate-400 dark:border-slate-600/80 pl-4">
                <span className="text-[9px] font-semibold uppercase tracking-wider text-slate-600 dark:text-slate-400">Tiers</span>
                <ParallelizationTiers key={workload} compact workload={workload} scale={scale} availableQubits={capacity} onSelect={(value) => setAvailableQubits(String(value))} />
              </div>
            </div>
            <p id="capacity-help" className={validCapacity ? "sr-only" : "mt-1 text-[10px] text-rose-700 dark:text-rose-300"}>{validCapacity ? "Usable qubits per QPU stage. Changes apply on Run simulation." : "Enter a whole qubit count from 1 to 2,147,483,647."}</p>
          </div>
        </section>

        {restoreMessage && <p role="status" className="mb-2 text-[11px] text-cyan-800 dark:text-cyan-200">{restoreMessage}</p>}
        {loading && (
          <div role="status" aria-label="Simulation loading" className="mb-6 flex items-start gap-3 rounded-xl border border-cyan-700/20 dark:border-cyan-400/20 bg-cyan-700/5 dark:bg-cyan-400/5 p-4">
            <LoaderCircle size={18} className="mt-0.5 shrink-0 animate-spin text-cyan-700 dark:text-cyan-400 motion-reduce:animate-none" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-cyan-800 dark:text-cyan-200">{state.slow ? "The engine is taking a little longer" : "Running your simulation"}</p>
              <p className="mt-1 text-xs leading-6 text-slate-600 dark:text-slate-400">{state.slow ? "The Render engine may be waking up. We’ll wait up to 90 seconds; you can keep this page open or try again." : "Fetching engine telemetry. Your controls remain available while the simulation runs."}</p>
            </div>
            {state.slow && <button type="button" onClick={runSimulation} className="shrink-0 rounded-md border border-cyan-700/30 dark:border-cyan-400/30 px-3 py-2 text-xs text-cyan-800 dark:text-cyan-200">Try again</button>}
          </div>
        )}

        {error && (
          <div role="alert" className="mb-6 flex items-start gap-3 rounded-xl border border-rose-700/30 dark:border-rose-400/30 bg-rose-700/10 dark:bg-rose-400/10 p-4">
            <CircleAlert className="mt-0.5 shrink-0 text-rose-700 dark:text-rose-400" size={18} />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-rose-700 dark:text-rose-300">Simulation could not be completed</p>
              <p className="mt-1 text-sm leading-6 text-rose-800 dark:text-rose-200/75 [overflow-wrap:anywhere]">{error}</p>
              {snapshot && <p className="mt-2 text-xs text-slate-600 dark:text-slate-400">Showing the last successful simulation below.</p>}
            </div>
            <button type="button" onClick={runSimulation} className="rounded-md border border-rose-700/30 dark:border-rose-400/30 px-3 py-2 text-xs text-rose-800 dark:text-rose-200">Retry</button>
          </div>
        )}

        <section aria-label="Simulation results" aria-busy={loading} className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-1 text-[10px]">
            <p className="text-slate-600 dark:text-slate-400">{data && snapshot ? <><span className="font-medium text-slate-800 dark:text-slate-200">{data.scale_label}</span><span className="mx-2 text-slate-300 dark:text-slate-700">/</span>{hardwareLabel(snapshot.request.hardware_profile)}</> : "Choose a configuration, then click Run simulation"}</p>
            <p className="flex items-center gap-1.5 text-slate-600 dark:text-slate-400">{loading
              ? <><LoaderCircle size={12} className="animate-spin" />{data ? "Updating · previous result shown" : "Waiting for engine telemetry"}</>
              : configurationChanged ? "Configuration changed · previous result shown" : data ? <><Check size={13} className="text-emerald-700 dark:text-emerald-400" />Simulation complete</> : "No simulation results yet"}</p>
          </div>
          <div data-testid="telemetry-summary-band" className="grid gap-3 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.6fr)]">
          <div aria-label="Key performance indicators" className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-2">
            {[
              { label: "Pipeline latency", value: timing?.totalMs, unit: "ms", icon: Activity },
              { label: quantum?.node === "QPU" ? "Qubits allocated / available" : "Logical qubits", value: quantum?.node === "QPU" ? `${formatValue(quantum.metrics.qubits_allocated)} / ${formatValue(quantum.metrics.available_qubits)}` : quantum?.metrics.qubits_required, unit: "qubits", icon: Layers3 },
              { label: "Circuit depth", value: quantum?.metrics.circuit_depth, unit: "gates", icon: Workflow },
              { label: "Coherence survival", value: coherence?.survival, unit: "%", icon: Zap },
            ].map(({ label, value, unit, icon: Icon }) => (
              <div key={label} className="min-w-0 overflow-hidden rounded-lg border border-slate-200 dark:border-slate-800 console-panel bg-white dark:bg-slate-900/35">
                <div className="console-header flex items-center justify-between gap-2 border-b border-slate-300 dark:border-slate-700/80 px-2.5 py-1">
                  <p className="text-[9px] font-bold uppercase leading-3 tracking-wider text-slate-900 dark:text-slate-100">{label}</p><Icon size={12} className="shrink-0 text-cyan-700 dark:text-cyan-300/70" />
                </div>
                <div className="px-2.5 py-1.5">
                <p title={label === "Pipeline latency" ? formatRawMilliseconds(value) : formatValue(value) + " " + unit} className="break-words font-mono text-base leading-5 tracking-tight">{label === "Pipeline latency" ? formatDuration(value) : <>{summaryValue(value)}<span className="ml-1 text-[10px] text-slate-600 dark:text-slate-400">{unit}</span></>}</p>
                {label === "Pipeline latency" && <dl aria-label="Pipeline latency breakdown" title="Includes separately reported QPU I/O; GPU launch/transfer overhead is counted once. Blocked stages contribute no time." className="mt-1 space-y-0.5 text-[9px] leading-3">
                  <div className="flex flex-wrap justify-between gap-x-2"><dt className="text-slate-600 dark:text-slate-400">Pure Compute Time</dt><dd title={formatRawMilliseconds(timing?.computeMs)} className="font-mono text-slate-700 dark:text-slate-300">{formatDuration(timing?.computeMs)}</dd></div>
                  <div className="flex flex-wrap justify-between gap-x-2"><dt className="text-slate-600 dark:text-slate-400">Interconnect &amp; State-Prep Overhead</dt><dd title={formatRawMilliseconds(timing?.overheadMs)} className="font-mono text-slate-700 dark:text-slate-300">{formatDuration(timing?.overheadMs)}</dd></div>
                </dl>}
                {label === "Coherence survival" && <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                  <p className="text-[9px] leading-3 text-slate-600 dark:text-slate-400">{coherence?.classical ? "Deterministic Classical Emulation" : "vs. 100% deterministic classical baseline"}</p>
                  {coherence?.status && <span aria-label={`Coherence Budget Status: ${coherence.status}`} className={["inline-flex rounded border px-1.5 py-0.5 text-[8px] font-semibold tracking-wider", COHERENCE_BUDGET_STYLE[coherence.status]].join(" ")}>{coherence.status}</span>}
                </div>}
                </div>
              </div>
            ))}
          </div>
          <section aria-label="Telemetry & Co-Design Summary" className="min-w-0 overflow-hidden rounded-xl border border-slate-200 dark:border-slate-800 console-panel bg-white dark:bg-slate-900/35">
            <h2 className="console-header border-b border-slate-300 dark:border-slate-700/80 px-3 py-1 text-[9px] font-bold uppercase tracking-wider text-cyan-900 dark:text-cyan-100">Telemetry &amp; Co-Design Summary</h2>
            <div className="grid divide-y divide-slate-200 dark:divide-slate-800 sm:grid-cols-[minmax(0,0.85fr)_minmax(0,1.2fr)_minmax(0,1fr)] sm:divide-x sm:divide-y-0">
              <div aria-label="Primary bottleneck" className={`min-w-0 p-3 ${data ? style.background : ""}`}>
                <div className={`console-header -mx-3 -mt-3 -mb-px flex items-center gap-1.5 border-b border-slate-300 dark:border-slate-700/80 px-3 pt-3 ${data ? style.text : "text-cyan-700 dark:text-cyan-300"}`}>{limited ? <CircleAlert size={14} className="shrink-0" /> : <Activity size={14} className="shrink-0" />}<p className="text-[9px] font-bold uppercase tracking-wider text-slate-900 dark:text-slate-100">{data ? limited ? "Hardware limitation detected" : "Pipeline operating within limits" : "Primary bottleneck"}</p></div>
                <h3 className="mt-2 text-[10px] font-medium leading-4 text-slate-800 dark:text-slate-200 [overflow-wrap:anywhere]" data-testid="bottleneck">{data?.primary_bottleneck ?? "Run a simulation to evaluate this pipeline."}</h3>
                <div className="mt-1 flex items-center gap-1 text-[9px] text-slate-600 dark:text-slate-400">Modeled telemetry<InfoPopover label="About telemetry estimates"><p>{data?.execution_mode === "LIVE_QISKIT_AER" ? "Circuit executed on a classical Qiskit Aer simulator. Reported stage timings and coherence are model estimates." : "Analytical projections of hardware requirements and coherence; no large-scale quantum circuit is executed."}</p></InfoPopover></div>
              </div>
              <OffloadVerdictStrip compact snapshot={snapshot} />
              <LatencyProportion compact data={data} />
            </div>
          </section>
          </div>

          <section aria-label="Execution pipeline">
            <div className="mb-[7px] flex flex-wrap items-center justify-between gap-2 border-b border-slate-300 dark:border-slate-700/80">
              <div className="flex flex-wrap items-center gap-3"><h2 className="text-sm font-semibold text-cyan-900 dark:text-cyan-100">Execution pipeline</h2>
                <p aria-label="Selected stage routing" className="flex items-center gap-1.5 font-mono text-[10px] text-slate-600 dark:text-slate-400">{PIPELINE.map(({ routingKey }, index) => <span key={routingKey} className="inline-flex items-center gap-1.5">{index > 0 && <ArrowRight size={10} />}<span className={NODE_STYLE[routing[routingKey]].text}>{routing[routingKey]}</span></span>)}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <CaptureBenchmark key={snapshot?.id ?? "idle"} snapshot={snapshot} disabled={loading || !!(snapshot && persistentHistory.isDeleted(snapshot.id))} busy={!!(snapshot && persistentHistory.busyIds.includes(snapshot.id))} onCapture={persistentHistory.nameSnapshot} />
                <p role="status" aria-label="Pipeline configuration status" className={`text-[10px] ${configurationChanged ? "text-amber-700 dark:text-amber-300" : "text-slate-600 dark:text-slate-400"}`}>{loading ? "Running submitted configuration…" : configurationChanged ? "Uncommitted changes" : data ? "Up to date" : "Ready to run"}</p>
                <button type="button" aria-label={loading ? "Simulating from pipeline" : "Run simulation from pipeline"} disabled={loading || !validCapacity} onClick={runSimulation} className="inline-flex min-h-8 items-center gap-1.5 rounded-lg border border-cyan-700/30 dark:border-cyan-400/30 bg-cyan-700/10 dark:bg-cyan-400/10 px-3 py-1.5 text-[11px] font-semibold text-cyan-800 dark:text-cyan-200 hover:bg-cyan-700/20 dark:hover:bg-cyan-400/20 disabled:cursor-not-allowed disabled:opacity-50">{loading ? <LoaderCircle size={12} className="animate-spin" /> : <Play size={12} />}{loading ? "Simulating…" : "Run simulation"}</button>
              </div>
            </div>
            <div className="grid gap-3 lg:grid-cols-3">{PIPELINE.map(({ key, routingKey }, index) => (
              <div key={key} className="relative min-w-0">
                <PipelineCard index={index} stage={snapshot?.request.workload_id === workload ? data?.stages[key] : undefined} selectedNode={routing[routingKey]} onNodeChange={(node) => updateNode(routingKey, node)} pending={loading} workload={workload} />
                {index < 2 && <span aria-hidden="true" className="pointer-events-none absolute -bottom-3 left-1/2 z-10 grid size-6 -translate-x-1/2 place-items-center rounded-full border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-600 dark:text-slate-400 lg:-right-5 lg:bottom-auto lg:left-auto lg:top-1/2 lg:-translate-y-1/2 lg:translate-x-0"><ArrowRight size={12} className="hidden lg:block" /><ArrowDown size={12} className="lg:hidden" /></span>}
              </div>
            ))}</div>
          </section>
        </section>

        <div data-testid="analytics-row" className="mt-4 grid items-start gap-4 lg:grid-cols-2">
        <TelemetryAdvisor key={snapshot?.id ?? "idle"} snapshot={snapshot} previous={latest?.before}
          onInsight={saveRun} onPersisted={() => { void persistentHistory.refresh(); }} simulationLoading={loading} saving={persistentHistory.savingCount > 0}
          savedInsight={persistentHistory.runs.find((run) => run.id === snapshot?.id)?.advisorInsight}
          persistenceMessage={persistentHistory.message} />
        <section aria-label="State delta tracker" className="min-w-0 overflow-hidden rounded-xl border border-slate-200 dark:border-slate-800 console-panel bg-white dark:bg-slate-900/35">
          <div className="console-header flex flex-wrap items-center justify-between gap-2 border-b border-slate-300 dark:border-slate-700/80 p-3">
            <div className="flex items-center gap-2"><GitCompareArrows size={16} className="text-cyan-700 dark:text-cyan-300" /><div><h2 className="text-sm font-semibold text-cyan-900 dark:text-cyan-100">State delta tracker</h2><p className="mt-0.5 text-[10px] text-slate-600 dark:text-slate-400">Consecutive successful runs in this workload · last six transitions</p></div></div>
            <span className="rounded-md bg-slate-100 dark:bg-slate-800 px-2 py-1 font-mono text-[10px] text-slate-600 dark:text-slate-400">{history.length} TRANSITIONS</span>
          </div>
          {latest ? (
            <div className="max-h-[520px] overflow-y-auto p-3">
              <div className="mb-3 flex flex-wrap items-center gap-2 text-[10px]">
                <span className="text-slate-600 dark:text-slate-400">Latest change</span>
                <span className="rounded-md border border-slate-300 dark:border-slate-700 px-2 py-1 font-mono text-slate-700 dark:text-slate-300">{workloadScaleLabel(latest.before.request.scale_param, latest.before.request.workload_id)}</span>
                <ArrowRight size={12} className="text-slate-600 dark:text-slate-400" />
                <span className="rounded-md border border-cyan-700/25 dark:border-cyan-400/25 bg-cyan-700/10 dark:bg-cyan-400/10 px-2 py-1 font-mono text-cyan-700 dark:text-cyan-300">{workloadScaleLabel(latest.after.request.scale_param, latest.after.request.workload_id)}</span>
                <span className="text-slate-600 dark:text-slate-400">{hardwareLabel(latest.after.request.hardware_profile)}</span>
              </div>
              <DeltaTable changes={latest.changes} />
              {history.length > 1 && <div className="mt-3 space-y-2">{history.slice(1).map((transition) => (
                <details key={transition.id} className="rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2">
                  <summary className="cursor-pointer text-xs text-slate-600 dark:text-slate-400">Comparison {transition.id} · {workloadScaleLabel(transition.before.request.scale_param, transition.before.request.workload_id)} → {workloadScaleLabel(transition.after.request.scale_param, transition.after.request.workload_id)} · {transition.changes.length} changes</summary>
                  <div className="mt-4"><DeltaTable changes={transition.changes} /></div>
                </details>
              ))}</div>}
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2 p-5 text-center">
              <GitCompareArrows size={20} className="text-slate-500 dark:text-slate-600" />
              <p className="text-xs text-slate-600 dark:text-slate-400">{data ? "Baseline captured. Adjust your configuration and run again to compare results." : "Your first successful run establishes a baseline."}</p>
              <p className="text-[10px] text-slate-500 dark:text-slate-600">Scale, hardware, status, latency, and stage metrics are tracked automatically.</p>
            </div>
          )}
        </section>
        </div>
        <PersistentRunHistory key={workload} workload={workload} history={persistentHistory} onRestore={restoreRun} />
        <footer className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 dark:border-slate-800/70 pt-3 text-[10px] leading-5 text-slate-600 dark:text-slate-400">
          <p className="flex items-center gap-2"><Radio size={12} />{data?.execution_mode.replaceAll("_", " ") ?? "AWAITING TELEMETRY"}</p>
          <p>Simulated workloads. Estimated hardware limits. No physical QPU connection.</p>
        </footer>
      </main>
    </div>
  );
}

/**
 * Render precomputed metric differences with raw duration hover values, without recomputing comparison semantics.
 */
function DeltaTable({ changes }: { changes: Transition["changes"] }) {
  if (!changes.length) return <p className="text-xs text-slate-600 dark:text-slate-400">No metric changes from the previous successful run.</p>;
  return (
    <div role="region" aria-label="Metric changes" tabIndex={0} className="overflow-x-auto rounded-sm">
      <table className="w-full min-w-[420px] table-fixed text-left text-[11px]">
        <thead><tr className="border-b border-slate-200 dark:border-slate-800 text-[10px] uppercase tracking-wider text-slate-600 dark:text-slate-400"><th className="pb-2 pr-3 font-medium">Parameter / metric</th><th className="pb-2 pr-3 font-medium">Previous</th><th className="pb-2 font-medium">Current</th></tr></thead>
        <tbody>{changes.map((change) => (
          <tr key={change.label} className="border-b border-slate-200 dark:border-slate-800/60 last:border-0">
            <th scope="row" className="py-1.5 pr-3 font-normal capitalize text-slate-600 dark:text-slate-400 [overflow-wrap:anywhere]">{change.label}</th>
            <td title={change.beforeRaw} className="py-1.5 pr-3 font-mono text-slate-600 dark:text-slate-400 [overflow-wrap:anywhere]">{change.before}</td>
            <td title={change.afterRaw} className="py-1.5 font-mono text-slate-800 dark:text-slate-200 [overflow-wrap:anywhere]">{change.after}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}


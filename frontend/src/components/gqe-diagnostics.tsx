import type { StageTelemetry, HybridTelemetryResponse } from "@/types/telemetry";
import { formatDuration } from "@/lib/duration";
import { formatBytes } from "@/lib/skqd";
import { GQE_SURVIVAL_SCOPE, GQE_MODE_LABELS } from "@/lib/gqe";

const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("en-US", { maximumSignificantDigits: 6 }) : "—";
const duration = (value: unknown) => typeof value === "number" && value > 0 && value < 0.005
  ? `${number(value * 1000)} µs` : formatDuration(value);
function Grid({ rows }: { rows: [string, string][] }) {
  return <dl className="grid grid-cols-2 gap-2 text-[11px]">{rows.map(([label, value]) => <div key={label} className="min-w-0"><dt className="text-slate-600 dark:text-slate-400">{label}</dt><dd className="mt-0.5 break-words font-mono text-slate-900 dark:text-slate-100">{value}</dd></div>)}</dl>;
}

export function GqeStageDiagnostics({ stage, index }: { stage: StageTelemetry; index: number }) {
  const m = stage.metrics, memory = m.ai_memory;
  const counts = m.execution_plan;
  const rows: [string, string][] = index === 0 ? [["One-time setup", duration(m.setup_ms)], ["Autoregressive generation", duration(m.generation_compute_ms)],
    ["Initialization", duration(m.initialization_ms)], ["Checkpoint load", duration(m.checkpoint_load_ms)], ["GPU epoch launches", duration(m.gpu_launch_overhead_ms)], ["Transformer parameters", number(m.transformer_parameters)]] : index === 2 ? [
    ["Energy reduction", duration(m.energy_reduction_ms)], ["Replay buffer updates", duration(m.replay_buffer_management_ms)],
    ["Logit-matching gradients", duration(m.training_compute_ms)], ["AdamW optimizer", duration(m.optimizer_compute_ms)],
    ["GPU epoch launches", duration(m.gpu_launch_overhead_ms)], ["Cross-device synchronization", duration(m.cross_device_transfer_ms)]] : [
    ["Generated circuits · E × C", number(counts?.total_generated_circuits)], ["Basis evaluations · E × C × G", number(counts?.total_circuit_evaluations)],
    ["Total shots · E × C × G × S", number(counts?.total_shots)], ["QPU launches · E", m.launch_count === undefined ? "QPU comparison only" : number(m.launch_count)],
    ["Logical depth / native depth", `${number(m.circuit_spec?.depth)} / ${stage.node === "QPU" ? number(m.circuit_depth) : "not reported on classical route"}`],
    [stage.node === "QPU" ? "QPU launch total · E × T_launch" : "Classical epoch launch / transfer", duration(stage.node === "QPU" ? m.launch_overhead_ms : m.launch_transfer_overhead_ms)],
    ["QPU evaluation comparison", formatDuration(m.qpu_evaluation_comparison?.latency_ms)]];
  return <section aria-label={`GQE Stage ${index + 1} diagnostics`} className="mb-2 min-w-0 space-y-2 rounded border border-emerald-600/20 bg-emerald-600/5 p-2">
    <Grid rows={rows} />
    {index === 1 && <p className="text-[10px] leading-4 text-slate-600 dark:text-slate-400">One pre-measurement state per generated circuit is reused across Pauli groups in classical emulation; shots reuse each distribution. Full evolutions are not multiplied by G × S.</p>}
    {memory && <details className="border-t border-emerald-600/20 pt-2"><summary className="cursor-pointer text-[11px] font-medium text-emerald-900 dark:text-emerald-200">AI memory · {memory.shared_classical_device ? "shared device" : "separate devices"}</summary>
      <div className="mt-2"><Grid rows={[["Model weights", formatBytes(memory.weights_bytes)], ["Gradients", formatBytes(memory.gradients_bytes)],
        ["AdamW + FP32 master", formatBytes(memory.optimizer_and_master_weights_bytes)], ["Inference KV cache", formatBytes(memory.inference_kv_cache_bytes)],
        ["Training activations / logits", formatBytes(memory.training_activations_and_logits_bytes)], ["Replay buffer", formatBytes(memory.replay_buffer_bytes)], ["Operator pool", formatBytes(memory.operator_pool_bytes)],
        ["Stage 1 standalone peak", formatBytes(memory.stage1_peak_memory_bytes)], ["Stage 3 standalone peak", formatBytes(memory.stage3_peak_memory_bytes)],
        ...Object.entries(memory.coexisting_device_peak_memory_bytes).map(([device, bytes]): [string, string] => [`${device} coexisting peak`, formatBytes(bytes)])]} /></div>
      <p className="mt-2 text-[10px] leading-4 text-slate-600 dark:text-slate-400">Persistent weights/optimizer/replay remain resident. KV and training activation workspace are reused between serial phases. These are required bytes; host capacity and utilization are not measured.</p>
    </details>}
    {index === 0 && m.historical_offline_pretraining_reference?.latency_ms != null && <p className="text-[10px] leading-4 text-slate-600 dark:text-slate-400">Historical offline pretraining reference: <strong>{duration(m.historical_offline_pretraining_reference.latency_ms)}</strong> · excluded from active run latency; an illustrative training/optimizer reference.</p>}
    {m.execution_feasible === false && <p className="text-[10px] text-rose-700 dark:text-rose-300">Preflight blocked: no epoch loop executed. Resource requirements remain available.</p>}
  </section>;
}

export function GqeLoopDiagnostics({ data }: { data: HybridTelemetryResponse }) {
  const first = data.stages.stage_1_classical_pre, kernel = data.stages.stage_2_quantum_kernel, last = data.stages.stage_3_classical_post;
  const p = kernel.metrics.gqe_parameters, plan = kernel.metrics.execution_plan, ratio = last.metrics.ai_to_qpu_latency_ratio;
  const memory = first.metrics.ai_memory;
  const baseline = kernel.metrics.classical_cpu_baseline as Record<string, unknown> | undefined;
  return <section aria-label="GQE serial loop diagnostics" className="mb-2 min-w-0 rounded-xl border border-emerald-600/25 bg-white p-3 dark:bg-slate-900/40 lg:col-span-2">
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-semibold text-emerald-900 dark:text-emerald-200">GPT-QE · accumulated serial loop</h2><p className="rounded border border-emerald-600/20 px-2 py-1 text-[11px] font-medium text-emerald-900 dark:text-emerald-200">{last.metrics.bottleneck_regime === "classical_ai_bound" ? "Classical AI bound" : last.metrics.bottleneck_regime === "qpu_evaluation_bound" ? "QPU evaluation bound" : "Crossover unavailable"} · {ratio == null ? "—" : `${number(ratio)}× AI / QPU`}</p></div>
    <p className="mb-2 font-mono text-[11px] leading-5 text-slate-800 dark:text-slate-200">Setup → [Generate (Stage 1) → Evaluate (Stage 2) → Update/Train (Stage 3)] × {plan?.epochs.toLocaleString() ?? "—"} epochs</p>
    <p className="mb-3 text-[11px] text-slate-600 dark:text-slate-400">The cards accumulate categories across this loop. {p ? GQE_MODE_LABELS[p.training_mode] : ""} · {GQE_SURVIVAL_SCOPE}</p>
    <div className="grid gap-3 md:grid-cols-3"><Grid rows={[["Generated circuits", number(plan?.total_generated_circuits)], ["Basis evaluations", number(plan?.total_circuit_evaluations)], ["Physical shots", number(plan?.total_shots)], [kernel.node === "QPU" ? "Representative native depth" : "Representative logical depth", number(kernel.metrics.circuit_depth)]]} />
      <Grid rows={[["Stage 1 accumulated", formatDuration(first.latency_ms)], ["Stage 2 accumulated", formatDuration(kernel.latency_ms)], ["Stage 3 accumulated", formatDuration(last.latency_ms)], ["Cross-device transfer (included)", formatDuration(last.metrics.cross_device_transfer_ms)]]} />
      <Grid rows={[["CPU evolution compute", duration(baseline?.state_preparation_compute_ms)], ["CPU group reductions", duration(baseline?.measurement_groups_compute_ms)], ["Reused CPU statevector", formatBytes(baseline?.memory_required_bytes)],
        ...Object.entries(memory?.coexisting_device_peak_memory_bytes ?? {}).map(([device, bytes]): [string, string] => [`${device} coexisting AI peak`, formatBytes(bytes)])]} />
    </div>
    {kernel.metrics.coexisting_device_peak_including_emulation_bytes && <p className="mt-3 text-[11px] text-slate-600 dark:text-slate-400">AI plus emulation peak requirements: {Object.entries(kernel.metrics.coexisting_device_peak_including_emulation_bytes).map(([device, bytes]) => `${device} ${formatBytes(bytes)}`).join(" · ")}</p>}
  </section>;
}

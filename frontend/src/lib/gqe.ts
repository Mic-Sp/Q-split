import type { CompletedRun } from "@/types/run-history";
import type { GQEParameters, GQEAIMemory, GQEExecutionPlan, SimulationRequest, StageMetrics, StageNode } from "@/types/telemetry";

export const GQE_FIELDS = [
  { key: "epochs", label: "Epochs E", min: 1, max: 5000 },
  { key: "circuits_per_epoch", label: "Circuits per epoch C", min: 1, max: 250 },
  { key: "sequence_length", label: "Token sequence length", min: 4, max: 200 },
  { key: "vocabulary_size", label: "Operator pool vocabulary L", min: 32, max: 2048 },
  { key: "pauli_measurement_groups", label: "Pauli measurement groups G", min: 1, max: 250 },
  { key: "shots_per_group", label: "Shots per group S", min: 100, max: 100_000 },
  { key: "gradient_steps_per_epoch", label: "Gradient steps per epoch", min: 1, max: 50 },
  { key: "minibatch_size", label: "Minibatch size B", min: 8, max: 256 },
  { key: "replay_buffer_capacity", label: "Replay buffer capacity", min: 100, max: 50_000 },
] as const;
export type GQENumericKey = typeof GQE_FIELDS[number]["key"];
export interface GQEDraft {
  training_mode: GQEParameters["training_mode"];
  values: Record<GQENumericKey, string>;
  overridden: GQENumericKey[];
}
export const GQE_SURVIVAL_SCOPE = "Representative per-shot circuit survival (does not guarantee training convergence or chemical energy accuracy).";
export const GQE_MODE_LABELS = { from_scratch: "Online From-Scratch", pretrained_finetune: "Pretrained Fine-Tuning" };

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid GQE object.");
  return value as Record<string, unknown>;
}
function numeric(value: unknown, min = 0, max = Number.MAX_VALUE, integer = false): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isSafeInteger(value))) throw new Error("Invalid GQE numeric value.");
  return value;
}
const optionalTime = (value: unknown) => value === null ? null : numeric(value);
export function gqeDefaults(q: number, mode: GQEParameters["training_mode"] = "from_scratch"): GQEParameters {
  if (![4, 10, 12].includes(q)) throw new Error("GQE requires 4, 10, or 12 qubits.");
  return { training_mode: mode, epochs: (q === 4 ? 200 : q === 10 ? 1000 : 1500) / (mode === "pretrained_finetune" ? 5 : 1),
    circuits_per_epoch: 50, sequence_length: q === 4 ? 10 : q === 10 ? 40 : 80, vocabulary_size: 4 * q * q + 16,
    pauli_measurement_groups: q === 4 ? 5 : q === 10 ? 25 : 45, shots_per_group: 1024,
    gradient_steps_per_epoch: 5, minibatch_size: 50, replay_buffer_capacity: 1000 };
}
/** Preset/mode defaults precede strict validation, matching FastAPI's resolver. */
export function parseGqeParameters(q: number, value: unknown): GQEParameters {
  const input = value == null ? {} : record(value);
  if (Object.keys(input).some(key => key !== "training_mode" && !GQE_FIELDS.some(field => field.key === key))) throw new Error("Unknown GQE parameter.");
  const mode = input.training_mode === undefined ? "from_scratch" : input.training_mode;
  if (mode !== "from_scratch" && mode !== "pretrained_finetune") throw new Error("Invalid GQE training mode.");
  const output = gqeDefaults(q, mode);
  for (const field of GQE_FIELDS) output[field.key] = input[field.key] === undefined ? output[field.key] : numeric(input[field.key], field.min, field.max, true);
  return output;
}
export const gqeKey = (q: number, value: unknown) => JSON.stringify(parseGqeParameters(q, value));
export function gqeDraft(q = 4, captured?: GQEParameters | null): GQEDraft {
  const parameters = parseGqeParameters(q, captured);
  return { training_mode: parameters.training_mode, values: Object.fromEntries(GQE_FIELDS.map(field => [field.key, String(parameters[field.key])])) as GQEDraft["values"],
    overridden: captured ? GQE_FIELDS.map(field => field.key) : [] };
}
export function editGqeDraft(draft: GQEDraft, key: GQENumericKey, value: string): GQEDraft {
  return { ...draft, values: { ...draft.values, [key]: value }, overridden: [...new Set([...draft.overridden, key])] };
}
export function changeGqePreset(draft: GQEDraft, q: number, mode = draft.training_mode): GQEDraft {
  const parameters = gqeDefaults(q, mode);
  return { training_mode: mode, overridden: [...draft.overridden], values: Object.fromEntries(GQE_FIELDS.map(field =>
    [field.key, draft.overridden.includes(field.key) ? draft.values[field.key] : String(parameters[field.key])])) as GQEDraft["values"] };
}
export function parametersFromGqeDraft(q: number, draft: GQEDraft): GQEParameters {
  return parseGqeParameters(q, { training_mode: draft.training_mode, ...Object.fromEntries(GQE_FIELDS.map(field =>
    [field.key, /^\d+$/.test(draft.values[field.key]) ? Number(draft.values[field.key]) : NaN])) });
}
export function gqeMultiplicities(p: GQEParameters): GQEExecutionPlan {
  const circuits = p.epochs * p.circuits_per_epoch, evaluations = circuits * p.pauli_measurement_groups;
  return { model_version: 1, epochs: p.epochs, circuits_per_epoch: p.circuits_per_epoch,
    pauli_measurement_groups: p.pauli_measurement_groups, shots_per_group: p.shots_per_group,
    total_generated_circuits: circuits, total_circuit_evaluations: evaluations, total_shots: evaluations * p.shots_per_group };
}

const MEMORY_FIELDS = ["weights_bytes", "gradients_bytes", "optimizer_and_master_weights_bytes", "inference_kv_cache_bytes",
  "training_activations_and_logits_bytes", "replay_buffer_bytes", "operator_pool_bytes", "stage1_peak_memory_bytes", "stage3_peak_memory_bytes"] as const;
function deviceMemory(value: unknown): Partial<Record<"CPU" | "GPU", number>> {
  const source = record(value);
  if (Object.keys(source).some(key => key !== "CPU" && key !== "GPU")) throw new Error("Invalid GQE memory device.");
  return Object.fromEntries(Object.entries(source).map(([key, value]) => [key, numeric(value, 0, Number.MAX_SAFE_INTEGER, true)]));
}
export function sanitizeGqeMemory(value: unknown): GQEAIMemory {
  const source = record(value);
  if (typeof source.shared_classical_device !== "boolean") throw new Error("Invalid GQE device residency.");
  return { ...Object.fromEntries(MEMORY_FIELDS.map(key => [key, numeric(source[key], 0, Number.MAX_SAFE_INTEGER, true)])),
    shared_classical_device: source.shared_classical_device,
    coexisting_device_peak_memory_bytes: deviceMemory(source.coexisting_device_peak_memory_bytes),
    persistent_device_memory_bytes: deviceMemory(source.persistent_device_memory_bytes) } as GQEAIMemory;
}
const NUMERIC_FIELDS = ["transformer_parameters", "pool_construction_operations", "pool_construction_ms", "initialization_ms", "checkpoint_load_ms", "setup_ms",
  "generation_flops_per_epoch", "generation_flops_total", "generation_compute_ms", "gpu_launch_overhead_ms", "energy_reduction_operations_per_epoch",
  "energy_reduction_ms", "replay_occupied_records", "replay_sort_operations_per_epoch", "replay_io_bytes_per_epoch", "replay_buffer_management_ms",
  "training_flops_per_epoch", "training_flops_total", "optimizer_flops_per_epoch", "optimizer_bytes_per_epoch", "training_compute_ms",
  "optimizer_compute_ms", "cross_device_sync_bytes_per_epoch", "cross_device_sync_bytes_total", "cross_device_transfer_ms",
  "launch_count", "shots", "n_2q", "t_circuit_us", "state_preparation_compute_ms", "measurement_groups_compute_ms"] as const;

/** Rebuild only bounded numeric data and fixed vocabulary for the advisor trust boundary. */
export function sanitizeGqeMetrics(value: unknown, q: number, node?: StageNode): StageMetrics {
  const source = record(value), output: StageMetrics = {};
  for (const key of NUMERIC_FIELDS) if (source[key] !== undefined) output[key] = numeric(source[key]);
  for (const key of ["gqe_model_version", "ai_model_version"] as const) {
    if (source[key] !== undefined) {
      if (source[key] !== 1) throw new Error("Unsupported GQE model version.");
      output[key] = 1;
    }
  }
  if (source.gqe_parameters !== undefined) output.gqe_parameters = parseGqeParameters(q, source.gqe_parameters);
  if (source.execution_plan !== undefined) {
    const plan = record(source.execution_plan);
    if (plan.model_version !== 1) throw new Error("Unsupported GQE execution plan.");
    const p = parseGqeParameters(q, { epochs: plan.epochs, circuits_per_epoch: plan.circuits_per_epoch,
      pauli_measurement_groups: plan.pauli_measurement_groups, shots_per_group: plan.shots_per_group });
    const expected = gqeMultiplicities(p);
    for (const key of Object.keys(expected) as (keyof GQEExecutionPlan)[]) if (plan[key] !== expected[key]) throw new Error("Invalid GQE multiplicity.");
    output.execution_plan = expected;
  }
  if (source.ai_memory !== undefined) output.ai_memory = sanitizeGqeMemory(source.ai_memory);
  if (source.coexisting_device_peak_including_emulation_bytes !== undefined) output.coexisting_device_peak_including_emulation_bytes = deviceMemory(source.coexisting_device_peak_including_emulation_bytes);
  for (const key of ["ai_to_qpu_latency_ratio", "qpu_evaluation_latency_ms"] as const) if (source[key] !== undefined) output[key] = optionalTime(source[key]);
  if (source.bottleneck_regime !== undefined) {
    if (source.bottleneck_regime !== "qpu_evaluation_bound" && source.bottleneck_regime !== "classical_ai_bound" && source.bottleneck_regime !== "unavailable") throw new Error("Invalid GQE crossover regime.");
    output.bottleneck_regime = source.bottleneck_regime;
  }
  if (source.uniform_resource_assumption !== undefined) {
    if (source.uniform_resource_assumption !== true) throw new Error("GQE requires the uniform-resource proxy.");
    output.uniform_resource_assumption = true;
  }
  if (source.survival_scope !== undefined) {
    if (source.survival_scope !== "representative_per_shot") throw new Error("Invalid GQE survival scope.");
    output.survival_scope = "representative_per_shot";
  }
  if (source.qpu_evaluation_comparison !== undefined) {
    const comparison = record(source.qpu_evaluation_comparison);
    if (typeof comparison.comparison_only !== "boolean" || comparison.survival_scope !== "representative_per_shot") throw new Error("Invalid GQE comparison.");
    output.qpu_evaluation_comparison = { comparison_only: comparison.comparison_only, latency_ms: optionalTime(comparison.latency_ms),
      coherence_survival_pct: numeric(comparison.coherence_survival_pct, 0, 100), survival_scope: "representative_per_shot" };
  }
  if (source.historical_offline_pretraining_reference !== undefined) {
    const history = record(source.historical_offline_pretraining_reference);
    if (history.included_in_active_latency !== false) throw new Error("Historical pretraining cannot be charged to the active run.");
    output.historical_offline_pretraining_reference = { latency_ms: optionalTime(history.latency_ms), included_in_active_latency: false,
      reference_training_epochs: numeric(history.reference_training_epochs, 1, 5000, true) };
  }
  if (source.ai_accelerator_profile !== undefined) {
    const profile = record(source.ai_accelerator_profile);
    const gpu = node === "GPU";
    const expected = { flops_per_second: gpu ? 18e12 : 0.25e12, bandwidth_bytes_per_second: gpu ? 600e9 : 50e9,
      gpu_launch_ms_per_epoch: gpu ? 0.3 : 0, checkpoint_load_ms: gpu ? 4.5 : 12 };
    for (const [key, value] of Object.entries(expected)) if (profile[key] !== value) throw new Error("GQE accelerator assumptions do not match the model.");
    output.ai_accelerator_profile = expected;
  }
  if (source.ai_model_provenance !== undefined) {
    const provenance = record(source.ai_model_provenance);
    for (const [key, value] of Object.entries({ version: 1, layers: 6, d_model: 384, attention_heads: 6, value_type: "model_assumption" }))
      if (provenance[key] !== value) throw new Error("Invalid GQE transformer model.");
    output.ai_model_provenance = { version: 1, layers: 6, d_model: 384, attention_heads: 6, value_type: "model_assumption", precision: "FP16/BF16 with FP32 master weights" };
  }
  return output;
}

export function assertGqeCapture(metrics: StageMetrics, request: SimulationRequest): void {
  if (request.workload_id !== "gqe") return;
  if (!metrics.gqe_parameters || gqeKey(request.scale_param, metrics.gqe_parameters) !== gqeKey(request.scale_param, request.gqe)) throw new Error("GQE parameters do not match captured controls.");
  const expected = gqeMultiplicities(parseGqeParameters(request.scale_param, request.gqe));
  if (!metrics.execution_plan || Object.entries(expected).some(([key, value]) => metrics.execution_plan?.[key as keyof GQEExecutionPlan] !== value)) throw new Error("GQE execution plan does not match captured controls.");
}

/** Compact advisor transport only; saved snapshots keep the complete backend response. */
export function compactGqeAdvisorRun(run: CompletedRun): CompletedRun {
  if (run.request.workload_id !== "gqe") return run;
  return { ...run, telemetry: { ...run.telemetry, stages: Object.fromEntries(Object.entries(run.telemetry.stages).map(([key, stage]) => {
    const scalars = Object.fromEntries(Object.entries(stage.metrics).filter(([field, value]) => typeof value !== "object" || value === null || field === "circuit_spec" || field === "qpu_profile" || field === "log_survival_terms"));
    return [key, { ...stage, output_summary: "", metrics: { ...scalars, ...sanitizeGqeMetrics(stage.metrics, run.request.scale_param, stage.node) } }];
  })) } };
}

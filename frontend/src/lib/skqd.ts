import type { CompletedRun } from "@/types/run-history";
import type { SKQDParameters, SKQDFamilySurvival, SKQDMember, StageMetrics } from "@/types/telemetry";

export const SKQD_DEFAULTS: Readonly<SKQDParameters> = Object.freeze({
  krylov_dimension: 5, trotter_steps: 6, shots_per_state: 100_000, retained_subspace_dimension: 10_000,
});
export const SKQD_FIELDS = [
  { key: "krylov_dimension", label: "Krylov dimension d", min: 2, max: 15 },
  { key: "trotter_steps", label: "Trotter steps per power m", min: 1, max: 20 },
  { key: "shots_per_state", label: "Shots per Krylov state", min: 1_000, max: 1_000_000 },
  { key: "retained_subspace_dimension", label: "Retained subspace dimension R", min: 100, max: 250_000 },
] as const;
export type SKQDDraft = Record<keyof SKQDParameters, string>;
export const skqdDraft = (value: SKQDParameters = SKQD_DEFAULTS): SKQDDraft => ({
  krylov_dimension: String(value.krylov_dimension), trotter_steps: String(value.trotter_steps),
  shots_per_state: String(value.shots_per_state), retained_subspace_dimension: String(value.retained_subspace_dimension),
});

/** Match the strict nested backend model, including partial-object defaults. */
export function parseSkqdParameters(value: unknown): SKQDParameters {
  if (value == null) return { ...SKQD_DEFAULTS };
  const input = record(value);
  if (Object.keys(input).some(key => !SKQD_FIELDS.some(field => field.key === key))) throw new Error("Unknown SKQD parameter.");
  const result = { ...SKQD_DEFAULTS };
  for (const field of SKQD_FIELDS) {
    const item = input[field.key] === undefined ? result[field.key] : input[field.key];
    result[field.key] = bounded(item, field.min, field.max, true);
  }
  return result;
}

export function parametersFromSkqdDraft(draft: SKQDDraft): SKQDParameters {
  const input = Object.fromEntries(SKQD_FIELDS.map(field => [field.key, /^\d+$/.test(draft[field.key]) ? Number(draft[field.key]) : NaN]));
  return parseSkqdParameters(input);
}
export const skqdKey = (value: unknown) => JSON.stringify(parseSkqdParameters(value));
export const effectiveSkqdSubspace = (q: number, value: SKQDParameters) =>
  Math.min(value.retained_subspace_dimension, 2 ** q, value.krylov_dimension * value.shots_per_state);
export function formatBytes(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "—";
  if (value === 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB", "EiB"];
  const power = Math.max(0, Math.min(units.length - 1, Math.floor(Math.log2(value) / 10)));
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value / 1024 ** power)} ${units[power]}`;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid SKQD telemetry.");
  return value as Record<string, unknown>;
}
function bounded(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER, integer = false): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isSafeInteger(value))) throw new Error("Invalid SKQD numeric value.");
  return value;
}
const probability = (value: unknown) => bounded(value, 0, 1);
const logValue = (value: unknown) => value === null ? null : bounded(value, -Number.MAX_VALUE, 0);

function survival(value: unknown): SKQDFamilySurvival {
  const input = record(value), deepest = record(input.deepest_member);
  if (input.aggregation !== "shot_weighted_log_sum_exp" || input.governing_scalar !== "shot_weighted_mean") throw new Error("Invalid family survival policy.");
  const range = (item: Record<string, unknown>) => {
    const point = probability(item.point), best = probability(item.best), worst = probability(item.worst);
    if (worst > point || point !== best) throw new Error("Invalid family survival range.");
    return { point, best, worst, log_point: logValue(item.log_point) };
  };
  return { aggregation: "shot_weighted_log_sum_exp", governing_scalar: "shot_weighted_mean",
    ...range(input), log_worst: logValue(input.log_worst),
    expected_surviving_samples: bounded(input.expected_surviving_samples, 0, 15_000_000),
    deepest_member: { power_index: bounded(deepest.power_index, 0, 14, true), ...range(deepest) } };
}

/** Fixed numeric whitelist for advisor input; no backend/user prose enters prompts. */
const NUMERIC_FIELDS = ["skqd_model_version", "family_model_version", "circuit_family_size", "deepest_circuit_depth",
  "shots", "n_2q", "t_circuit_us", "krylov_dimension", "total_raw_samples", "hamiltonian_pauli_terms",
  "requested_subspace_dimension", "retained_subspace_dimension", "recovery_bit_operations", "projection_operations",
  "solver_flops", "solver_iterations", "nonzeros_per_row", "projected_matrix_nnz", "projected_matrix_value_bytes",
  "projected_matrix_index_bytes", "solver_workspace_bytes", "subspace_peak_memory_bytes", "cpu_recovery_ms",
  "cpu_projection_ms", "cpu_eigensolver_ms", "cpu_postprocessing_ms", "cpu_preprocessing_ms", "recovery_compute_ms",
  "projection_compute_ms", "eigensolver_compute_ms", "classical_cost_model_version"] as const;

export function sanitizeSkqdMetrics(value: unknown): StageMetrics {
  const input = record(value), output: StageMetrics = {};
  for (const key of NUMERIC_FIELDS) if (input[key] !== undefined) (output as Record<string, unknown>)[key] = bounded(input[key]);
  for (const key of ["skqd_model_version", "family_model_version"] as const) {
    if (input[key] !== undefined && input[key] !== 1) throw new Error("Unsupported SKQD model version.");
  }
  if (input.circuit_family_size !== undefined) output.circuit_family_size = bounded(input.circuit_family_size, 2, 15, true);
  if (input.krylov_dimension !== undefined) output.krylov_dimension = bounded(input.krylov_dimension, 2, 15, true);
  if (input.total_raw_samples !== undefined) output.total_raw_samples = bounded(input.total_raw_samples, 2000, 15_000_000, true);
  for (const key of ["retained_subspace_dimension", "requested_subspace_dimension"] as const)
    if (input[key] !== undefined) output[key] = bounded(input[key], 100, 250_000, true);
  if (input.skqd_parameters !== undefined) output.skqd_parameters = parseSkqdParameters(input.skqd_parameters);
  if (input.family_survival !== undefined) output.family_survival = survival(input.family_survival);
  for (const key of ["classical_to_quantum_latency_ratio", "qpu_family_sampling_latency_ms"] as const) {
    if (input[key] !== undefined) output[key] = input[key] === null ? null : bounded(input[key], 0, Number.MAX_VALUE);
  }
  if (input.bottleneck_regime !== undefined) {
    if (typeof input.bottleneck_regime !== "string" || !["quantum-sampling-bound", "classical-diagonalization-bound", "unavailable"].includes(input.bottleneck_regime)) throw new Error("Invalid crossover regime.");
    output.bottleneck_regime = input.bottleneck_regime as StageMetrics["bottleneck_regime"];
  }
  if (input.qpu_sampling_comparison !== undefined) {
    const comparison = record(input.qpu_sampling_comparison);
    if (typeof comparison.comparison_only !== "boolean") throw new Error("Invalid QPU comparison.");
    output.qpu_sampling_comparison = { comparison_only: comparison.comparison_only,
      latency_ms: comparison.latency_ms === null ? null : bounded(comparison.latency_ms),
      family_survival: comparison.family_survival === null ? null : survival(comparison.family_survival) };
  }
  if (input.krylov_members !== undefined) {
    if (!Array.isArray(input.krylov_members) || input.krylov_members.length > 15 || input.krylov_members.length < 2) throw new Error("Invalid Krylov family size.");
    output.krylov_members = input.krylov_members.map((value, index): SKQDMember => {
      const member = record(value), spec = record(member.circuit_spec);
      if (member.power_index !== index) throw new Error("Krylov powers must be ordered from zero.");
      const circuit_spec = { n_qubits: bounded(spec.n_qubits, 1, 85, true), depth: bounded(spec.depth, 0, 1681, true),
        n_1q: bounded(spec.n_1q, 0, Number.MAX_SAFE_INTEGER, true), n_2q: bounded(spec.n_2q, 0, Number.MAX_SAFE_INTEGER, true),
        n_meas: bounded(spec.n_meas, 0, 85, true), stage1_ms: bounded(spec.stage1_ms, 0, 0), stage3_ms: bounded(spec.stage3_ms, 0, 0) };
      const physical = member.metrics ?? member.qpu_comparison_metrics;
      const result: SKQDMember = { power_index: index, shots: bounded(member.shots, 1000, 1_000_000, true), circuit_spec };
      if (physical !== undefined) {
        const raw = record(physical), clean: StageMetrics = {};
        for (const key of ["circuit_depth", "n_2q", "t_circuit_us", "latency_ms", "gate_execution_ms", "measurement_reset_ms", "repetition_delay_ms", "link_execution_ms"])
          if (raw[key] !== undefined) clean[key] = bounded(raw[key]);
        for (const key of ["coherence_survival", "coherence_survival_best", "coherence_survival_worst"] as const)
          if (raw[key] !== undefined) clean[key] = probability(raw[key]);
        if (raw.coherence_log_survival !== undefined) clean.coherence_log_survival = logValue(raw.coherence_log_survival);
        if (typeof raw.execution_feasible === "boolean") clean.execution_feasible = raw.execution_feasible;
        if (member.metrics !== undefined) result.metrics = clean;
        else result.qpu_comparison_metrics = clean;
      }
      return result;
    });
    if (output.circuit_family_size !== undefined && output.krylov_members.length !== output.circuit_family_size) throw new Error("Krylov family size mismatch.");
  }
  return output;
}

/** Keep two maximum-size runs below the advisor body limit; persistence stays full fidelity. */
export function compactSkqdAdvisorRun(run: CompletedRun): CompletedRun {
  if (run.request.workload_id !== "skqd") return run;
  return { ...run, telemetry: { ...run.telemetry, stages: Object.fromEntries(Object.entries(run.telemetry.stages).map(([key, stage]) => {
    const scalars = { ...stage.metrics };
    for (const field of ["classical_baselines", "classical_cpu_baseline", "selected_classical_baselines", "preparation_provenance", "solver_provenance", "krylov_members"]) delete scalars[field];
    return [key, { ...stage, output_summary: "", metrics: { ...scalars, ...sanitizeSkqdMetrics(stage.metrics) } }];
  })) } };
}

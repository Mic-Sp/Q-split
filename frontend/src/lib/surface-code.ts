import type { CustomQPUProfileSpec, SurfaceCodeInputs, SurfaceCodeMetadata } from "@/types/telemetry";

export const SURFACE_CODE_DEFAULTS = { code_distance_d: 27, physical_2q_error: 0.001, threshold_error: 0.01, syndrome_cycle_ns: 1000 } as const;
export const MIN_ROUND_ERROR = 1e-18;
const REFERENCE_ROUND_ERROR = Math.exp(Math.log(0.1) + 14 * (Math.log(0.001) - Math.log(0.01)));
export const SURFACE_CODE_DERIVED_FIELDS = ["n_qubits_max", "n_physical_qubits", "t1_us", "t2_us", "t_1q_ns", "t_2q_ns", "t_meas_ns", "t_reset_ns", "err_1q", "err_2q", "err_meas", "topology_factor", "native_2q_per_cx"] as const;

/** Deterministic V1 round scaling and explicit reference operation-error calibration.
 *
 * The raw Fowler proxy is ~1e-15 at the reference, not the preset's 1e-9.
 * Fixed operation budget multipliers (approximately 1e5 / 1e6) align that
 * proxy with the existing logical targets. They are simulator assumptions.
 * Keep them independent of d so the clamped proxy remains monotonic below
 * threshold. Timing still charges d rounds for surgery/readout.
 */
export function calculateSurfaceCode(input: SurfaceCodeInputs) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Provide surface-code inputs.");
  const { code_distance_d: d, physical_2q_error: p, threshold_error: threshold, syndrome_cycle_ns: cycle, logical_qubits_target: target } = input;
  if (!Number.isSafeInteger(d) || d < 3 || d % 2 !== 1) throw new Error("Code distance must be an odd integer at least 3.");
  if (!Number.isSafeInteger(target) || target < 1 || target > 2147483647) throw new Error("Logical capacity must be a whole number from 1 to 2,147,483,647.");
  if (typeof p !== "number" || !Number.isFinite(p) || p <= 0 || p >= 1 || typeof threshold !== "number" || !Number.isFinite(threshold) || threshold <= 0 || threshold >= 1) throw new Error("Physical and threshold error probabilities must lie strictly between 0 and 1.");
  if (typeof cycle !== "number" || !Number.isFinite(cycle) || cycle <= 0) throw new Error("Syndrome cycle time must be positive and finite.");
  const patch = 2 * d * d, footprint = patch * target, gateNs = d * cycle;
  if (!Number.isSafeInteger(footprint) || !Number.isFinite(gateNs) || gateNs <= 0) throw new Error("Surface-code footprint or timing exceeds the supported numerical range.");
  const roundLog = Math.log(0.1) + ((d + 1) / 2) * (Math.log(p) - Math.log(threshold));
  const epsilon = roundLog <= Math.log(MIN_ROUND_ERROR) ? MIN_ROUND_ERROR : roundLog >= 0 ? 1 : Math.exp(roundLog);
  const scale = epsilon / REFERENCE_ROUND_ERROR;
  const err1q = Math.min(1, 1e-10 * scale), err2q = Math.min(1, 1e-9 * scale);
  const metadata: SurfaceCodeMetadata = { model_version: 1, code_distance_d: d, physical_2q_error: p, threshold_error: threshold,
    syndrome_cycle_ns: cycle, logical_qubits_target: target, physical_qubits_per_logical: patch };
  return { metadata, is_below_threshold: p < threshold, physical_qubits_per_logical: patch, total_physical_qubits: footprint,
    nighthawk_r3_modules_required: Math.ceil(footprint / 520), physical_element_equivalent_modules: Math.ceil(footprint / 2034),
    logical_error_per_round: epsilon, round_log_error_unclamped: roundLog, round_error_clamped: roundLog < Math.log(MIN_ROUND_ERROR) || roundLog > 0,
    t_1q_ns: cycle, t_2q_ns: gateNs, t_meas_ns: gateNs, t_reset_ns: cycle,
    err_1q: err1q, err_2q: err2q, err_meas: err2q, logical_error_suppression_ratio: p / err2q };
}

export function parseSurfaceCodeMetadata(value: unknown): SurfaceCodeMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid surface-code generator metadata.");
  const source = value as Record<string, unknown>;
  const fields = ["model_version", "code_distance_d", "physical_2q_error", "threshold_error", "syndrome_cycle_ns", "logical_qubits_target", "physical_qubits_per_logical"];
  if (Object.keys(source).some(key => !fields.includes(key)) || (source.model_version !== undefined && source.model_version !== 1)) throw new Error("Unknown surface-code generator field or version.");
  const result = calculateSurfaceCode(source as unknown as SurfaceCodeInputs);
  if (source.physical_qubits_per_logical !== result.physical_qubits_per_logical) throw new Error("Surface-code patch footprint must equal 2*d².");
  return result.metadata;
}

export function surfaceCodeProfileFields(input: SurfaceCodeInputs) {
  const result = calculateSurfaceCode(input);
  return { n_qubits_max: input.logical_qubits_target, n_physical_qubits: result.total_physical_qubits,
    t1_us: null, t2_us: null, t_1q_ns: result.t_1q_ns, t_2q_ns: result.t_2q_ns, t_meas_ns: result.t_meas_ns,
    t_reset_ns: result.t_reset_ns, err_1q: result.err_1q, err_2q: result.err_2q, err_meas: result.err_meas,
    topology_factor: 1, native_2q_per_cx: 1 };
}

/** Explicitly convert to one logical workspace; physical chip counts are metadata,
 * not logical module topology or a grant of programmable qubit capacity. */
export function applySurfaceCodeParameters(profile: CustomQPUProfileSpec, input: SurfaceCodeInputs): CustomQPUProfileSpec {
  const result = calculateSurfaceCode(input);
  return { ...profile, ...surfaceCodeProfileFields(input), surface_code: result.metadata,
    repetition_rate_hz: null, max_operations: null, module_count: 1, qubits_per_module: null,
    l_couplers_active: 0, l_couplers_installed: 0, state_transfer_fidelity: null,
    state_transfer_target_fidelity: null, transfer_duration_ns: null };
}

/** Reject stale generation claims while allowing identity and unrelated metadata edits. */
export function validateSurfaceCodeProfile(profile: CustomQPUProfileSpec): void {
  if (!profile.surface_code) return;
  const expected = surfaceCodeProfileFields(profile.surface_code);
  for (const field of SURFACE_CODE_DERIVED_FIELDS) {
    const actual = profile[field], target = expected[field];
    const exact = field === "n_qubits_max" || field === "n_physical_qubits" || field === "topology_factor" || field === "native_2q_per_cx";
    if (target === null || exact ? actual !== target : typeof actual !== "number" || Math.abs(actual - target) > Math.abs(target) * 1e-10) {
      throw new Error("Surface-code metadata does not match generated physics. Reapply the calculator or remove the generator tag after manual edits.");
    }
  }
}

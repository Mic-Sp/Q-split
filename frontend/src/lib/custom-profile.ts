import { BUILTIN_HARDWARE_PROFILE_IDS, type BuiltinHardwareProfile, type CustomQPUProfileSpec, type QPUProfile, type SurfaceCodeMetadata } from "@/types/telemetry";
import { HARDWARE_PROFILES, MODULAR_QPU_PROFILES, RESOURCE_QPU_PROFILES } from "@/lib/hardware-profiles";
import { parseSurfaceCodeMetadata, validateSurfaceCodeProfile, SURFACE_CODE_DERIVED_FIELDS } from "@/lib/surface-code";

export const CUSTOM_PRESET_STORAGE_KEY = "q-split.custom-hardware-presets.v1";
export const CUSTOM_NUMBER_FIELDS = ["n_qubits_max", "t1_us", "t2_us", "t_1q_ns", "t_2q_ns", "t_meas_ns", "t_reset_ns", "err_1q", "err_2q", "err_meas", "topology_factor", "native_2q_per_cx", "repetition_rate_hz", "n_physical_qubits", "max_operations", "module_count", "qubits_per_module", "l_couplers_installed", "l_couplers_active", "state_transfer_fidelity", "state_transfer_target_fidelity", "transfer_duration_ns"] as const;
export type CustomNumberField = typeof CUSTOM_NUMBER_FIELDS[number];
export type CustomProfileDraft = Record<CustomNumberField | "name" | "base_profile_id", string> & { surface_code?: SurfaceCodeMetadata | null };
const optionalNullable = new Set<string>(["repetition_rate_hz", "n_physical_qubits", "max_operations", "qubits_per_module", "state_transfer_fidelity", "state_transfer_target_fidelity", "transfer_duration_ns"]);
const nullable = new Set([...optionalNullable, "n_qubits_max", "t1_us", "t2_us"]);
const integer = new Set<string>(["n_qubits_max", "n_physical_qubits", "max_operations", "module_count", "qubits_per_module", "l_couplers_installed", "l_couplers_active"]);
const zeroAllowed = new Set<string>(["t_1q_ns", "t_meas_ns", "t_reset_ns", "err_1q", "err_2q", "err_meas", "l_couplers_installed", "l_couplers_active"]);
const defaults: Partial<Record<CustomNumberField, number>> = { native_2q_per_cx: 1, module_count: 1, l_couplers_active: 0 };

/** Strict JSON boundary shared by requests, advisor, persistence and local presets. */
export function parseCustomProfile(value: unknown): CustomQPUProfileSpec {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Provide a custom hardware profile.");
  const input = value as Record<string, unknown>;
  const keys = new Set<string>([...CUSTOM_NUMBER_FIELDS, "name", "base_profile_id", "surface_code"]);
  if (Object.keys(input).some(key => !keys.has(key))) throw new Error("Unknown custom hardware field.");
  if (typeof input.name !== "string" || !input.name.trim() || input.name.length > 120 || /[\u0000-\u001f\u007f-\u009f]/.test(input.name)) throw new Error("Custom name must contain 1–120 printable characters.");
  if (input.base_profile_id != null && !(BUILTIN_HARDWARE_PROFILE_IDS as readonly unknown[]).includes(input.base_profile_id)) throw new Error("Clone baseline must be a built-in profile.");
  const result: Record<string, unknown> = { name: input.name, base_profile_id: input.base_profile_id ?? null };
  for (const field of CUSTOM_NUMBER_FIELDS) {
    let number = input[field];
    if (number === undefined) number = field === "l_couplers_installed" ? input.l_couplers_active ?? 0 : defaults[field] ?? (optionalNullable.has(field) ? null : undefined);
    if (number === null && nullable.has(field)) { result[field] = null; continue; }
    if (typeof number !== "number" || !Number.isFinite(number) || (integer.has(field) && !Number.isSafeInteger(number))) throw new Error(`${field}: enter a finite ${integer.has(field) ? "whole " : ""}number.`);
    const minimum = field === "topology_factor" || field === "native_2q_per_cx" ? 1 : 0;
    if (number < minimum || (minimum === 0 && !zeroAllowed.has(field) && number === 0)) throw new Error(`${field}: value must be ${minimum === 1 ? "at least 1" : zeroAllowed.has(field) ? "nonnegative" : "positive"}.`);
    if ((field.startsWith("err_") || field.includes("fidelity")) && number > 1) throw new Error(`${field}: probability must be at most 1.`);
    if (field === "module_count" && number > 2) throw new Error("The current partition model supports one or two modules.");
    if (field === "n_qubits_max" && number > 2147483647) throw new Error("Capacity must be at most 2,147,483,647.");
    result[field] = number;
  }
  const spec = result as unknown as CustomQPUProfileSpec;
  if (input.surface_code != null) spec.surface_code = parseSurfaceCodeMetadata(input.surface_code);
  if (spec.l_couplers_active! > spec.l_couplers_installed!) throw new Error("Active l-couplers cannot exceed installed channels.");
  if (spec.module_count === 1 && spec.l_couplers_active) throw new Error("Single-module profiles have zero active cross-module channels.");
  if (spec.module_count! > 1 && (!spec.qubits_per_module || !spec.l_couplers_active || spec.state_transfer_fidelity == null || spec.transfer_duration_ns == null)) throw new Error("Linked modules require qubits/module, active channels, transfer fidelity and duration.");
  if (spec.qubits_per_module != null && spec.n_qubits_max != null && spec.n_qubits_max > spec.module_count! * spec.qubits_per_module) throw new Error("Capacity exceeds the declared module geometry.");
  validateSurfaceCodeProfile(spec);
  return spec;
}

export function customProfileForRequest(profile: string, value: unknown): CustomQPUProfileSpec | undefined {
  if (profile === "custom") return parseCustomProfile(value);
  if (value != null) throw new Error("Custom parameters require the custom hardware selector.");
  return undefined;
}

export function cloneBuiltinProfile(id: BuiltinHardwareProfile): CustomQPUProfileSpec {
  const p = RESOURCE_QPU_PROFILES[id];
  const m = id === "ibm_nighthawk_r3" || id === "ibm_nighthawk_r3_dual" ? MODULAR_QPU_PROFILES[id] : null;
  return parseCustomProfile({ name: `Research: ${id.replaceAll("_", " ")}`, base_profile_id: id,
    n_qubits_max: p.referenceQubits, t1_us: p.t1Us, t2_us: p.t2Us, t_1q_ns: p.t1qNs, t_2q_ns: p.t2qNs,
    t_meas_ns: p.measurementNs, t_reset_ns: p.resetNs, err_1q: p.error1q, err_2q: p.error2q, err_meas: p.errorMeasurement,
    topology_factor: p.depthMultiplier, native_2q_per_cx: p.native2qPerCx, repetition_rate_hz: p.repetitionRateHz,
    n_physical_qubits: m?.physicalQubits ?? (id === "ibm_nighthawk_r2" ? 458 : null), max_operations: m?.maxOperations ?? null,
    module_count: m?.moduleCount ?? 1, qubits_per_module: m?.qubitsPerModule ?? null,
    l_couplers_installed: m?.installedLCouplers ?? 0, l_couplers_active: m?.activeLCouplers ?? 0,
    state_transfer_fidelity: m?.transferFidelity ?? null, state_transfer_target_fidelity: m?.targetTransferFidelity ?? null,
    transfer_duration_ns: m?.transferDurationNs ?? null });
}

export function customProfileDraft(spec: CustomQPUProfileSpec): CustomProfileDraft {
  const parsed = parseCustomProfile(spec);
  return { ...Object.fromEntries([...["name", "base_profile_id"].map(key => [key, parsed[key as "name" | "base_profile_id"] ?? ""]),
    ...CUSTOM_NUMBER_FIELDS.map(key => [key, parsed[key] == null ? "" : String(parsed[key])])]),
    ...(parsed.surface_code ? { surface_code: { ...parsed.surface_code } } : {}) } as CustomProfileDraft;
}

/** Form numbers accept scientific notation, but never coerce blanks to zero. */
export function customProfileFromDraft(draft: CustomProfileDraft): CustomQPUProfileSpec {
  const input: Record<string, unknown> = { name: draft.name, base_profile_id: draft.base_profile_id || null, surface_code: draft.surface_code };
  for (const key of CUSTOM_NUMBER_FIELDS) {
    const text = draft[key].trim();
    if (!text && nullable.has(key)) input[key] = null;
    else {
      if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) throw new Error(`${key}: enter a number${nullable.has(key) ? " or leave blank" : ""}.`);
      input[key] = Number(text);
    }
  }
  return parseCustomProfile(input);
}

/** Raw form edits invalidate derivation only when a generated numeric value changes. */
export function clearEditedSurfaceCode(previous: CustomProfileDraft, next: CustomProfileDraft): CustomProfileDraft {
  if (!next.surface_code) return next;
  const changed = SURFACE_CODE_DERIVED_FIELDS.some(field => {
    const before = previous[field].trim(), after = next[field].trim();
    return before === "" || after === "" ? before !== after : !Number.isFinite(Number(after)) || Number(before) !== Number(after);
  });
  return changed ? { ...next, surface_code: undefined } : next;
}

export const customTopology = (spec: CustomQPUProfileSpec) => spec.module_count! > 1 ? "User-defined linked modules" : "User-defined routing";
export function customResourcePhysics(spec: CustomQPUProfileSpec) {
  return { referenceQubits: spec.n_qubits_max, depthMultiplier: spec.topology_factor, t1Us: spec.t1_us, t2Us: spec.t2_us,
    t1qNs: spec.t_1q_ns, t2qNs: spec.t_2q_ns, measurementNs: spec.t_meas_ns, resetNs: spec.t_reset_ns,
    error1q: spec.err_1q, error2q: spec.err_2q, errorMeasurement: spec.err_meas,
    native2qPerCx: spec.native_2q_per_cx!, repetitionRateHz: spec.repetition_rate_hz ?? null };
}

/** Match embedded, bounded physics to the captured request; discard caller provenance prose. */
export function validateCustomTelemetryProfile(value: unknown, requested: CustomQPUProfileSpec): QPUProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Missing custom qpu_profile telemetry.");
  const profile = value as Record<string, unknown>;
  if (profile.id !== "custom") throw new Error("Custom telemetry profile ID mismatch.");
  const provenance = profile.provenance as Record<string, unknown> | null;
  if (!provenance || typeof provenance !== "object" || Array.isArray(provenance)) throw new Error("Missing custom provenance.");
  const embedded = parseCustomProfile({ ...Object.fromEntries(["name", ...CUSTOM_NUMBER_FIELDS].map(key => [key, profile[key]])), surface_code: profile.surface_code, base_profile_id: provenance.base_profile_id ?? null });
  const expected = parseCustomProfile(requested);
  if (JSON.stringify(embedded) !== JSON.stringify(expected)) throw new Error("Custom telemetry physics does not match captured controls.");
  const { base_profile_id, ...physics } = embedded;
  return { ...physics, id: "custom", provenance: { base_profile_id: base_profile_id ?? null,
    ...(physics.surface_code ? { surface_code: { ...physics.surface_code } } : {}),
    value_types: Object.fromEntries(Object.keys(physics).map(key => [key, "user_defined_custom"])), notes: "User-defined research assumptions; not vendor calibration." } };
}

export interface CustomPreset { name: string; spec: CustomQPUProfileSpec }
export function readCustomPresets(text: string | null): CustomPreset[] {
  if (!text) return [];
  const data = JSON.parse(text);
  if (data?.version !== 1 || !Array.isArray(data.presets)) throw new Error("Unrecognized custom preset format.");
  return data.presets.slice(0, 30).map((preset: CustomPreset) => {
    const spec = parseCustomProfile(preset.spec);
    return { name: spec.name, spec };
  });
}
export function saveCustomPreset(presets: CustomPreset[], profile: CustomQPUProfileSpec): CustomPreset[] {
  const spec = parseCustomProfile(profile);
  return [{ name: spec.name, spec }, ...presets.filter(preset => preset.name !== spec.name)].slice(0, 30);
}
export const encodeCustomPresets = (presets: CustomPreset[]) => JSON.stringify({ version: 1, presets });
export const customBaselineLabel = (spec?: CustomQPUProfileSpec | null) => spec?.base_profile_id ? HARDWARE_PROFILES[spec.base_profile_id].label : "Independent research profile";

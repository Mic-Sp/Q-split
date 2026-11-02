import { HARDWARE_PROFILE_IDS, type HardwareProfile } from "@/types/telemetry";

// Published reference capacities and exploratory choices, including legacy 72-qubit runs.
export const QUBIT_CAPACITY_PRESETS = [16, 36, 53, 72, 133, 1024, 1121, 2048, 4096, 16384];

export const HARDWARE_PROFILES = {
  ibm_heron_nisq: { label: "IBM Heron (133-qubit cap, r3-era timing; representative)", topology: "Heavy-Hex", referenceQubits: 133, depthMultiplier: 1, gateTimeMultiplier: 1, prepMs: 0.15, decayScale: 1200,
    description: "Superconducting transmons · Heavy-Hex connectivity · 133-qubit capacity cap with representative r3-era timing. Baseline routing depth and gate time: 1.0×; 0.15 ms state preparation; decay scale 1200. The N=15 sequential Aer reference retains its legacy 0.05 ms setup." },
  google_weber_grid: { label: "Google Weber (2D Grid)", topology: "2D Square Grid", referenceQubits: 53, depthMultiplier: 0.78, gateTimeMultiplier: 0.45, prepMs: 0.12, decayScale: 850,
    description: "Superconducting transmons · four-neighbor square lattice · 53-qubit reference. The 2021 datasheet specifies 32 ns √iSWAP gates with 0.9% typical isolated error. The resource model assumes two native entanglers per CX; this conversion needs verification against a gate-decomposition reference. Larger capacities are exploratory overrides." },
  ionq_forte_trapped_ion: { label: "IonQ Forte (Trapped Ion)", topology: "All-to-All Ion Trap", referenceQubits: 36, depthMultiplier: 0.55, gateTimeMultiplier: 180, prepMs: 0.85, decayScale: 8500,
    description: "Trapped-ion optical/hyperfine qubits · all-to-all connectivity · 36-qubit reference. Removing SWAP routing layers models 0.55× depth. Laser-driven shared vibrational-mode gates cost 180× gate time, with 0.85 ms combined prep/readout; long coherence uses decay scale 8500." },
  ideal_sim: { label: "Ideal Noise-Free", topology: "Noise-free reference", referenceQubits: null, depthMultiplier: 1, gateTimeMultiplier: 1, prepMs: 0.15, decayScale: null,
    description: "Noise-free reference with 100% coherence; baseline depth and gate time. Capacity is controlled separately; this profile does not imply unlimited qubits or error-corrected hardware. Analytical prep is 0.15 ms; N=15 sequential Aer retains 0.05 ms setup." },
  // Compatibility display fields derive from the logical timings. New runs use
  // RESOURCE_QPU_PROFILES; no legacy exponential-depth survival is calibrated.
  ftqc_surface_code: { label: "FTQC Surface-Code Logical QPU (1 µs cycle, d≈27 target; representative)", topology: "2D Surface-Code Lattice Surgery", referenceQubits: 1024,
    depthMultiplier: 1, gateTimeMultiplier: 27000 / 250, prepMs: (27000 + 1000) / 1e6, decayScale: null,
    description: "Representative logical QPU · 1,024 logical workspace qubits · d≈27 target. A 1 µs syndrome cycle gives 27 µs lattice-surgery 2Q gates and measurements, versus Heron's representative 68 ns physical gate. Roughly 1,000 physical superconducting qubits per logical qubit is a coarse assumption; supporting resources are excluded. Logical error targets of 1e-10 / 1e-9 and active-QEC memory errors folded into logical operation errors are assumptions, not demonstrated performance. Separate T1/T2 decay is disabled to avoid double-counting; logical error suppression does not guarantee speedup. See exported profile provenance for Gidney 2025 and Willow QEC sources." },
} satisfies Record<HardwareProfile, { label: string; topology: string; referenceQubits: number | null; depthMultiplier: number; gateTimeMultiplier: number; prepMs: number; decayScale: number | null; description: string }>;

// Versioned resource-model constants. Legacy timing constants above remain for
// unversioned runs; reference capacities and descriptions reflect the source.
// Backend integration tests verify this trust-boundary map.
export const RESOURCE_QPU_PROFILES = {
  ibm_heron_nisq: { referenceQubits: 133, depthMultiplier: 1.5, t1Us: 200, t2Us: 150, t1qNs: 32, t2qNs: 68,
    measurementNs: 1500, resetNs: 200000, error1q: 0.0003, error2q: 0.003, errorMeasurement: 0.01, native2qPerCx: 1 },
  google_weber_grid: { referenceQubits: 53, depthMultiplier: 1.2, t1Us: 15, t2Us: 20, t1qNs: 25, t2qNs: 32,
    measurementNs: 4000, resetNs: 200000, error1q: 0.001, error2q: 0.009, errorMeasurement: 0.04, native2qPerCx: 2 },
  ionq_forte_trapped_ion: { referenceQubits: 36, depthMultiplier: 1, t1Us: 100000000, t2Us: 1000000, t1qNs: 110000, t2qNs: 900000,
    measurementNs: 250000, resetNs: 1000000, error1q: 0.0002, error2q: 0.004, errorMeasurement: 0.005, native2qPerCx: 1 },
  ideal_sim: { referenceQubits: null, depthMultiplier: 1, t1Us: null, t2Us: null, t1qNs: 32, t2qNs: 250,
    measurementNs: 1500, resetNs: 0, error1q: 0, error2q: 0, errorMeasurement: 0, native2qPerCx: 1 },
  ftqc_surface_code: { referenceQubits: 1024, depthMultiplier: 1, t1Us: null, t2Us: null, t1qNs: 1000, t2qNs: 27000,
    measurementNs: 27000, resetNs: 1000, error1q: 1e-10, error2q: 1e-9, errorMeasurement: 1e-9, native2qPerCx: 1 },
} satisfies Record<HardwareProfile, object>;

/**
 * Narrow untrusted values to known comparative architecture registry keys.
 */
export function isHardwareProfile(value: unknown): value is HardwareProfile {
  return typeof value === "string" && (HARDWARE_PROFILE_IDS as readonly string[]).includes(value);
}

/**
 * Resolve a known profile label while keeping unknown historical identifiers readable.
 */
export function hardwareLabel(value: string) {
  return isHardwareProfile(value) ? HARDWARE_PROFILES[value].label : value;
}

/**
 * Explain topology savings separately from gate-time/coherence assumptions for nonbaseline profiles.
 */
export function architectureTradeOff(profile: HardwareProfile, resourceVersion?: unknown) {
  if (profile === "ftqc_surface_code") return "2D Surface-Code Lattice Surgery: d≈27 × 1 µs syndrome cycle = 27 µs logical 2Q/measurement latency, versus Heron's representative 68 ns physical entangler. Logical operation errors are assumed at 1e-10 / 1e-9 including active-QEC memory errors; separate T1/T2 decay is disabled to avoid double-counting. Batch latency includes shots, measurement/reset and launch; compare logical survival separately from gate time and native classical baselines. Capacity counts logical qubits; roughly 1,000 physical qubits per logical qubit and routing absorbed into bus timing are assumptions.";
  if (resourceVersion === 1 || resourceVersion === 2) {
    const physics = RESOURCE_QPU_PROFILES[profile];
    return `${HARDWARE_PROFILES[profile].topology}: ${physics.depthMultiplier}× routing depth; ${physics.t2qNs} ns representative native entangler; ${physics.native2qPerCx} native 2Q gates per CX (assumed, applied to depth and 2Q count). Batch timing includes shots, measurement/reset and launch. Survival combines gate errors and all-qubit T1 decay; routing and native conversion are approximations.`;
  }
  if (profile === "google_weber_grid") return "Square-grid connectivity reduces modeled SWAP routing to 0.78× Heavy-Hex depth with 0.45× gate time, while its coherence decay window is shorter (850).";
  if (profile === "ionq_forte_trapped_ion") return "All-to-all ion connectivity removes SWAP layers (0.55× depth), but laser-driven shared vibrational-mode gates cost 180× gate time with 0.85 ms prep/readout; the decay scale is 8500.";
  return "";
}

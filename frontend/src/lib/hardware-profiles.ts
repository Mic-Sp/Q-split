import { HARDWARE_PROFILE_IDS, type HardwareProfile } from "@/types/telemetry";

export const HARDWARE_PROFILES = {
  ibm_heron_nisq: { label: "IBM Heron NISQ", topology: "Heavy-Hex", referenceQubits: 133, depthMultiplier: 1, gateTimeMultiplier: 1, prepMs: 0.15, decayScale: 1200,
    description: "Superconducting transmons · Heavy-Hex connectivity · 133-qubit reference. Baseline routing depth and gate time: 1.0×; 0.15 ms state preparation; decay scale 1200. The N=15 sequential Aer reference retains its legacy 0.05 ms setup." },
  google_weber_grid: { label: "Google Weber (2D Grid)", topology: "2D Square Grid", referenceQubits: 72, depthMultiplier: 0.78, gateTimeMultiplier: 0.45, prepMs: 0.12, decayScale: 850,
    description: "Superconducting transmons · four-neighbor square lattice · fast ~20 ns-class fSim/√iSWAP gates. Model: 0.78× Heavy-Hex depth, 0.45× gate time, 0.12 ms prep, decay scale 850. The requested 72-qubit preset is exploratory; Google's published Weber grid has 53 active qubits." },
  ionq_forte_trapped_ion: { label: "IonQ Forte (Trapped Ion)", topology: "All-to-All Ion Trap", referenceQubits: 36, depthMultiplier: 0.55, gateTimeMultiplier: 180, prepMs: 0.85, decayScale: 8500,
    description: "Trapped-ion optical/hyperfine qubits · all-to-all connectivity · 36-qubit reference. Removing SWAP routing layers models 0.55× depth. Laser-driven shared vibrational-mode gates cost 180× gate time, with 0.85 ms combined prep/readout; long coherence uses decay scale 8500." },
  ideal_sim: { label: "Ideal Noise-Free", topology: "Noise-free reference", referenceQubits: null, depthMultiplier: 1, gateTimeMultiplier: 1, prepMs: 0.15, decayScale: null,
    description: "Noise-free reference with 100% coherence; baseline depth and gate time. Capacity is controlled separately; this profile does not imply unlimited qubits or error-corrected hardware. Analytical prep is 0.15 ms; N=15 sequential Aer retains 0.05 ms setup." },
} satisfies Record<HardwareProfile, { label: string; topology: string; referenceQubits: number | null; depthMultiplier: number; gateTimeMultiplier: number; prepMs: number; decayScale: number | null; description: string }>;

export function isHardwareProfile(value: unknown): value is HardwareProfile {
  return typeof value === "string" && (HARDWARE_PROFILE_IDS as readonly string[]).includes(value);
}

export function hardwareLabel(value: string) {
  return isHardwareProfile(value) ? HARDWARE_PROFILES[value].label : value;
}

export function architectureTradeOff(profile: HardwareProfile) {
  if (profile === "google_weber_grid") return "Square-grid connectivity reduces modeled SWAP routing to 0.78× Heavy-Hex depth with 0.45× gate time, while its coherence decay window is shorter (850).";
  if (profile === "ionq_forte_trapped_ion") return "All-to-all ion connectivity removes SWAP layers (0.55× depth), but laser-driven shared vibrational-mode gates cost 180× gate time with 0.85 ms prep/readout; the decay scale is 8500.";
  return "";
}

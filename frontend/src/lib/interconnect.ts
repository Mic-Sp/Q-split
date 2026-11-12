import type { HardwareProfile, InterconnectConfig } from "@/types/telemetry";

export const DEFAULT_INTERCONNECT = { placement: "auto", fidelity_scenario: "demonstrated", transfer_duration_ns: 100 } as const;

/** Shared boundary for proxy, advisor and saved controls; never forward unknown keys. */
export function parseInterconnect(value: unknown, profile: HardwareProfile): InterconnectConfig | undefined {
  if (value === undefined || value === null) return undefined;
  if (profile !== "ibm_nighthawk_r3_dual" || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid interconnect configuration.");
  const source = value as Record<string, unknown>;
  if (Object.keys(source).some(key => !["placement", "fidelity_scenario", "transfer_duration_ns"].includes(key)) ||
      (source.placement !== undefined && source.placement !== "auto" && source.placement !== "dual") ||
      (source.fidelity_scenario !== undefined && source.fidelity_scenario !== "demonstrated" && source.fidelity_scenario !== "target_2027") ||
      (source.transfer_duration_ns != null && (typeof source.transfer_duration_ns !== "number" || !Number.isFinite(source.transfer_duration_ns) ||
        source.transfer_duration_ns <= 0 || source.transfer_duration_ns > 1_000_000))) throw new Error("Invalid interconnect configuration.");
  return { placement: (source.placement as "auto" | "dual" | undefined) ?? "auto",
    fidelity_scenario: (source.fidelity_scenario as "demonstrated" | "target_2027" | undefined) ?? "demonstrated",
    ...(source.transfer_duration_ns == null ? {} : { transfer_duration_ns: source.transfer_duration_ns as number }) };
}

/** Compare effective defaults as well as explicit controls, including historical omissions. */
export function interconnectKey(value?: InterconnectConfig | null): string {
  return JSON.stringify([value?.placement ?? "auto", value?.fidelity_scenario ?? "demonstrated", value?.transfer_duration_ns ?? 100]);
}

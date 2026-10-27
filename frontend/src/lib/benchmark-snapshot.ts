import { DEFAULT_AVAILABLE_QUBITS, DEFAULT_ROUTING } from "@/lib/telemetry";
import type { SavedSimulationRun } from "@/types/run-history";
import type { SimulationRequest } from "@/types/telemetry";

export const SNAPSHOT_NAME_LIMIT = 120;
export const validRunId = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

export function snapshotPatch(value: unknown): { snapshotName: string | null; isSnapshot: boolean } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Provide a snapshot name.");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => key !== "snapshotName" && key !== "isSnapshot")) throw new Error("Only snapshot name and pin status can be changed.");
  if (input.isSnapshot !== undefined && typeof input.isSnapshot !== "boolean") throw new Error("Snapshot pin status must be a boolean.");
  if (input.isSnapshot === false || input.snapshotName === null) {
    if (input.isSnapshot === true || (input.snapshotName !== null && input.snapshotName !== undefined)) throw new Error("An unpinned run must have a null snapshot name.");
    return { snapshotName: null, isSnapshot: false };
  }
  if (typeof input.snapshotName !== "string") throw new Error("Provide a snapshot name.");
  const name = input.snapshotName.normalize("NFC").trim();
  if (!name || name.length > SNAPSHOT_NAME_LIMIT || /[\p{Cc}\p{Cf}]/u.test(name)) throw new Error("Snapshot names must contain 1–120 printable characters.");
  return { snapshotName: name, isSnapshot: true };
}

export function restoredConfiguration(run: SavedSimulationRun): SimulationRequest {
  return { workload_id: run.request.workload_id, scale_param: run.request.scale_param,
    hardware_profile: run.request.hardware_profile,
    available_qubits: run.request.available_qubits ?? DEFAULT_AVAILABLE_QUBITS,
    routing: { ...DEFAULT_ROUTING, ...run.request.routing } };
}

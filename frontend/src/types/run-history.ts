import type { HybridTelemetryResponse, SimulationRequest, StageNode, StageStatus } from "@/types/telemetry";

export interface CompletedRun {
  id: string;
  completedAt: string;
  request: SimulationRequest;
  telemetry: HybridTelemetryResponse;
}

export interface SavedSimulationRun {
  id: string;
  completedAt: string;
  createdAt: string;
  workloadId: string;
  workloadName: string;
  scaleParam: number;
  scaleLabel: string;
  hardwareProfile: string;
  stage1Node: StageNode;
  stage2Node: StageNode;
  stage3Node: StageNode;
  executionMode: string;
  totalLatencyMs: number;
  bottleneckStatus: StageStatus;
  primaryBottleneck: string;
  qubitsRequired: number | null;
  // BigInt is serialized as a decimal string to retain precision in JSON.
  circuitDepth: string | null;
  coherenceSurvivalPct: number | null;
  request: SimulationRequest;
  telemetry: HybridTelemetryResponse;
}

export type HistoryAvailability = "ready" | "unconfigured" | "unavailable";

export type HistoryResult =
  | { status: "ready"; runs: SavedSimulationRun[] }
  | { status: "unconfigured" | "unavailable"; message: string; runs: [] };

export type SaveRunResult =
  | { status: "saved"; run: SavedSimulationRun }
  | { status: "unconfigured" | "unavailable"; message: string };

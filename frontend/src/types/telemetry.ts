export type StageStatus = "OPTIMAL" | "WARNING" | "CRITICAL_BOTTLENECK";
export const HARDWARE_PROFILE_IDS = ["ibm_heron_nisq", "google_weber_grid", "ionq_forte_trapped_ion", "ideal_sim"] as const;
export type HardwareProfile = typeof HARDWARE_PROFILE_IDS[number];
export type WorkloadId = "shors_crypto" | "quantum_mips";
export type StageNode = "CPU" | "GPU" | "QPU";

/** Three sequential placement selectors; route labels describe projected costs, not physical dispatch. */
export interface RoutingConfig {
  stage_1_node: StageNode;
  stage_2_node: StageNode;
  stage_3_node: StageNode;
}

/** Captured run controls; scale meaning and qubit-tier formulas are workload-specific. */
export interface SimulationRequest {
  workload_id: WorkloadId;
  scale_param: number;
  hardware_profile: HardwareProfile;
  available_qubits?: number;
  routing?: Partial<RoutingConfig> | null;
}

/** Alternative idle terms in natural logs; null denotes negative infinity (certain failure). */
export interface LogSurvivalTerms {
  two_qubit: number | null;
  one_qubit: number | null;
  measurement: number | null;
  idle_t1: number | null;
  idle_t2: number | null;
}

/** Optional typed fields keep historical runs and workload-specific extra metrics readable. */
export interface StageMetrics extends Record<string, unknown> {
  coherence_survival?: number;
  coherence_survival_pct?: number;
  coherence_survival_best?: number;
  coherence_survival_worst?: number;
  /** Natural log of T1 point; retained through probability underflow, null for unavailable/certain failure. */
  coherence_log_survival?: number | null;
  log_survival_terms?: LogSurvivalTerms | null;
}

/** Per-stage wire telemetry: current GPU/QPU batch latency includes I/O; legacy fields remain supported. */
export interface StageTelemetry {
  name: string;
  node: StageNode;
  latency_ms: number;
  status: StageStatus;
  output_summary: string;
  metrics: StageMetrics;
}

/** Canonical backend response with three keyed stages and explicit live-reference versus analytical provenance. */
export interface HybridTelemetryResponse {
  workload_id: string;
  workload_name: string;
  scale_label: string;
  execution_mode: "LIVE_QISKIT_AER" | "NISQ_ANALYTICAL_PROFILER";
  primary_bottleneck: string;
  stages: Record<string, StageTelemetry>;
}

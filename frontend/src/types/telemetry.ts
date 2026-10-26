export type StageStatus = "OPTIMAL" | "WARNING" | "CRITICAL_BOTTLENECK";
export type HardwareProfile = "ibm_heron_nisq" | "ideal_sim";
export type WorkloadId = "shors_crypto" | "quantum_mips";

export interface SimulationRequest {
  workload_id: WorkloadId;
  scale_param: number;
  hardware_profile: HardwareProfile;
}

export interface StageTelemetry {
  name: string;
  node: "CPU" | "QPU";
  latency_ms: number;
  status: StageStatus;
  output_summary: string;
  metrics: Record<string, unknown>;
}

export interface HybridTelemetryResponse {
  workload_id: string;
  workload_name: string;
  scale_label: string;
  execution_mode: "LIVE_QISKIT_AER" | "NISQ_ANALYTICAL_PROFILER";
  primary_bottleneck: string;
  stages: Record<string, StageTelemetry>;
}

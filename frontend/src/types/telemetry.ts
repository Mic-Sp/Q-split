export type StageStatus = "OPTIMAL" | "WARNING" | "CRITICAL_BOTTLENECK";
export const BUILTIN_HARDWARE_PROFILE_IDS = ["ibm_heron_nisq", "ibm_nighthawk_r2", "ibm_nighthawk_r3", "ibm_nighthawk_r3_dual", "google_weber_grid", "ionq_forte_trapped_ion", "ftqc_surface_code", "ideal_sim"] as const;
export type BuiltinHardwareProfile = typeof BUILTIN_HARDWARE_PROFILE_IDS[number];
export const HARDWARE_PROFILE_IDS = [...BUILTIN_HARDWARE_PROFILE_IDS, "custom"] as const;
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
  interconnect?: InterconnectConfig | null;
  custom_profile?: CustomQPUProfileSpec | null;
}

export interface InterconnectConfig {
  placement?: "auto" | "dual";
  fidelity_scenario?: "demonstrated" | "target_2027";
  /** Configurable architectural assumption; backend default is 100 ns per round. */
  transfer_duration_ns?: number | null;
}

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** Per-shot circuit resources before hardware routing; host/native times are milliseconds. */
export interface CircuitSpec {
  n_qubits: number;
  depth: number;
  n_1q: number;
  n_2q: number;
  n_meas: number;
  stage1_ms: number;
  stage3_ms: number;
  native_classical_ms?: number | null;
  native_classical_name?: string | null;
  interconnect?: InterconnectConfig | null;
}

/** Backend QPU characterization. Null capacity/coherence fields represent the ideal reference. */
export interface QPUProfile {
  id: string;
  name: string;
  n_qubits_max: number | null;
  t1_us: number | null;
  t2_us: number | null;
  t_1q_ns: number;
  t_2q_ns: number;
  t_meas_ns: number;
  t_reset_ns: number;
  err_1q: number;
  err_2q: number;
  err_meas: number;
  topology_factor: number;
  /** Omitted by historical profiles created before native-entangler conversion was introduced. */
  native_2q_per_cx?: number;
  /** Optional peak shot rate (Hz); omitted/null keeps timing-only legacy behavior. */
  repetition_rate_hz?: number | null;
  n_physical_qubits?: number | null;
  max_operations?: number | null;
  module_count?: number;
  qubits_per_module?: number | null;
  l_couplers_installed?: number;
  l_couplers_active?: number;
  state_transfer_fidelity?: number | null;
  state_transfer_target_fidelity?: number | null;
  transfer_duration_ns?: number | null;
  provenance: Record<string, JsonValue>;
}

export interface CustomQPUProfileSpec extends Omit<QPUProfile, "id" | "provenance"> {
  base_profile_id?: BuiltinHardwareProfile | null;
}

/** Alternative idle terms in natural logs; null denotes negative infinity (certain failure). */
export interface LogSurvivalTerms {
  two_qubit: number | null;
  one_qubit: number | null;
  measurement: number | null;
  idle_t1: number | null;
  idle_t2: number | null;
  /** Absent on historical five-term records. */
  interconnect?: number | null;
}

/** Optional typed fields keep historical runs and workload-specific extra metrics readable. */
export interface StageMetrics extends Record<string, unknown> {
  resource_model_version?: 1 | 2;
  circuit_spec?: CircuitSpec;
  qpu_profile?: QPUProfile;
  launch_overhead_ms?: number;
  /** Readout/reset plus optional repetition pacing; already included in latency. */
  measurement_reset_ms?: number;
  /** Subset of measurement_reset_ms, never an extra additive cost. */
  repetition_delay_ms?: number;
  gate_execution_ms?: number;
  qpu_io_included_in_latency?: boolean;
  coherence_survival?: number;
  coherence_survival_pct?: number;
  coherence_survival_best?: number;
  coherence_survival_worst?: number;
  /** Natural log of T1 point; retained through probability underflow, null for unavailable/certain failure. */
  coherence_log_survival?: number | null;
  log_survival_terms?: LogSurvivalTerms | null;
  interconnect_model_version?: 1;
  modules_used?: number;
  transfers_per_shot?: number;
  scheduled_transfer_rounds?: number;
  link_time_ns?: number;
  /** Subset of gate_execution_ms: coherent transfer/stall time over all shots. */
  link_execution_ms?: number;
  link_log_survival?: number;
  selected_transfer_fidelity?: number | null;
  fidelity_scenario?: "demonstrated" | "target_2027";
  module_placement?: "auto" | "dual";
  transfer_duration_ns?: number | null;
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
  /** Optional on historical responses; missing versions are V1. Persisted inside telemetry JSON. */
  resource_model_version?: 1 | 2;
  routing_model?: string;
  workload_id: string;
  workload_name: string;
  scale_label: string;
  execution_mode: "LIVE_QISKIT_AER" | "NISQ_ANALYTICAL_PROFILER";
  primary_bottleneck: string;
  stages: Record<string, StageTelemetry>;
}

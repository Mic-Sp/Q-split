import type { SimulationRequest, WorkloadId } from "@/types/telemetry";
import { isHardwareProfile } from "@/lib/hardware-profiles";

export const WORKLOADS = {
  shors_crypto: { label: "Shor’s cryptography", scales: [15, 21, 35, 512, 2048],
    stages: ["Classical preprocessing", "Quantum kernel", "Classical postprocessing"] },
  quantum_mips: { label: "Quantum-MIPS (LLM Vector Retrieval)", scales: [64, 1024, 32768, 131072, 1048576],
    stages: ["LSH Bucket Pruning", "Quantum Inner-Product & Grover-Max Amplification", "Exact FP16 Dot-Product Reranking"] },
} satisfies Record<WorkloadId, { label: string; scales: number[]; stages: string[] }>;

const MIPS_LABELS: Record<number, string> = {
  64: "M = 64", 1024: "M = 1,024", 32768: "M = 32k", 131072: "M = 128k (LLM Vocab)", 1048576: "M = 1M (RAG Index)",
};

export const SCALE_DESCRIPTIONS: Record<WorkloadId, Record<number, string>> = {
  shors_crypto: {
    15: "4-bit semiprime (3 × 5). Smallest demonstration composite in this simulator; the sequential tier executes a live 8-qubit Qiskit Aer statevector circuit.",
    21: "5-bit semiprime (3 × 7). Requires 13–28 qubits across tiers; demonstrates the transition to analytical NISQ profiling.",
    35: "6-bit semiprime (5 × 7). Requires 15–33 qubits; tests mid-scale NISQ coherence limits across superconducting and ion-trap topologies.",
    512: "512-bit legacy cryptographic key (1,027–2,816 logical qubits). Exceeds classical statevector RAM limits (~2^1027 states) and requires fault-tolerant error correction for viable physical quantum execution.",
    2048: "2,048-bit production cryptographic standard (4,099–11,264 logical qubits). Demonstrates extreme sequential circuit depth (~38.6B gates) and multi-hour modeled QPU execution horizons.",
  },
  quantum_mips: {
    64: "6-bit Toy KV-Cache Block (64 candidate vectors). The sequential tier executes a live 10-qubit Qiskit Aer Grover amplitude amplification circuit; small enough that CPU beats GPU on classical host stages due to 0.30ms PCIe transfer overhead.",
    1024: "10-bit HNSW Subgraph (1,024 candidate vectors). Analytical crossover scale where GPU tensor cores overtake CPU on Stage 1 LSH pruning and Stage 3 FP16 reranking.",
    32768: "15-bit Long-Context KV-Cache (32,768 attention tokens). Models sub-linear quantum attention key lookup across a 32k LLM context window (~142 Grover oracle iterations).",
    131072: "17-bit LLM Vocabulary Unembedding (131,072 tokens). Models final-layer logit search over a modern Llama/GPT-scale vocabulary (~285 Grover iterations).",
    1048576: "20-bit Enterprise RAG Vector Index (1,048,576 embeddings). Models million-scale document retrieval where O(sqrt(M)) Grover depth hits severe NISQ decoherence without Multi-Oracle parallel registers.",
  },
};

export function validWorkloadScale(workload: unknown, scale: unknown): workload is WorkloadId {
  return typeof workload === "string" && Object.hasOwn(WORKLOADS, workload) &&
    typeof scale === "number" && WORKLOADS[workload as WorkloadId].scales.includes(scale);
}

export function workloadScaleLabel(scale: number, workload: WorkloadId = "shors_crypto") {
  return workload === "quantum_mips" ? MIPS_LABELS[scale] ?? `M = ${scale.toLocaleString("en-US")}`
    : scale < 512 ? `N = ${scale}` : `RSA-${scale}`;
}

export function workloadThresholds(scale: number, workload: WorkloadId = "shors_crypto") {
  if (workload === "quantum_mips") {
    const k = Math.ceil(Math.log2(scale));
    return { minimum: k + 4, windowed: 2 * k + 8, ceiling: 4 * k + 16 };
  }
  const n = scale === 512 || scale === 2048 ? scale : Math.ceil(Math.log2(scale));
  return { minimum: scale === 15 ? 8 : 2 * n + 3, windowed: 3 * n, ceiling: Math.ceil(5.5 * n) };
}

export function activeParallelizationTier(scale: number, availableQubits: number, workload: WorkloadId = "shors_crypto"): "minimum" | "windowed" | "ceiling" | null {
  if (!Number.isSafeInteger(availableQubits) || availableQubits < 1 || availableQubits > 2_147_483_647) return null;
  const thresholds = workloadThresholds(scale, workload);
  if (availableQubits >= thresholds.ceiling) return "ceiling";
  if (availableQubits >= thresholds.windowed) return "windowed";
  return availableQubits >= thresholds.minimum ? "minimum" : null;
}

export function preferredMipsHost(scale: number): "CPU" | "GPU" { return scale === 64 ? "CPU" : "GPU"; }

export function mipsRoutingContext(scale: number) {
  const host = preferredMipsHost(scale);
  return `${host} → QPU → ${host} is the modeled preferred host placement ${scale === 64
    ? "at M = 64: CPU avoids the 0.30 ms GPU PCIe launch/transfer penalty on tiny LSH and FP16 batches"
    : "at M ≥ 1,024: GPU tensor parallelism reduces LSH compute to 0.12× and FP16 reranking to 0.10× CPU time, amortizing each 0.30 ms transfer"}. QPU viability still depends on capacity, coherence, and end-to-end latency.`;
}

// The same contract protects proxy requests and persisted benchmark payloads.
export function parseSimulationRequest(value: unknown): SimulationRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid simulation configuration.");
  const input = value as SimulationRequest;
  const workload = input.workload_id === undefined ? "shors_crypto" : input.workload_id;
  const scale = input.scale_param === undefined ? (workload === "quantum_mips" ? 64 : 15) : input.scale_param;
  if (!validWorkloadScale(workload, scale)) throw new Error("Invalid workload or target scale.");
  if (!isHardwareProfile(input.hardware_profile)) throw new Error("Invalid hardware profile.");
  if (input.available_qubits !== undefined && (!Number.isSafeInteger(input.available_qubits) || input.available_qubits < 1 || input.available_qubits > 2_147_483_647)) throw new Error("Invalid available qubits.");
  if (input.routing != null && (typeof input.routing !== "object" || Array.isArray(input.routing) ||
    Object.keys(input.routing).some(key => !["stage_1_node", "stage_2_node", "stage_3_node"].includes(key)) ||
    Object.values(input.routing).some(node => !["CPU", "GPU", "QPU"].includes(node)))) throw new Error("Invalid stage routing.");
  return { workload_id: workload, scale_param: scale, hardware_profile: input.hardware_profile,
    ...(input.available_qubits === undefined ? {} : { available_qubits: input.available_qubits }),
    ...(input.routing == null ? {} : { routing: input.routing }) };
}

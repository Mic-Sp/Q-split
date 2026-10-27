"""Request, capacity, and classical-stage simulation contracts."""

import json
import unittest

from pydantic import ValidationError

from backend.main import (
    QUANTUM_MIPS_DEFAULT_SCALE,
    QUANTUM_MIPS_SCALES,
    QUANTUM_MIPS_WORKLOAD_NAME,
    SimulationRequest,
    qpu_capacity_plan,
    quantum_mips_capacity_plan,
    quantum_mips_qubit_thresholds,
    quantum_mips_preprocessing,
    quantum_mips_postprocessing,
)


SCALES = [
    (64, 6, "M = 64 (6-bit Toy KV-Cache Block)", 10, 20, 40),
    (1024, 10, "M = 1,024 (10-bit HNSW Subgraph)", 14, 28, 56),
    (32768, 15, "M = 32k (15-bit Long-Context KV-Cache)", 19, 38, 76),
    (131072, 17, "M = 128k (17-bit LLM Vocabulary Unembedding)", 21, 42, 84),
    (1048576, 20, "M = 1M (20-bit Enterprise RAG Vector Index)", 24, 48, 96),
]


class QuantumMipsTests(unittest.TestCase):
    def test_scale_metadata_covers_exactly_five_candidate_spaces(self):
        self.assertEqual(QUANTUM_MIPS_WORKLOAD_NAME, "Quantum-MIPS · Sub-Linear LLM Vector Retrieval")
        self.assertEqual(QUANTUM_MIPS_DEFAULT_SCALE, 64)
        self.assertEqual(list(QUANTUM_MIPS_SCALES), [case[0] for case in SCALES])
        for candidates, bits, label, *_ in SCALES:
            with self.subTest(candidates=candidates):
                self.assertEqual(QUANTUM_MIPS_SCALES[candidates], {"index_bits": bits, "label": label})
                self.assertEqual(2 ** bits, candidates)

    def test_request_defaults_preserve_shors_and_choose_a_valid_mips_default(self):
        legacy = SimulationRequest()
        self.assertEqual(legacy.workload_id, "shors_crypto")
        self.assertEqual(legacy.scale_param, 15)
        self.assertEqual(legacy.hardware_profile, "ibm_heron_nisq")
        self.assertEqual(legacy.available_qubits, 133)
        self.assertIsNone(legacy.routing)
        # Existing custom Shor moduli remain supported.
        self.assertEqual(SimulationRequest(scale_param=97).scale_param, 97)
        payload = {"workload_id": "quantum_mips"}
        mips = SimulationRequest.model_validate(payload)
        self.assertEqual(mips.scale_param, 64)
        self.assertEqual(payload, {"workload_id": "quantum_mips"})
        for candidates, *_ in SCALES:
            self.assertEqual(SimulationRequest(workload_id="quantum_mips", scale_param=candidates).scale_param, candidates)

    def test_workload_enum_and_invalid_mips_requests(self):
        workload = SimulationRequest.model_json_schema()["properties"]["workload_id"]
        self.assertEqual(set(workload["enum"]), {"shors_crypto", "quantum_mips"})
        self.assertEqual(workload["default"], "shors_crypto")
        for value in ["unknown", None, True, 42, []]:
            with self.subTest(workload=value), self.assertRaises(ValidationError):
                SimulationRequest(workload_id=value)
        for value in [15, 21, 35, 65, 0, -1, True, 64.0, "64", None, 2_147_483_648]:
            with self.subTest(scale=value), self.assertRaises(ValidationError):
                SimulationRequest(workload_id="quantum_mips", scale_param=value)

    def test_qubit_thresholds_for_every_scale(self):
        for candidates, bits, _, minimum, windowed, ceiling in SCALES:
            with self.subTest(candidates=candidates):
                self.assertEqual(quantum_mips_qubit_thresholds(candidates), {
                    "index_bits": bits, "minimum_qubits_required": minimum,
                    "windowed_qubits_required": windowed, "ceiling_qubits_required": ceiling,
                })

    def test_exact_boundaries_allocation_multipliers_and_idle_capacity(self):
        for candidates, bits, _, minimum, windowed, ceiling in SCALES:
            cases = [
                (minimum - 1, 0, "Blocked · insufficient capacity", None),
                (minimum, minimum, "Sequential Minimum", 1.0),
                (windowed - 1, minimum, "Sequential Minimum", 1.0),
                (windowed, windowed, "Windowed Parallel", 0.40),
                (ceiling - 1, windowed, "Windowed Parallel", 0.40),
                (ceiling, ceiling, "Multi-Oracle Ceiling", 0.20),
                (ceiling + 1, ceiling, "Multi-Oracle Ceiling", 0.20),
                (ceiling + 5000, ceiling, "Multi-Oracle Ceiling", 0.20),
                (2_147_483_647, ceiling, "Multi-Oracle Ceiling", 0.20),
            ]
            for capacity, allocated, tier, multiplier in cases:
                with self.subTest(candidates=candidates, capacity=capacity):
                    result = quantum_mips_capacity_plan(candidates, capacity)
                    self.assertEqual(result["index_bits"], bits)
                    self.assertEqual(result["minimum_qubits_required"], minimum)
                    self.assertEqual(result["available_qubits"], capacity)
                    self.assertEqual(result["qubits_allocated"], allocated)
                    self.assertEqual(result["idle_qubits"], capacity - allocated)
                    self.assertEqual(result["parallelization_tier"], tier)
                    self.assertEqual(result["depth_multiplier"], multiplier)
                    self.assertEqual(result["execution_feasible"], allocated > 0)
                    self.assertEqual(result["parallel_speedup_ceiling_reached"], capacity >= ceiling)
                    self.assertLessEqual(allocated, capacity)
                    json.dumps(result, allow_nan=False)

    def test_oracle_models_and_depth_reductions_are_explicit(self):
        sequential = quantum_mips_capacity_plan(64, 10)
        windowed = quantum_mips_capacity_plan(64, 20)
        multi = quantum_mips_capacity_plan(64, 40)
        self.assertIn("O(sqrt(M))", sequential["oracle_model"])
        self.assertIn("tree-based", windowed["oracle_model"])
        self.assertIn("parallel Grover", multi["oracle_model"])
        self.assertEqual([result["depth_multiplier"] for result in [sequential, windowed, multi]], [1.0, 0.40, 0.20])
        blocked = quantum_mips_capacity_plan(64, 9)
        self.assertIsNone(blocked["depth_multiplier"])
        self.assertEqual(blocked["oracle_model"], "Not executed")
        # Absolute oracle/circuit execution costs are outside this foundation.
        self.assertNotIn("circuit_depth", multi)

    def test_bit_width_uses_ceil_log2_for_future_non_power_of_two_indices(self):
        for candidates, expected in [(63, 6), (64, 6), (65, 7), (1023, 10), (1024, 10), (1025, 11), (2_147_483_647, 31)]:
            with self.subTest(candidates=candidates):
                self.assertEqual(quantum_mips_qubit_thresholds(candidates)["index_bits"], expected)

    def test_invalid_helper_inputs_are_rejected_and_shor_planning_is_unchanged(self):
        for value in [0, 1, -1, True, 64.0, "64", None, 2_147_483_648]:
            with self.subTest(candidates=value), self.assertRaises(ValueError):
                quantum_mips_qubit_thresholds(value)
        for value in [0, -1, True, 20.0, "20", None, 2_147_483_648]:
            with self.subTest(capacity=value), self.assertRaises(ValueError):
                quantum_mips_capacity_plan(64, value)
        before = qpu_capacity_plan(21, 28)
        for candidates, _, _, _, _, ceiling in SCALES:
            quantum_mips_capacity_plan(candidates, ceiling)
        self.assertEqual(qpu_capacity_plan(21, 28), before)
        self.assertEqual(before["parallelization_tier"], "Carry-Lookahead Parallel")


class QuantumMipsClassicalStageTests(unittest.TestCase):
    # Independent expected timings: M, pre CPU/GPU, post CPU/GPU (all ms).
    TIMINGS = [
        (64, 0.25, 0.33, 0.18, 0.32),
        (1024, 2.40, 0.59, 1.80, 0.48),
        (32768, 18.50, 2.52, 12.00, 1.50),
        (131072, 64.00, 7.98, 42.00, 4.50),
        (1048576, 310.00, 37.50, 195.00, 19.80),
    ]

    def test_preprocessing_cpu_timings_and_algorithm_metadata(self):
        for candidates, expected, *_ in self.TIMINGS:
            with self.subTest(candidates=candidates):
                result = quantum_mips_preprocessing(candidates)
                self.assertEqual(result.name, "LSH Projection & HNSW Bucket Pruning")
                self.assertEqual(result.node, "CPU")
                self.assertEqual(result.latency_ms, expected)
                self.assertEqual(result.status, "OPTIMAL")
                self.assertEqual(result.metrics["algorithm"], "LSH Random Hyperplane & HNSW Graph Filter")
                self.assertEqual(result.metrics["complexity"], "O(d · log M)")
                self.assertEqual(result.metrics["candidate_count"], candidates)
                self.assertEqual(result.metrics["compute_latency_ms"], expected)
                self.assertEqual(result.metrics["launch_transfer_overhead_ms"], 0)

    def test_postprocessing_cpu_timings_and_algorithm_metadata(self):
        for candidates, _, _, expected, _ in self.TIMINGS:
            with self.subTest(candidates=candidates):
                result = quantum_mips_postprocessing(candidates)
                self.assertEqual(result.name, "Exact FP16 Dot-Product Reranking & Softmax")
                self.assertEqual(result.node, "CPU")
                self.assertEqual(result.latency_ms, expected)
                self.assertEqual(result.status, "OPTIMAL")
                self.assertEqual(result.metrics["algorithm"], "Batch FP16 Cosine Reranking & Top-K Softmax")
                self.assertEqual(result.metrics["complexity"], "O(K · d)")
                self.assertEqual(result.metrics["compute_latency_ms"], expected)
                self.assertEqual(result.metrics["launch_transfer_overhead_ms"], 0)

    def test_small_batch_prefers_cpu_and_gpu_warns_about_pcie(self):
        for builder, cpu_ms, gpu_ms, factor in [
            (quantum_mips_preprocessing, 0.25, 0.33, 0.12),
            (quantum_mips_postprocessing, 0.18, 0.32, 0.10),
        ]:
            with self.subTest(stage=builder.__name__):
                cpu, gpu = builder(64, "CPU"), builder(64, "GPU")
                self.assertEqual(cpu.latency_ms, cpu_ms)
                self.assertEqual(gpu.latency_ms, gpu_ms)
                self.assertLess(cpu.latency_ms, gpu.latency_ms)
                self.assertEqual(cpu.status, "OPTIMAL")
                self.assertEqual(gpu.status, "WARNING")
                self.assertIn("Small-batch PCIe overhead makes CPU faster", gpu.output_summary)
                self.assertEqual(gpu.metrics["compute_latency_factor"], factor)
                self.assertEqual(gpu.metrics["launch_transfer_overhead_ms"], 0.30)

    def test_gpu_becomes_optimal_and_beats_cpu_at_all_larger_scales(self):
        for candidates, pre_cpu, pre_gpu, post_cpu, post_gpu in self.TIMINGS[1:]:
            for builder, cpu_ms, gpu_ms, factor in [
                (quantum_mips_preprocessing, pre_cpu, pre_gpu, 0.12),
                (quantum_mips_postprocessing, post_cpu, post_gpu, 0.10),
            ]:
                with self.subTest(candidates=candidates, stage=builder.__name__):
                    result = builder(candidates, "GPU")
                    self.assertEqual(result.node, "GPU")
                    self.assertEqual(result.status, "OPTIMAL")
                    self.assertEqual(result.latency_ms, gpu_ms)
                    self.assertLess(result.latency_ms, cpu_ms)
                    self.assertEqual(result.metrics["compute_latency_factor"], factor)
                    self.assertEqual(result.metrics["cpu_reference_latency_ms"], cpu_ms)
                    self.assertIn("Tensor parallelism is faster", result.output_summary)

    def test_gpu_latency_includes_exactly_one_launch_transfer_cost(self):
        for candidates, *_ in self.TIMINGS:
            for builder, factor in [(quantum_mips_preprocessing, 0.12), (quantum_mips_postprocessing, 0.10)]:
                with self.subTest(candidates=candidates, stage=builder.__name__):
                    result = builder(candidates, "GPU")
                    metrics = result.metrics
                    self.assertAlmostEqual(result.latency_ms, metrics["compute_latency_ms"] + 0.30)
                    self.assertEqual(result.latency_ms, round(metrics["cpu_reference_latency_ms"] * factor + 0.30, 2))
                    self.assertNotIn("io_state_prep_ms", metrics)
                    self.assertTrue(metrics["execution_feasible"])
                    self.assertTrue(metrics["routing_supported"])
                    result.model_dump_json()

    def test_qpu_routes_are_unsupported_and_have_no_execution_or_transfer_cost(self):
        for candidates, *_ in self.TIMINGS:
            for builder in [quantum_mips_preprocessing, quantum_mips_postprocessing]:
                with self.subTest(candidates=candidates, stage=builder.__name__):
                    result = builder(candidates, "QPU")
                    self.assertEqual(result.node, "QPU")
                    self.assertEqual(result.latency_ms, 0)
                    self.assertEqual(result.status, "CRITICAL_BOTTLENECK")
                    self.assertFalse(result.metrics["routing_supported"])
                    self.assertFalse(result.metrics["execution_feasible"])
                    self.assertEqual(result.metrics["compute_latency_ms"], 0)
                    self.assertEqual(result.metrics["launch_transfer_overhead_ms"], 0)
                    self.assertIn("UNSUPPORTED ROUTE", result.output_summary)
                    self.assertIn("CPU or GPU", result.output_summary)

    def test_stage_builders_validate_scales_and_nodes(self):
        for builder in [quantum_mips_preprocessing, quantum_mips_postprocessing]:
            for candidates in [15, 65, True, 64.0, "64", None]:
                with self.subTest(stage=builder.__name__, candidates=candidates), self.assertRaises(ValueError):
                    builder(candidates)
            for node in ["TPU", "cpu", "gpu", None, True, 1, []]:
                with self.subTest(stage=builder.__name__, node=node), self.assertRaises(ValueError):
                    builder(64, node)

    def test_stage_telemetry_is_independent_and_keeps_shor_routing_unchanged(self):
        for builder in [quantum_mips_preprocessing, quantum_mips_postprocessing]:
            original = builder(64, "GPU")
            modified = builder(64, "GPU")
            modified.metrics["compute_latency_ms"] = 999
            self.assertEqual(builder(64, "GPU"), original)
        # Quantum-MIPS GPU factors must not replace Shor's shared 0.25 factor.
        from backend.main import CLASSICAL_GPU_COMPUTE_FACTOR
        self.assertEqual(CLASSICAL_GPU_COMPUTE_FACTOR, 0.25)


if __name__ == "__main__":
    unittest.main()

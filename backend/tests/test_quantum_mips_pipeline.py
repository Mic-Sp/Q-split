"""Live Grover correctness and analytical/routing contracts for the full workload."""

import itertools
import json
import math
import unittest
from unittest.mock import patch

from qiskit.quantum_info import Statevector

from backend.workloads import GATE_COUNT_EXPANSION_FACTOR, mips_reference_depth

from backend.main import (
    RoutingConfig, STAGE_KEYS, HARDWARE_PROFILES, QUANTUM_MIPS_SCALES,
    build_quantum_mips_grover_circuit, execute_live_quantum_mips_64,
    quantum_mips_kernel, quantum_mips_qubit_thresholds, run_quantum_mips_pipeline,
)


class GroverReferenceTests(unittest.TestCase):
    def test_seeded_gate_counts_and_sampled_counts_repeat_exactly(self):
        first = execute_live_quantum_mips_64()
        second = execute_live_quantum_mips_64()
        # Timings measure wall-clock work and intentionally are not deterministic.
        for field in ("aer_gate_counts", "aer_counts", "aer_reference_circuit_depth", "aer_shots",
                      "top_1_token_index", "measured_peak_probability"):
            self.assertEqual(first[field], second[field])

    def test_oracle_amplifies_correct_bit_order_and_uncomputes_all_workspace(self):
        circuit = build_quantum_mips_grover_circuit()
        self.assertEqual(circuit.num_qubits, 10)
        self.assertEqual(circuit.num_clbits, 6)
        state = Statevector.from_instruction(circuit.remove_final_measurements(inplace=False))
        probabilities = state.probabilities()
        expected = math.sin(13 * math.asin(1 / 8)) ** 2  # Six Grover iterations.
        self.assertAlmostEqual(probabilities[45], expected, places=10)
        self.assertAlmostEqual(sum(probabilities[64:]), 0, places=10)
        self.assertGreater(probabilities[45], 0.99)

    def test_real_aer_counts_peak_probability_and_wall_clock_timings(self):
        result = execute_live_quantum_mips_64()
        self.assertEqual(result["aer_reference_qubits"], 10)
        self.assertEqual(result["top_1_token_index"], 45)
        self.assertEqual(result["aer_shots"], 1024)
        self.assertEqual(sum(result["aer_counts"].values()), 1024)
        self.assertEqual(max(result["aer_counts"], key=result["aer_counts"].get), "101101")
        self.assertEqual(result["measured_peak_probability"], result["aer_counts"]["101101"] / 1024)
        self.assertGreater(result["measured_peak_probability"], 0.95)
        for key in ["aer_compile_time_ms", "aer_runtime_ms", "aer_total_time_ms", "aer_reference_circuit_depth"]:
            self.assertGreater(result[key], 0)
            self.assertTrue(math.isfinite(result[key]))
        self.assertAlmostEqual(result["aer_total_time_ms"], result["aer_compile_time_ms"] + result["aer_runtime_ms"])


class QuantumMipsPipelineTests(unittest.TestCase):
    def setUp(self):
        self.aer = patch("backend.main.execute_live_quantum_mips_64", return_value={
            "aer_reference_circuit_depth": 640, "aer_reference_qubits": 10, "aer_shots": 1024,
            "aer_counts": {"101101": 1020, "000000": 4}, "top_1_token_index": 45,
            "measured_peak_probability": 1020 / 1024, "aer_compile_time_ms": 2.0,
            "aer_runtime_ms": 1.25, "aer_total_time_ms": 3.25,
        })
        self.live = self.aer.start()
        self.addCleanup(self.aer.stop)

    def test_live_sequential_projects_each_architecture_without_replacing_measured_runtime(self):
        for profile, architecture in HARDWARE_PROFILES.items():
            with self.subTest(profile=profile):
                result = quantum_mips_kernel(64, profile, "QPU", 10)
                reference = mips_reference_depth(64)
                depth = math.ceil(reference * architecture.topology_factor * architecture.native_2q_per_cx)
                self.assertEqual(result.metrics["aer_reference_circuit_depth"], 640)
                self.assertEqual(result.metrics["reference_circuit_depth"], reference)
                self.assertEqual(result.metrics["circuit_depth"], depth)
                self.assertAlmostEqual(result.latency_ms, 0.30 + 1024 * (
                    depth * architecture.t_2q_ns + architecture.t_meas_ns + architecture.t_reset_ns) / 1e6)
                self.assertEqual(result.metrics["io_state_prep_ms"], 0)
                self.assertTrue(result.metrics["qpu_io_included_in_latency"])
                two_qubit_count = math.ceil(math.ceil(202 * GATE_COUNT_EXPANSION_FACTOR) * architecture.topology_factor * architecture.native_2q_per_cx)
                survival = ((1 - architecture.err_1q)**math.ceil(2 * 202 * GATE_COUNT_EXPANSION_FACTOR) * (1 - architecture.err_2q)**two_qubit_count *
                            (1 - architecture.err_meas)**6)
                if architecture.t1_us is not None:
                    survival *= math.exp(-10 * depth * architecture.t_2q_ns / 1000 / architecture.t1_us)
                self.assertAlmostEqual(result.metrics["coherence_survival_pct"], 100 * survival, delta=max(1e-300, 100 * survival * 1e-12))
                self.assertEqual(result.metrics["aer_runtime_ms"], 1.25)
                self.assertEqual(result.metrics["aer_reference_qubits"], 10)
                self.assertEqual(result.metrics["measured_peak_probability"], 1020 / 1024)
                self.assertEqual(result.metrics["grover_iterations"], 6)
                self.assertIn("separate projections", result.output_summary)
                self.assertIn("101101", result.output_summary)
        self.assertEqual(self.live.call_count, 4)

    def test_parallel_and_large_qpu_models_apply_tier_and_topology_exactly_once(self):
        with patch("backend.main.execute_live_quantum_mips_64", side_effect=AssertionError("Analytical models must not execute Aer")):
            for scale, profile, tier in itertools.product(QUANTUM_MIPS_SCALES, HARDWARE_PROFILES, [0, 1, 2]):
                if scale == 64 and tier == 0:
                    continue
                thresholds = quantum_mips_qubit_thresholds(scale)
                capacity = [thresholds["minimum_qubits_required"], thresholds["windowed_qubits_required"], thresholds["ceiling_qubits_required"]][tier]
                with self.subTest(scale=scale, profile=profile, tier=tier):
                    result = quantum_mips_kernel(scale, profile, "QPU", capacity)
                    architecture = HARDWARE_PROFILES[profile]
                    reference = mips_reference_depth(scale)
                    depth = math.ceil(math.ceil(reference * [1.0, 0.40, 0.20][tier]) * architecture.topology_factor * architecture.native_2q_per_cx)
                    self.assertEqual(result.metrics["reference_circuit_depth"], reference)
                    self.assertEqual(result.metrics["circuit_depth"], depth)
                    self.assertAlmostEqual(result.latency_ms, 0.30 + 1024 * (
                        depth * architecture.t_2q_ns + architecture.t_meas_ns + architecture.t_reset_ns) / 1e6)
                    logical_depth = round(4.2 * math.sqrt(scale) * math.log2(scale))
                    self.assertEqual(result.metrics["circuit_spec"]["n_2q"], math.ceil(logical_depth * GATE_COUNT_EXPANSION_FACTOR))
                    self.assertEqual(result.metrics["grover_iterations"], math.floor(math.pi / 4 * math.sqrt(scale)))
                    self.assertEqual(result.metrics["top_1_token_index"], 45)
                    self.assertEqual(result.metrics["result_source"], "analytical_marked_state_projection")
                    self.assertFalse(result.metrics["aer_executed"])
                    self.assertNotIn("measured_peak_probability", result.metrics)
                    self.assertIn("no vector-score oracle", result.output_summary)
                    self.assertIn("coherence survival", result.output_summary)
                    result.model_dump_json()

    def test_cpu_gpu_ram_uses_selected_register_and_architecture_never_changes_classical_precision(self):
        for scale, node, tier in itertools.product(QUANTUM_MIPS_SCALES, ["CPU", "GPU"], [0, 1, 2]):
            thresholds = quantum_mips_qubit_thresholds(scale)
            qubits = [thresholds["minimum_qubits_required"], thresholds["windowed_qubits_required"], thresholds["ceiling_qubits_required"]][tier]
            stages = [quantum_mips_kernel(scale, profile, node, qubits) for profile in HARDWARE_PROFILES]
            for stage in stages:
                with self.subTest(scale=scale, node=node, tier=tier):
                    required = 16 * 2 ** qubits
                    budget = (16 if node == "CPU" else 8) * 2 ** 30
                    self.assertEqual(stage.metrics["statevector_qubits"], qubits)
                    self.assertEqual(stage.metrics["statevector_memory_required_bytes"], required)
                    self.assertEqual(stage.metrics["statevector_memory_budget_bytes"], budget)
                    self.assertEqual(stage.metrics["execution_feasible"], required <= budget)
                    self.assertEqual(stage.metrics["coherence_survival_pct"], 100)
                    if required > budget:
                        self.assertEqual(stage.latency_ms, 0)
                        self.assertEqual(stage.metrics["qubits_allocated"], 0)
                        self.assertEqual(stage.metrics["planned_qubits"], qubits)
                        self.assertIn("STATEVECTOR MEMORY LIMIT", stage.output_summary)
                    else:
                        self.assertGreater(stage.latency_ms, 0)
                        self.assertTrue(stage.metrics["retrieval_reliable"])
            self.assertTrue(all(stage == stages[0] for stage in stages))

    def test_blocked_capacity_memory_and_upstream_never_call_aer_or_charge_postprocessing(self):
        with patch("backend.main.execute_live_quantum_mips_64", side_effect=AssertionError("Blocked execution must not run Aer")):
            capacity = run_quantum_mips_pipeline(64, "ideal_sim", available_qubits=9)
            self.assertIn("INSUFFICIENT QPU QUBIT CAPACITY", capacity.primary_bottleneck)
            memory = run_quantum_mips_pipeline(64, "ideal_sim", RoutingConfig(stage_2_node="GPU", stage_3_node="GPU"), 40)
            self.assertIn("GPU STATEVECTOR MEMORY LIMIT", memory.primary_bottleneck)
            upstream = run_quantum_mips_pipeline(64, "ideal_sim", RoutingConfig(stage_1_node="QPU", stage_3_node="GPU"), 10)
            self.assertIn("UNSUPPORTED QPU ROUTING", upstream.primary_bottleneck)
            for response in [capacity, memory, upstream]:
                for stage in list(response.stages.values())[1:]:
                    self.assertEqual(stage.latency_ms, 0)
                    self.assertFalse(stage.metrics["execution_feasible"])
                    self.assertEqual(stage.metrics["compute_latency_ms"], 0)
                    self.assertEqual(stage.metrics.get("launch_transfer_overhead_ms", 0), 0)
                    self.assertEqual(stage.metrics.get("io_state_prep_ms", 0), 0)
                self.assertEqual(response.execution_mode, "NISQ_ANALYTICAL_PROFILER")

    def test_classical_minimum_emulation_is_not_blocked_by_insufficient_physical_qubits(self):
        for node in ["CPU", "GPU"]:
            stage = quantum_mips_kernel(64, "ibm_heron_nisq", node, 1)
            self.assertEqual(stage.metrics["statevector_qubits"], 10)
            self.assertEqual(stage.metrics["available_qubits"], 1)
            self.assertTrue(stage.metrics["execution_feasible"])
            self.assertEqual(stage.metrics["coherence_survival_pct"], 100)

    def test_postprocessing_qpu_is_blocked_without_erasing_upstream_work(self):
        result = run_quantum_mips_pipeline(1024, "ideal_sim", RoutingConfig(stage_3_node="QPU"), 14)
        self.assertGreater(result.stages[STAGE_KEYS[0]].latency_ms, 0)
        self.assertGreater(result.stages[STAGE_KEYS[1]].latency_ms, 0)
        post = result.stages[STAGE_KEYS[2]]
        self.assertEqual(post.latency_ms, 0)
        self.assertFalse(post.metrics["routing_supported"])
        self.assertIn("UNSUPPORTED QPU ROUTING", result.primary_bottleneck)

    def test_decoherence_is_not_reported_as_a_verified_retrieval(self):
        result = run_quantum_mips_pipeline(1048576, "ibm_heron_nisq", available_qubits=24)
        kernel, post = [result.stages[key] for key in STAGE_KEYS[1:]]
        self.assertEqual(kernel.status, "CRITICAL_BOTTLENECK")
        self.assertEqual(kernel.metrics["coherence_survival_pct"], 0)
        self.assertFalse(kernel.metrics["retrieval_reliable"])
        self.assertIn("CATASTROPHIC QPU DECOHERENCE", result.primary_bottleneck)
        self.assertIn("no verified top-1", post.output_summary)
        self.assertEqual(post.status, "CRITICAL_BOTTLENECK")

    def test_cpu_baseline_matches_all_cpu_dispatch_without_extra_reference_execution(self):
        for scale, tier in itertools.product(QUANTUM_MIPS_SCALES, ["minimum_qubits_required", "windowed_qubits_required", "ceiling_qubits_required"]):
            capacity = quantum_mips_qubit_thresholds(scale)[tier]
            result = run_quantum_mips_pipeline(scale, "ionq_forte_trapped_ion", RoutingConfig(stage_2_node="CPU"), capacity)
            kernel = result.stages[STAGE_KEYS[1]]
            baseline = kernel.metrics["classical_cpu_baseline"]
            self.assertEqual(baseline["feasible"], kernel.metrics["execution_feasible"])
            if baseline["feasible"]:
                self.assertEqual(baseline["kernel_ms"], kernel.latency_ms)
                self.assertAlmostEqual(baseline["total_ms"], sum(stage.latency_ms for stage in result.stages.values()))
            else:
                self.assertIsNone(baseline["total_ms"])
        self.assertEqual(self.live.call_count, 1)

    def test_default_dispatch_and_validation_are_complete_and_json_safe(self):
        default = run_quantum_mips_pipeline(64, "ideal_sim")
        explicit = run_quantum_mips_pipeline(64, "ideal_sim", RoutingConfig(), 133)
        self.assertEqual(default, explicit)
        self.assertEqual(default.workload_id, "quantum_mips")
        self.assertEqual(list(default.stages), list(STAGE_KEYS))
        json.dumps(default.model_dump(), allow_nan=False)
        for kwargs in [{"scale_param": 65}, {"hardware_profile": "unknown"}, {"node": "TPU"}, {"available_qubits": 0}, {"available_qubits": True}]:
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                quantum_mips_kernel(**{"scale_param": 64, **kwargs})


if __name__ == "__main__":
    unittest.main()

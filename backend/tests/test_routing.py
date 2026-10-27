"""Run from the repository root:
backend/venv/bin/python -m unittest discover -s backend/tests -v
"""

import http.client
import itertools
import json
import math
import socket
import threading
import time
import unittest
from unittest.mock import patch
import uvicorn

from backend.main import (
    RoutingConfig,
    SimulationRequest,
    STAGE_KEYS,
    HARDWARE_PROFILES,
    qpu_capacity_plan,
    classical_cpu_baseline,
    app,
    run_shors_pipeline,
)


class RoutingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Real HTTP validation using existing backend dependencies and a free port.
        cls.socket = socket.socket()
        cls.socket.bind(("127.0.0.1", 0))
        cls.port = cls.socket.getsockname()[1]
        cls.server = uvicorn.Server(uvicorn.Config(app, log_level="error"))
        cls.thread = threading.Thread(target=cls.server.run, kwargs={"sockets": [cls.socket]}, daemon=True)
        cls.thread.start()
        deadline = time.monotonic() + 10
        while not cls.server.started:
            if not cls.thread.is_alive() or time.monotonic() > deadline:
                raise RuntimeError("Local routing test server did not start")
            time.sleep(0.01)

    @classmethod
    def tearDownClass(cls):
        cls.server.should_exit = True
        cls.thread.join(timeout=10)
        cls.socket.close()

    def setUp(self):
        # Routing regression checks should not depend on stochastic phase counts.
        self.kernel = patch("backend.main.execute_live_shors_15", side_effect=lambda a=7, noisy=True: {
            "qubits": 8, "depth": 189, "top_measurements": "|0100⟩ (1/4)",
            "period_r": 4, "coherence_pct": round(100.0 * math.exp(-189 / 1200.0), 2) if noisy else 100.0,
        })
        self.kernel.start()
        self.addCleanup(self.kernel.stop)

    def post(self, payload):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            connection.request("POST", "/api/simulate", json.dumps(payload), {"Content-Type": "application/json"})
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def test_default_request_and_partial_routing(self):
        self.assertIsNone(SimulationRequest().routing)
        self.assertEqual(RoutingConfig().model_dump(), {
            "stage_1_node": "CPU", "stage_2_node": "QPU", "stage_3_node": "CPU",
        })
        status, response = self.post({"scale_param": 21, "routing": {"stage_3_node": "GPU"}})
        self.assertEqual(status, 200)
        self.assertEqual([stage["node"] for stage in response["stages"].values()], ["CPU", "QPU", "GPU"])
        self.assertEqual(response["stages"][STAGE_KEYS[0]]["latency_ms"], 0.28)
        self.assertEqual(response["stages"][STAGE_KEYS[1]]["metrics"]["parallelization_tier"], "Carry-Lookahead Parallel")

    def test_default_routing_variants_preserve_capacity_response(self):
        for scale, profile in itertools.product([15, 21, 35, 512, 2048], ["ibm_heron_nisq", "ideal_sim"]):
            expected = run_shors_pipeline(scale, profile, available_qubits=133).model_dump()
            for routing in [None, RoutingConfig(), RoutingConfig(stage_2_node="QPU")]:
                with self.subTest(scale=scale, profile=profile, routing=routing):
                    self.assertEqual(run_shors_pipeline(scale, profile, routing).model_dump(), expected)

    def test_endpoint_default_variants_are_equivalent(self):
        for scale in [15, 21]:
            payload = {"scale_param": scale}
            status, expected = self.post(payload)
            self.assertEqual(status, 200)
            for routing in [None, {}, RoutingConfig().model_dump()]:
                with self.subTest(scale=scale, routing=routing):
                    self.assertEqual(self.post({**payload, "routing": routing}), (200, expected))

    def test_every_route_across_scales_and_hardware_profiles(self):
        for nodes, scale, profile in itertools.product(
            itertools.product(["CPU", "GPU", "QPU"], repeat=3),
            [15, 21, 35, 512, 2048], list(HARDWARE_PROFILES),
        ):
            routing = RoutingConfig(**dict(zip(["stage_1_node", "stage_2_node", "stage_3_node"], nodes)))
            with self.subTest(nodes=nodes, scale=scale, profile=profile):
                result = run_shors_pipeline(scale, profile, routing)
                self.assertEqual([stage.node for stage in result.stages.values()], list(nodes))
                # Includes RSA-2048 on CPU/GPU: estimates remain JSON-safe.
                result.model_dump_json()
                for stage in result.stages.values():
                    self.assertTrue(math.isfinite(stage.latency_ms))
                    self.assertGreaterEqual(stage.latency_ms, 0)
                    self.assertIn(stage.status, ["OPTIMAL", "WARNING", "CRITICAL_BOTTLENECK"])

    def test_endpoint_accepts_all_27_route_combinations(self):
        for nodes in itertools.product(["CPU", "GPU", "QPU"], repeat=3):
            routing = dict(zip(["stage_1_node", "stage_2_node", "stage_3_node"], nodes))
            with self.subTest(routing=routing):
                status, response = self.post({"scale_param": 21, "routing": routing})
                self.assertEqual(status, 200)
                self.assertEqual([stage["node"] for stage in response["stages"].values()], list(nodes))

    def test_invalid_nodes_report_field_specific_validation_errors(self):
        for field in ["stage_1_node", "stage_2_node", "stage_3_node"]:
            for value in ["TPU", "cpu", None, 42, True]:
                with self.subTest(field=field, value=value):
                    status, response = self.post({"routing": {field: value}})
                    self.assertEqual(status, 422)
                    self.assertIn(["body", "routing", field], [error["loc"] for error in response["detail"]])

    def test_invalid_routing_shapes_and_unknown_fields(self):
        for routing in [[], "GPU", 42, {"stage_4_node": "GPU"}, {"stage_2_nod": "GPU"}]:
            with self.subTest(routing=routing):
                status, _ = self.post({"routing": routing})
                self.assertEqual(status, 422)

    def test_gpu_classical_stages_include_launch_overhead(self):
        result = run_shors_pipeline(21, "ibm_heron_nisq", RoutingConfig(stage_1_node="GPU", stage_3_node="GPU"))
        self.assertEqual(result.stages[STAGE_KEYS[0]].latency_ms, 0.37)
        self.assertEqual(result.stages[STAGE_KEYS[2]].latency_ms, 0.38)
        for key in [STAGE_KEYS[0], STAGE_KEYS[2]]:
            self.assertEqual(result.stages[key].status, "WARNING")
            self.assertEqual(result.stages[key].metrics["launch_transfer_overhead_ms"], 0.30)

    def test_classical_kernel_routes_ignore_physical_qpu_noise(self):
        for node, latency in [("CPU", 224.0), ("GPU", 56.3)]:
            with self.subTest(node=node):
                noisy = run_shors_pipeline(21, "ibm_heron_nisq", RoutingConfig(stage_2_node=node))
                ideal = run_shors_pipeline(21, "ideal_sim", RoutingConfig(stage_2_node=node))
                self.assertEqual(noisy, ideal)
                self.assertEqual(noisy.stages[STAGE_KEYS[1]].latency_ms, latency)
                self.assertEqual(noisy.stages[STAGE_KEYS[1]].metrics["coherence_survival_pct"], 100.0)
                self.assertEqual(noisy.stages[STAGE_KEYS[2]].status, "OPTIMAL")
                self.assertEqual(noisy.stages[STAGE_KEYS[2]].metrics["factors_found"], "21 = 3 × 7")

    def test_classical_kernel_memory_wall_starves_postprocessing(self):
        for node in ["CPU", "GPU"]:
            result = run_shors_pipeline(2048, "ibm_heron_nisq", RoutingConfig(stage_2_node=node))
            self.assertIn(f"{node} STATEVECTOR MEMORY LIMIT", result.primary_bottleneck)
            for key in STAGE_KEYS[1:]:
                self.assertEqual(result.stages[key].status, "CRITICAL_BOTTLENECK")
                self.assertEqual(result.stages[key].latency_ms, 0.0)
                self.assertFalse(result.stages[key].metrics["execution_feasible"])
            self.assertEqual(result.stages[STAGE_KEYS[2]].metrics["factors_found"], "NONE (Routing blocked)")

    def test_qpu_preprocessing_blocks_downstream_stages(self):
        result = run_shors_pipeline(21, "ideal_sim", RoutingConfig(stage_1_node="QPU", stage_2_node="GPU"))
        self.assertIn("UNSUPPORTED QPU ROUTING", result.primary_bottleneck)
        for stage in result.stages.values():
            self.assertEqual(stage.status, "CRITICAL_BOTTLENECK")
            self.assertEqual(stage.latency_ms, 0.0)
        self.assertIn("STARVED", result.stages[STAGE_KEYS[1]].output_summary)

    def test_qpu_postprocessing_is_unsupported_without_blocking_upstream(self):
        result = run_shors_pipeline(21, "ideal_sim", RoutingConfig(stage_3_node="QPU"))
        self.assertEqual(result.stages[STAGE_KEYS[0]].status, "OPTIMAL")
        self.assertEqual(result.stages[STAGE_KEYS[1]].status, "OPTIMAL")
        self.assertEqual(result.stages[STAGE_KEYS[2]].status, "CRITICAL_BOTTLENECK")
        self.assertFalse(result.stages[STAGE_KEYS[2]].metrics["routing_supported"])
        self.assertIn("UNSUPPORTED QPU ROUTING", result.primary_bottleneck)

    def test_other_workload_http_statuses_are_preserved(self):
        self.assertEqual(self.post({"workload_id": "quantum_mips", "routing": {"stage_2_node": "GPU"}})[0], 501)
        self.assertEqual(self.post({"workload_id": "unknown"})[0], 400)

    def test_capacity_validation_and_default(self):
        self.assertEqual(SimulationRequest().available_qubits, 133)
        for value in [0, -1, 1.5, True, "133", None, 2_147_483_648]:
            with self.subTest(value=value):
                status, response = self.post({"available_qubits": value})
                self.assertEqual(status, 422)
                self.assertIn(["body", "available_qubits"], [error["loc"] for error in response["detail"]])

    def test_exact_tier_boundaries_and_ceiling_across_scales(self):
        for scale, n, minimum in [(15, 4, 8), (21, 5, 13), (35, 6, 15), (512, 512, 1027), (2048, 2048, 4099)]:
            ceiling = math.ceil(5.5 * n)
            cases = [(minimum - 1, "Blocked · insufficient capacity", 0),
                     (minimum, "Space-Optimized Sequential", minimum),
                     (3 * n - 1, "Space-Optimized Sequential", minimum),
                     (3 * n, "Windowed Parallel", 3 * n),
                     (ceiling - 1, "Windowed Parallel", 3 * n),
                     (ceiling, "Carry-Lookahead Parallel", ceiling),
                     (ceiling + 5000, "Carry-Lookahead Parallel", ceiling)]
            for capacity, tier, allocated in cases:
                with self.subTest(scale=scale, capacity=capacity):
                    result = run_shors_pipeline(scale, "ideal_sim", available_qubits=capacity)
                    metrics = result.stages[STAGE_KEYS[1]].metrics
                    self.assertEqual(metrics["parallelization_tier"], tier)
                    self.assertEqual(metrics["qubits_allocated"], allocated)
                    self.assertEqual(metrics["available_qubits"], capacity)
                    self.assertEqual(metrics["idle_qubits"], capacity - allocated)
            depths = [run_shors_pipeline(scale, "ideal_sim", available_qubits=c).stages[STAGE_KEYS[1]].metrics["circuit_depth"]
                      for c in [minimum, 3 * n, ceiling, ceiling + 5000]]
            self.assertGreater(depths[0], depths[1])
            self.assertGreater(depths[1], depths[2])
            self.assertEqual(depths[2], depths[3])
            self.assertEqual(run_shors_pipeline(scale, "ideal_sim", available_qubits=ceiling).stages[STAGE_KEYS[1]].latency_ms,
                             run_shors_pipeline(scale, "ideal_sim", available_qubits=ceiling + 5000).stages[STAGE_KEYS[1]].latency_ms)

    def test_insufficient_capacity_blocks_each_qpu_route_and_starves_dependents(self):
        for stage_index, field in enumerate(["stage_1_node", "stage_2_node", "stage_3_node"]):
            routing = RoutingConfig(stage_2_node="CPU", **({field: "QPU"} if field != "stage_2_node" else {}))
            if field == "stage_2_node":
                routing.stage_2_node = "QPU"
            status, result = self.post({"scale_param": 21, "available_qubits": 12, "routing": routing.model_dump()})
            self.assertEqual(status, 200)
            self.assertEqual(result["primary_bottleneck"], "INSUFFICIENT QPU QUBIT CAPACITY")
            for key in STAGE_KEYS[stage_index:]:
                self.assertEqual(result["stages"][key]["latency_ms"], 0)
                self.assertEqual(result["stages"][key]["status"], "CRITICAL_BOTTLENECK")
                self.assertFalse(result["stages"][key]["metrics"]["execution_feasible"])
            self.assertEqual(result["stages"][STAGE_KEYS[stage_index]]["metrics"]["qubits_allocated"], 0)

    def test_capacity_cannot_change_classical_emulation(self):
        for node in ["CPU", "GPU"]:
            route = RoutingConfig(stage_2_node=node)
            self.assertEqual(run_shors_pipeline(21, "ideal_sim", route, 1), run_shors_pipeline(21, "ideal_sim", route, 16384))

    def test_blocked_n15_skips_aer_and_parallel_tiers_are_analytical(self):
        with patch("backend.main.execute_live_shors_15", side_effect=AssertionError("Aer must not execute")):
            blocked = run_shors_pipeline(15, "ideal_sim", available_qubits=7)
            self.assertEqual(blocked.primary_bottleneck, "INSUFFICIENT QPU QUBIT CAPACITY")
            parallel = run_shors_pipeline(15, "ideal_sim", available_qubits=16)
            self.assertEqual(parallel.execution_mode, "NISQ_ANALYTICAL_PROFILER")
        self.assertEqual(run_shors_pipeline(15, "ideal_sim", available_qubits=8).execution_mode, "LIVE_QISKIT_AER")

    def test_parallel_depth_improves_coherence_and_latency(self):
        for scale, capacities in [(15, [8, 12, 22]), (21, [13, 15, 28])]:
            stages = [run_shors_pipeline(scale, "ibm_heron_nisq", available_qubits=c).stages[STAGE_KEYS[1]] for c in capacities]
            self.assertGreater(stages[0].latency_ms, stages[1].latency_ms)
            self.assertGreater(stages[1].latency_ms, stages[2].latency_ms)
            self.assertLess(stages[0].metrics["coherence_survival_pct"], stages[1].metrics["coherence_survival_pct"])
            self.assertLess(stages[1].metrics["coherence_survival_pct"], stages[2].metrics["coherence_survival_pct"])

    def test_cpu_counterfactual_matches_actual_all_cpu_routes_without_extra_aer_work(self):
        for scale in [15, 21, 35, 512, 2048]:
            with self.subTest(scale=scale):
                baseline = classical_cpu_baseline(scale)
                reference = run_shors_pipeline(scale, "ideal_sim", RoutingConfig(stage_2_node="CPU"))
                self.assertEqual(baseline, reference.stages[STAGE_KEYS[1]].metrics["classical_cpu_baseline"])
                self.assertEqual(baseline["feasible"], reference.stages[STAGE_KEYS[1]].metrics["execution_feasible"])
                if baseline["feasible"]:
                    self.assertEqual(baseline["kernel_ms"], reference.stages[STAGE_KEYS[1]].latency_ms)
                    self.assertAlmostEqual(baseline["total_ms"], sum(stage.latency_ms for stage in reference.stages.values()))
                else:
                    self.assertIsNone(baseline["kernel_ms"])
                    self.assertIsNone(baseline["total_ms"])
        with patch("backend.main.execute_live_shors_15", side_effect=AssertionError("Baseline must not execute Aer")):
            self.assertEqual(classical_cpu_baseline(15)["kernel_ms"], 92.5)
            parallel = run_shors_pipeline(15, "ideal_sim", available_qubits=22)
            self.assertEqual(parallel.stages[STAGE_KEYS[1]].metrics["classical_cpu_baseline"]["total_ms"], 92.85)

    def test_hardware_enum_and_routes_accept_four_profiles_and_reject_unknown(self):
        for profile, scale in itertools.product(HARDWARE_PROFILES, [15, 21, 35, 512, 2048]):
            with self.subTest(profile=profile, scale=scale):
                capacity = HARDWARE_PROFILES[profile]["reference_qubits"] or 133
                status, body = self.post({"scale_param": scale, "hardware_profile": profile, "available_qubits": capacity})
                self.assertEqual(status, 200)
                self.assertEqual(body["stages"][STAGE_KEYS[1]]["metrics"]["hardware_architecture"], profile)
        for value in ["unknown", "Google", None, True, 42]:
            status, body = self.post({"hardware_profile": value})
            self.assertEqual(status, 422)
            self.assertIn(["body", "hardware_profile"], [error["loc"] for error in body["detail"]])

    def test_architecture_depth_gate_time_and_decay_apply_once_across_tiers(self):
        for scale, profile in itertools.product([21, 35, 512, 2048], HARDWARE_PROFILES):
            architecture = HARDWARE_PROFILES[profile]
            n = scale if scale >= 512 else math.ceil(math.log2(scale))
            for capacity in [2 * n + 3, 3 * n, math.ceil(5.5 * n), 16384]:
                with self.subTest(scale=scale, profile=profile, capacity=capacity):
                    plan = qpu_capacity_plan(scale, capacity)
                    result = run_shors_pipeline(scale, profile, available_qubits=capacity)
                    kernel = result.stages[STAGE_KEYS[1]]
                    depth = math.ceil(plan["circuit_depth"] * architecture["depth_factor"])
                    self.assertEqual(kernel.metrics["reference_circuit_depth"], plan["circuit_depth"])
                    self.assertEqual(kernel.metrics["circuit_depth"], depth)
                    self.assertEqual(kernel.latency_ms, round(depth * 0.00025 * architecture["gate_factor"], 2 if profile in ["ibm_heron_nisq", "ideal_sim"] else 6))
                    self.assertEqual(kernel.metrics["io_state_prep_ms"], architecture["prep_ms"])
                    self.assertEqual(kernel.metrics["connectivity_topology"], architecture["topology"])
                    self.assertEqual(kernel.metrics["qubits_allocated"], plan["qubits_allocated"])
                    expected = 100.0 if profile == "ideal_sim" else round(100 * math.exp(-depth / architecture["decay_scale"]), 2)
                    self.assertEqual(kernel.metrics["coherence_survival_pct"], expected)

    def test_sequential_aer_reference_projects_new_architectures_without_native_transpilation(self):
        stages = {profile: run_shors_pipeline(15, profile, available_qubits=8).stages[STAGE_KEYS[1]] for profile in HARDWARE_PROFILES}
        self.assertEqual(stages["ibm_heron_nisq"].latency_ms, 1.85)
        self.assertEqual(stages["ideal_sim"].metrics["coherence_survival_pct"], 100)
        self.assertEqual(stages["ibm_heron_nisq"].metrics["io_state_prep_ms"], 0.05)
        for profile in ["google_weber_grid", "ionq_forte_trapped_ion"]:
            architecture = HARDWARE_PROFILES[profile]
            depth = math.ceil(189 * architecture["depth_factor"])
            self.assertEqual(stages[profile].metrics["circuit_depth"], depth)
            self.assertEqual(stages[profile].latency_ms, round(1.85 * depth / 189 * architecture["gate_factor"], 6))
            self.assertIn("projection", stages[profile].metrics["depth_model"])
        self.assertLess(stages["google_weber_grid"].latency_ms, stages["ibm_heron_nisq"].latency_ms)
        self.assertGreater(stages["ionq_forte_trapped_ion"].latency_ms, classical_cpu_baseline(15)["kernel_ms"])
        self.assertGreater(stages["ionq_forte_trapped_ion"].metrics["coherence_survival_pct"], stages["ibm_heron_nisq"].metrics["coherence_survival_pct"])

    def test_new_profiles_do_not_change_classical_compute_memory_or_baseline(self):
        for scale, node in itertools.product([15, 21, 35, 512, 2048], ["CPU", "GPU"]):
            reference = run_shors_pipeline(scale, "ideal_sim", RoutingConfig(stage_2_node=node), 133)
            for profile in HARDWARE_PROFILES:
                with self.subTest(scale=scale, node=node, profile=profile):
                    self.assertEqual(run_shors_pipeline(scale, profile, RoutingConfig(stage_2_node=node), 1), reference)

    def test_new_architectures_preserve_capacity_blocking_and_zero_overhead(self):
        for profile in ["google_weber_grid", "ionq_forte_trapped_ion"]:
            result = run_shors_pipeline(512, profile, available_qubits=HARDWARE_PROFILES[profile]["reference_qubits"])
            kernel = result.stages[STAGE_KEYS[1]]
            self.assertEqual(result.primary_bottleneck, "INSUFFICIENT QPU QUBIT CAPACITY")
            self.assertEqual(kernel.latency_ms, 0)
            self.assertEqual(kernel.metrics["io_state_prep_ms"], 0)
            self.assertEqual(kernel.metrics["qubits_allocated"], 0)
            self.assertFalse(kernel.metrics["execution_feasible"])


if __name__ == "__main__":
    unittest.main()

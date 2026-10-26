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
    qpu_capacity_plan,
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
            [15, 21, 35, 512, 2048], ["ibm_heron_nisq", "ideal_sim"],
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


if __name__ == "__main__":
    unittest.main()

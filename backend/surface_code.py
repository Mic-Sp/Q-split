"""Fowler round scaling with explicit Q-Split operation-error calibration (V1).

The standard round proxy is NOT the preset's operation error. Normalize its
reference value to the existing d=27 logical operation targets. This is a
simulator assumption, not an experimental fit or a full surgery/factory model.
Mirrored by frontend/src/lib/surface-code.ts and cross-checked in tests.
"""

import math

MIN_ROUND_ERROR = 1e-18
REFERENCE_ROUND_ERROR = math.exp(math.log(0.1) + 14 * (math.log(0.001) - math.log(0.01)))
MAX_SAFE_INTEGER = 9_007_199_254_740_991


def surface_code_parameters(code_distance_d: int, physical_2q_error: float, threshold_error: float,
                            syndrome_cycle_ns: float, logical_qubits_target: int) -> dict:
    if type(code_distance_d) is not int or code_distance_d < 3 or code_distance_d % 2 != 1:
        raise ValueError("Code distance must be an odd integer at least 3")
    if type(logical_qubits_target) is not int or not 1 <= logical_qubits_target <= 2_147_483_647:
        raise ValueError("Logical target must be a positive int32")
    for name, value in (("physical_2q_error", physical_2q_error), ("threshold_error", threshold_error), ("syndrome_cycle_ns", syndrome_cycle_ns)):
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
            raise ValueError(f"{name} must be positive and finite")
    if physical_2q_error >= 1 or threshold_error >= 1:
        raise ValueError("Physical and threshold errors must lie strictly between 0 and 1")
    patch = 2 * code_distance_d**2
    footprint = patch * logical_qubits_target
    if footprint > MAX_SAFE_INTEGER:
        raise ValueError("Surface-code footprint exceeds the supported numerical range")
    gate_ns = code_distance_d * syndrome_cycle_ns
    if footprint > MAX_SAFE_INTEGER or not math.isfinite(gate_ns) or gate_ns <= 0:
        raise ValueError("Surface-code footprint or timing exceeds the supported numerical range")
    round_log = math.log(0.1) + ((code_distance_d + 1) // 2) * (math.log(physical_2q_error) - math.log(threshold_error))
    epsilon = MIN_ROUND_ERROR if round_log <= math.log(MIN_ROUND_ERROR) else 1.0 if round_log >= 0 else math.exp(round_log)
    scale = epsilon / REFERENCE_ROUND_ERROR
    err_1q, err_2q = min(1.0, 1e-10 * scale), min(1.0, 1e-9 * scale)
    return {"is_below_threshold": physical_2q_error < threshold_error,
            "physical_qubits_per_logical": patch, "total_physical_qubits": footprint,
            # Data/syndrome patches need programmable qubits, not coupler/reset elements.
            "nighthawk_r3_modules_required": (footprint + 519) // 520,
            "physical_element_equivalent_modules": (footprint + 2033) // 2034,
            "logical_error_per_round": epsilon, "round_log_error_unclamped": round_log,
            "round_error_clamped": round_log < math.log(MIN_ROUND_ERROR) or round_log > 0,
            "t_1q_ns": syndrome_cycle_ns, "t_2q_ns": gate_ns,
            "t_meas_ns": gate_ns, "t_reset_ns": syndrome_cycle_ns,
            "err_1q": err_1q, "err_2q": err_2q, "err_meas": err_2q,
            "logical_error_suppression_ratio": physical_2q_error / err_2q}

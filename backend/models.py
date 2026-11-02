"""Hardware-independent circuit resources and explicit QPU characterization units."""

from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class CircuitSpec(BaseModel):
    """Resources for one circuit, before hardware routing and shot repetition.

    Optional native-classical estimates come from the workload adapter. Gate
    counts alone cannot identify a task-equivalent classical algorithm. Times
    are milliseconds; gate counts and depth describe a single shot.
    """

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True, allow_inf_nan=False)

    n_qubits: int = Field(strict=True, ge=1)
    depth: int = Field(strict=True, ge=0)
    n_1q: int = Field(strict=True, ge=0)
    n_2q: int = Field(strict=True, ge=0)
    n_meas: int = Field(strict=True, ge=0)
    stage1_ms: float = Field(ge=0)
    stage3_ms: float = Field(ge=0)
    native_classical_ms: float | None = Field(default=None, ge=0)
    native_classical_name: str | None = None


class QPUProfile(BaseModel):
    """Representative physics, not a live device calibration.

    None for capacity means unbounded; None for T1/T2 denotes the ideal reference.
    topology_factor multiplies depth and two-qubit count once to model routing.
    T2 and single-qubit duration are retained for future scheduling models; the
    requested estimator uses depth in two-qubit-duration units and T1 decay.
    """

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True, allow_inf_nan=False)

    id: str = Field(min_length=1)
    name: str = Field(min_length=1)
    n_qubits_max: int | None = Field(strict=True, ge=1)
    t1_us: float | None = Field(gt=0)
    t2_us: float | None = Field(gt=0)
    t_1q_ns: float = Field(ge=0)
    t_2q_ns: float = Field(gt=0)
    t_meas_ns: float = Field(ge=0)
    t_reset_ns: float = Field(ge=0)
    err_1q: float = Field(ge=0, le=1)
    err_2q: float = Field(ge=0, le=1)
    err_meas: float = Field(ge=0, le=1)
    topology_factor: float = Field(ge=1)
    provenance: dict[str, Any]

"""Hardware-independent circuit resources and explicit QPU characterization units."""

from typing import Annotated, Any
from typing_extensions import TypedDict

from pydantic import BaseModel, ConfigDict, Field


class LogSurvivalTerms(TypedDict):
    """Natural-log contributions; idle_t1/idle_t2 are alternatives, null is -infinity."""

    two_qubit: Annotated[float | None, Field(le=0, allow_inf_nan=False)]
    one_qubit: Annotated[float | None, Field(le=0, allow_inf_nan=False)]
    measurement: Annotated[float | None, Field(le=0, allow_inf_nan=False)]
    idle_t1: Annotated[float | None, Field(le=0, allow_inf_nan=False)]
    idle_t2: Annotated[float | None, Field(le=0, allow_inf_nan=False)]


class StageMetrics(TypedDict, total=False):
    """Typed survival fields inside the existing extensible metrics dictionary.

    Optional keys preserve historical/host-stage telemetry. Extra workload metrics
    remain allowed; TypedDict retains dictionary operations used by the routers.
    """

    coherence_survival: Annotated[float, Field(ge=0, le=1, allow_inf_nan=False)]
    coherence_survival_pct: Annotated[float, Field(ge=0, le=100, allow_inf_nan=False)]
    coherence_survival_best: Annotated[float, Field(ge=0, le=1, allow_inf_nan=False)]
    coherence_survival_worst: Annotated[float, Field(ge=0, le=1, allow_inf_nan=False)]
    log_survival_terms: LogSurvivalTerms | None


# Pydantic supports TypedDict configuration through this attribute. Retain
# dictionaries and explicit OpenAPI fields without requiring a newer decorator.
setattr(StageMetrics, "__pydantic_config__", ConfigDict(extra="allow"))
setattr(LogSurvivalTerms, "__pydantic_config__", ConfigDict(extra="forbid"))


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
    topology_factor models routing; native_2q_per_cx converts CX-basis resources
    to native entanglers. Their product multiplies depth and two-qubit count once.
    t_2q_ns and err_2q describe the same native gate.
    The estimator bills depth in two-qubit-duration units, retains a T1 point
    estimate, and uses T2 for its alternative idle-decay sensitivity scenario.
    Single-qubit duration is retained for future scheduling models.
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
    native_2q_per_cx: float = Field(default=1.0, ge=1)
    provenance: dict[str, Any]

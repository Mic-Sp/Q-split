"""Hardware-independent circuit resources and explicit QPU characterization units."""

from typing import Annotated, Any, Literal
from typing_extensions import NotRequired, TypedDict

from pydantic import BaseModel, ConfigDict, Field, model_validator
import math

if __package__:
    from .surface_code import surface_code_parameters
else:
    from surface_code import surface_code_parameters

BuiltinHardwareProfile = Literal["ibm_heron_nisq", "ibm_nighthawk_r2", "ibm_nighthawk_r3", "ibm_nighthawk_r3_dual", "google_weber_grid", "ionq_forte_trapped_ion", "ftqc_surface_code", "ideal_sim"]
HardwareProfile = Literal[BuiltinHardwareProfile, "custom"]

RESOURCE_MODEL_VERSION = 2
ROUTING_MODEL = "CALIBRATED_V2"


class LogSurvivalTerms(TypedDict):
    """Natural-log contributions; idle_t1/idle_t2 are alternatives, null is -infinity."""

    two_qubit: Annotated[float | None, Field(le=0, allow_inf_nan=False)]
    one_qubit: Annotated[float | None, Field(le=0, allow_inf_nan=False)]
    measurement: Annotated[float | None, Field(le=0, allow_inf_nan=False)]
    idle_t1: Annotated[float | None, Field(le=0, allow_inf_nan=False)]
    idle_t2: Annotated[float | None, Field(le=0, allow_inf_nan=False)]
    interconnect: NotRequired[Annotated[float | None, Field(le=0, allow_inf_nan=False)]]


class StageMetrics(TypedDict, total=False):
    """Typed survival fields inside the existing extensible metrics dictionary.

    Optional keys preserve historical/host-stage telemetry. Extra workload metrics
    remain allowed; TypedDict retains dictionary operations used by the routers.
    """

    coherence_survival: Annotated[float, Field(ge=0, le=1, allow_inf_nan=False)]
    coherence_survival_pct: Annotated[float, Field(ge=0, le=100, allow_inf_nan=False)]
    coherence_survival_best: Annotated[float, Field(ge=0, le=1, allow_inf_nan=False)]
    coherence_survival_worst: Annotated[float, Field(ge=0, le=1, allow_inf_nan=False)]
    coherence_log_survival: Annotated[float | None, Field(le=0, allow_inf_nan=False)]
    log_survival_terms: LogSurvivalTerms | None
    interconnect_model_version: Literal[1]
    modules_used: Annotated[int, Field(ge=1, le=2)]
    transfers_per_shot: Annotated[int, Field(ge=0)]
    scheduled_transfer_rounds: Annotated[int, Field(ge=0)]
    link_time_ns: Annotated[float, Field(ge=0, allow_inf_nan=False)]
    link_execution_ms: Annotated[float, Field(ge=0, allow_inf_nan=False)]
    link_log_survival: Annotated[float, Field(le=0, allow_inf_nan=False)]
    selected_transfer_fidelity: Annotated[float | None, Field(gt=0, le=1, allow_inf_nan=False)]
    fidelity_scenario: Literal["demonstrated", "target_2027"]
    module_placement: Literal["auto", "dual"]
    transfer_duration_ns: Annotated[float | None, Field(gt=0, allow_inf_nan=False)]


# Pydantic supports TypedDict configuration through this attribute. Retain
# dictionaries and explicit OpenAPI fields without requiring a newer decorator.
setattr(StageMetrics, "__pydantic_config__", ConfigDict(extra="allow"))
setattr(LogSurvivalTerms, "__pydantic_config__", ConfigDict(extra="forbid"))


class InterconnectConfig(BaseModel):
    """Exploratory linked-system controls; duration is an assumption, not calibration."""

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True, allow_inf_nan=False,
                              revalidate_instances="always")
    placement: Literal["auto", "dual"] = "auto"
    fidelity_scenario: Literal["demonstrated", "target_2027"] = "demonstrated"
    transfer_duration_ns: float | None = Field(default=None, gt=0, le=1_000_000)


class CircuitSpec(BaseModel):
    """Resources for one circuit, before hardware routing and shot repetition.

    Optional native-classical estimates come from the workload adapter. Gate
    counts alone cannot identify a task-equivalent classical algorithm. Times
    are milliseconds; gate counts and depth describe a single shot.
    """

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True, allow_inf_nan=False,
                              revalidate_instances="always")

    n_qubits: int = Field(strict=True, ge=1)
    depth: int = Field(strict=True, ge=0)
    n_1q: int = Field(strict=True, ge=0)
    n_2q: int = Field(strict=True, ge=0)
    n_meas: int = Field(strict=True, ge=0)
    stage1_ms: float = Field(ge=0)
    stage3_ms: float = Field(ge=0)
    native_classical_ms: float | None = Field(default=None, ge=0)
    native_classical_name: str | None = None
    interconnect: InterconnectConfig | None = None


class QPUPhysicsSpec(BaseModel):
    """Representative physics, not a live device calibration.

    None for capacity means unbounded. None for T1/T2 disables separate memory
    decay: the ideal reference or active-QEC memory errors folded into logical
    operation errors. Profile provenance must distinguish those assumptions.
    topology_factor models routing; native_2q_per_cx converts CX-basis resources
    to native entanglers. Their product multiplies depth and two-qubit count once.
    t_2q_ns and err_2q describe the same native gate.
    The estimator bills depth in two-qubit-duration units, retains a T1 point
    estimate, and uses T2 for its alternative idle-decay sensitivity scenario.
    Single-qubit duration is retained for future scheduling models.
    repetition_rate_hz optionally sets a minimum complete shot period; pacing
    extends wall-clock control overhead, never coherent circuit exposure.
    """

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True, allow_inf_nan=False,
                              revalidate_instances="always")

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
    # Optional peak shot rate in Hz. None preserves timing-only historical profiles.
    repetition_rate_hz: float | None = Field(default=None, gt=0)
    n_physical_qubits: int | None = Field(default=None, ge=1)
    # Vendor operation target, advisory: not a depth cutoff or fidelity guarantee.
    max_operations: int | None = Field(default=None, ge=1)
    module_count: int = Field(default=1, ge=1, le=2)
    qubits_per_module: int | None = Field(default=None, ge=1)
    l_couplers_installed: int = Field(default=0, ge=0)
    l_couplers_active: int = Field(default=0, ge=0)
    state_transfer_fidelity: float | None = Field(default=None, gt=0, le=1)
    state_transfer_target_fidelity: float | None = Field(default=None, gt=0, le=1)
    transfer_duration_ns: float | None = Field(default=None, gt=0)

    @model_validator(mode="after")
    def validate_modules(self):
        if self.l_couplers_active > self.l_couplers_installed:
            raise ValueError("Active l-couplers cannot exceed installed channels")
        if self.module_count > 1 and (self.qubits_per_module is None or not self.l_couplers_active
                                     or self.state_transfer_fidelity is None or self.transfer_duration_ns is None):
            raise ValueError("Linked modules require capacity, active channels, fidelity and duration")
        if self.module_count == 1 and self.l_couplers_active:
            raise ValueError("A single module cannot have active cross-module channels")
        return self


class SurfaceCodeMetadata(BaseModel):
    """Versioned, reproducible generator inputs; footprint is verified, not trusted."""

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True, allow_inf_nan=False, revalidate_instances="always")
    model_version: Literal[1] = 1
    code_distance_d: int = Field(ge=3)
    physical_2q_error: float = Field(gt=0, lt=1)
    threshold_error: float = Field(gt=0, lt=1)
    syndrome_cycle_ns: float = Field(gt=0)
    logical_qubits_target: int = Field(ge=1, le=2_147_483_647)
    physical_qubits_per_logical: int = Field(ge=1)

    @model_validator(mode="after")
    def validate_generator(self):
        derived = surface_code_parameters(self.code_distance_d, self.physical_2q_error, self.threshold_error,
                                          self.syndrome_cycle_ns, self.logical_qubits_target)
        if self.physical_qubits_per_logical != derived["physical_qubits_per_logical"]:
            raise ValueError("Surface-code patch footprint must equal 2*d^2")
        return self


class QPUProfile(QPUPhysicsSpec):
    """Resolved execution profile; its provenance is generated on the server."""

    id: str = Field(min_length=1)
    name: str = Field(min_length=1)
    provenance: dict[str, Any]
    surface_code: SurfaceCodeMetadata | None = None


class CustomQPUProfileSpec(QPUPhysicsSpec):
    """User-defined physics, sharing the built-in profile's strict validators.

    Up to two modules use the existing partition model. Metadata does not grant
    extra programmable capacity. Labels are data and never trusted instructions.
    """

    name: str = Field(min_length=1, max_length=120)
    base_profile_id: BuiltinHardwareProfile | None = None
    surface_code: SurfaceCodeMetadata | None = None

    @model_validator(mode="before")
    @classmethod
    def infer_installed_channels(cls, value):
        if isinstance(value, dict) and "l_couplers_installed" not in value:
            return {**value, "l_couplers_installed": value.get("l_couplers_active", 0)}
        return value

    @model_validator(mode="after")
    def validate_identity_and_geometry(self):
        if not self.name.strip() or any(ord(char) < 32 or 127 <= ord(char) <= 159 for char in self.name):
            raise ValueError("Custom name must contain printable text")
        if self.n_qubits_max is not None and self.n_qubits_max > 2_147_483_647:
            raise ValueError("Custom capacity must fit the supported int32 range")
        if self.qubits_per_module is not None and self.n_qubits_max is not None and self.n_qubits_max > self.module_count * self.qubits_per_module:
            raise ValueError("Custom capacity exceeds the declared module geometry")
        if self.surface_code is not None:
            source = self.surface_code
            generated = surface_code_parameters(source.code_distance_d, source.physical_2q_error, source.threshold_error,
                                                source.syndrome_cycle_ns, source.logical_qubits_target)
            expected = {key: generated[key] for key in ("t_1q_ns", "t_2q_ns", "t_meas_ns", "t_reset_ns", "err_1q", "err_2q", "err_meas")}
            expected.update(n_qubits_max=source.logical_qubits_target, n_physical_qubits=generated["total_physical_qubits"],
                            topology_factor=1.0, native_2q_per_cx=1.0)
            exact = {"n_qubits_max", "n_physical_qubits", "topology_factor", "native_2q_per_cx"}
            if self.t1_us is not None or self.t2_us is not None or any(
                (getattr(self, key) != value if key in exact else getattr(self, key) is None or not math.isclose(getattr(self, key), value, rel_tol=1e-10, abs_tol=0))
                for key, value in expected.items()
            ):
                raise ValueError("Surface-code metadata does not match the generated profile; remove the generator tag after manual physics edits")
        return self

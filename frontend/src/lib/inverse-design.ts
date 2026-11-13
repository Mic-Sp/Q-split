import type { CircuitSpec, CustomQPUProfileSpec, InterconnectConfig, LogSurvivalTerms, SimulationRequest } from "@/types/telemetry";
import type { CompletedRun } from "@/types/run-history";
import { parseCustomProfile, validateCustomTelemetryProfile } from "@/lib/custom-profile";
import { applySurfaceCodeParameters, calculateSurfaceCode, SURFACE_CODE_DEFAULTS } from "@/lib/surface-code";
import { parseInterconnect } from "@/lib/interconnect";

const POINT_TERMS = ["one_qubit", "two_qubit", "measurement", "idle_t1", "interconnect"] as const;
type Loss = typeof POINT_TERMS[number];
type Terms = Record<Loss | "idle_t2", number>;
type Parameters = Pick<CustomQPUProfileSpec, "err_1q" | "err_2q" | "err_meas" | "t1_us" | "t2_us"> & { l_coupler_fidelity?: number };
const close = (a: number, b: number) => a === b || (Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 1e-10 * Math.max(1, Math.abs(a), Math.abs(b)));
const probability = (log: number) => Math.exp(log);
const wireLog = (log: number) => Number.isFinite(log) ? log : null;
const loss = (count: number, error: number) => count === 0 ? 0 : count * Math.log1p(-error);

/** Keep only executable numeric resources, never explanatory strings or client recipes. */
export function parseInverseCircuit(value: unknown): CircuitSpec {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Missing exact circuit resources.");
  const source = value as Record<string, unknown>;
  const result = {} as CircuitSpec;
  for (const field of ["n_qubits", "depth", "n_1q", "n_2q", "n_meas"] as const) {
    const n = source[field];
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < (field === "n_qubits" ? 1 : 0)) throw new Error("Invalid exact circuit resources.");
    result[field] = n;
  }
  for (const field of ["stage1_ms", "stage3_ms"] as const) {
    const n = source[field];
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0) throw new Error("Invalid host resource timing.");
    result[field] = n;
  }
  return result;
}

/** Mirrors backend/estimation.py, including expanded CX counts, link stalls,
 * whole-register idle exposure, T2 fallback, and the complete-shot rate floor.
 * Shots affect latency, never per-shot survival. BigInt mirrors Python's exact
 * integer partition approximation before returning safe JSON numbers. */
export function evaluateInverseCircuit(spec: CircuitSpec, profile: CustomQPUProfileSpec, config?: InterconnectConfig | null) {
  const depth = Math.ceil(spec.depth * profile.topology_factor * (profile.native_2q_per_cx ?? 1));
  const N2 = Math.ceil(spec.n_2q * profile.topology_factor * (profile.native_2q_per_cx ?? 1));
  let modules = 1, transfers = 0, rounds = 0;
  const fidelity = config?.fidelity_scenario === "target_2027" ? profile.state_transfer_target_fidelity : profile.state_transfer_fidelity;
  const duration = config?.transfer_duration_ns ?? profile.transfer_duration_ns ?? 0;
  if ((profile.module_count ?? 1) > 1 && (spec.n_qubits > profile.qubits_per_module! || config?.placement === "dual")) {
    modules = 2;
    const one = BigInt(1), two = BigInt(2);
    const q = BigInt(spec.n_qubits), left = config?.placement === "dual" ? (q + one) / two : BigInt(profile.qubits_per_module!);
    if (q < two || left >= q) throw new Error("Circuit cannot be partitioned across these modules.");
    const denominator = q * (q - one), numerator = BigInt(spec.n_2q) * two * left * (q - left);
    const transferCount = two * ((numerator + denominator - one) / denominator);
    const channels = BigInt(profile.l_couplers_active!);
    transfers = Number(transferCount); rounds = Number((transferCount + channels - one) / channels);
    if (!Number.isSafeInteger(transfers) || !Number.isSafeInteger(rounds) || !fidelity) throw new Error("Unsupported interconnect resources.");
  }
  const link_ns = rounds * duration, circuit_us = (depth * profile.t_2q_ns + link_ns) / 1000;
  const exposure_us = spec.n_qubits * circuit_us;
  if (![depth, N2].every(Number.isSafeInteger) || !Number.isFinite(exposure_us)) throw new Error("Circuit exceeds finite resource bounds.");
  const effectiveT2 = profile.t2_us ?? profile.t1_us;
  const terms: Terms = { one_qubit: loss(spec.n_1q, profile.err_1q), two_qubit: loss(N2, profile.err_2q), measurement: loss(spec.n_meas, profile.err_meas),
    idle_t1: profile.t1_us === null ? 0 : -exposure_us / profile.t1_us,
    idle_t2: effectiveT2 === null ? 0 : -exposure_us / effectiveT2,
    interconnect: transfers ? transfers * Math.log(fidelity!) : 0 };
  const point_log = POINT_TERMS.reduce((sum, key) => sum + terms[key], 0);
  const gateLog = terms.one_qubit + terms.two_qubit + terms.measurement + terms.interconnect;
  const worst_log = gateLog + Math.min(terms.idle_t1, terms.idle_t2);
  const physicalShot = circuit_us * 1000 + profile.t_meas_ns + profile.t_reset_ns;
  const shot_period_ns = profile.repetition_rate_hz ? Math.max(physicalShot, 1e9 / profile.repetition_rate_hz) : physicalShot;
  if (!Number.isFinite(shot_period_ns)) throw new Error("Hardware parameters exceed finite shot timing.");
  return { n_qubits: spec.n_qubits, n_1q: spec.n_1q, N2, n_meas: spec.n_meas, depth, circuit_us, exposure_us,
    modules_used: modules, transfers_per_shot: transfers, scheduled_transfer_rounds: rounds, link_time_ns: link_ns, shot_period_ns,
    terms, point_log, worst_log, survival: probability(point_log), worst_survival: probability(worst_log) };
}
type Forward = ReturnType<typeof evaluateInverseCircuit>;

function profileWithRecipe(base: CustomQPUProfileSpec, recipe: Parameters, request: SimulationRequest) {
  const { l_coupler_fidelity: fidelity, ...fields } = recipe;
  const profile = { ...base, ...fields, surface_code: undefined };
  if (fidelity !== undefined) {
    if (request.interconnect?.fidelity_scenario === "target_2027") profile.state_transfer_target_fidelity = fidelity;
    else profile.state_transfer_fidelity = fidelity;
  }
  return parseCustomProfile(profile);
}

function balanced(spec: CircuitSpec, profile: CustomQPUProfileSpec, request: SimulationRequest, current: Forward, target: number) {
  const goal = Math.log(target);
  if (current.point_log >= goal) return { status: "already_met" as const };
  if (!Number.isFinite(current.point_log)) return { status: "certain_failure" as const, reason: "Uniform log scaling is undefined for a certain-failure term; change the unit error first or use a verified surface-code alternative." };
  const k = goal / current.point_log;
  const parameters: Parameters = { err_1q: spec.n_1q ? -Math.expm1(k * current.terms.one_qubit / spec.n_1q) : profile.err_1q,
    err_2q: current.N2 ? -Math.expm1(k * current.terms.two_qubit / current.N2) : profile.err_2q,
    err_meas: spec.n_meas ? -Math.expm1(k * current.terms.measurement / spec.n_meas) : profile.err_meas,
    t1_us: profile.t1_us === null ? null : profile.t1_us / k,
    t2_us: profile.t2_us === null ? null : profile.t2_us / k,
    ...(current.transfers_per_shot ? { l_coupler_fidelity: Math.exp(k * current.terms.interconnect / current.transfers_per_shot) } : {}) };
  try {
    const proposed = profileWithRecipe(profile, parameters, request);
    const check = evaluateInverseCircuit(spec, proposed, request.interconnect);
    // An absolute log tolerance prevents tiny target losses from hiding behind
    // relative comparisons to a huge source log; retain full precision for Apply.
    if (!Number.isFinite(check.point_log) || Math.abs(check.point_log - goal) > 1e-10) throw new Error("Recipe is outside representable precision.");
    return { status: "verified" as const, k, parameters, verified_survival: check.survival, worst_survival: check.worst_survival };
  } catch {
    return { status: "numeric_limits" as const, reason: "No exact finite recipe is representable at these resource counts; no Apply action is offered." };
  }
}

function isolated(current: Forward, target: number) {
  const dominant = POINT_TERMS.reduce((a, b) => current.terms[b] < current.terms[a] ? b : a);
  const otherLog = POINT_TERMS.filter(key => key !== dominant).reduce((sum, key) => sum + current.terms[key], 0);
  const ceiling = probability(otherLog), goal = Math.log(target), needed = goal - otherLog;
  const common = { subsystem: dominant, ceiling_survival: ceiling, ceiling_log_survival: wireLog(otherLog) };
  if (current.point_log >= goal) return { ...common, status: "already_met" as const };
  if (needed > 0 || !Number.isFinite(needed)) return { ...common, status: "ceiling_below_target" as const };
  let parameter: string, value: number;
  switch (dominant) {
    case "one_qubit": parameter = "err_1q"; value = -Math.expm1(needed / current.n_1q); break;
    case "two_qubit": parameter = "err_2q"; value = -Math.expm1(needed / current.N2); break;
    case "measurement": parameter = "err_meas"; value = -Math.expm1(needed / current.n_meas); break;
    case "interconnect": parameter = "l_coupler_fidelity"; value = Math.exp(needed / current.transfers_per_shot); break;
    default: parameter = "t1_us"; value = -current.exposure_us / needed;
  }
  if (!Number.isFinite(value)) return { ...common, status: "infinite_lifetime_required" as const };
  // Check the actual parameter inversion, including link rounding near unity.
  const actual = dominant === "idle_t1" ? -current.exposure_us / value : dominant === "interconnect"
    ? current.transfers_per_shot * Math.log(value) : loss(dominant === "one_qubit" ? current.n_1q : dominant === "two_qubit" ? current.N2 : current.n_meas, value);
  if (!close(actual + otherLog, goal)) return { ...common, status: "numeric_limits" as const };
  return { ...common, status: "solved" as const, parameter, value, verified_survival: probability(actual + otherLog) };
}

function surfaceBridge(spec: CircuitSpec, profile: CustomQPUProfileSpec, request: SimulationRequest, current: Forward, target: number, recipe: ReturnType<typeof balanced>) {
  const logical = profile.t1_us === null && profile.t2_us === null;
  if (current.point_log >= Math.log(target) || (logical && !(recipe.status === "verified" && recipe.parameters.err_2q < 1e-4))) return null;
  const physical = profile.surface_code?.physical_2q_error ?? (!logical && profile.err_2q > 0 && profile.err_2q < 1 ? profile.err_2q : 0.001);
  const source = profile.surface_code ? "recorded_generator" : !logical && profile.err_2q > 0 && profile.err_2q < 1 ? "custom_physical_2q_error" : "assumed_1e-3_baseline";
  const inputs = { ...SURFACE_CODE_DEFAULTS, ...profile.surface_code, physical_2q_error: physical,
    logical_qubits_target: request.available_qubits ?? profile.n_qubits_max ?? spec.n_qubits };
  const required = recipe.status === "verified" && current.N2 > 0 && recipe.parameters.err_2q > 0 ? recipe.parameters.err_2q : null;
  const common = { physical_2q_error: physical, physical_error_source: source, threshold_error: inputs.threshold_error,
    syndrome_cycle_ns: inputs.syndrome_cycle_ns, required_logical_2q_error: required,
    footprint_basis: "2*d^2 per logical patch; r3 modules use 520 programmable qubits, excluding factories and routing" };
  if (physical >= inputs.threshold_error) return { ...common, status: "above_threshold" as const, minimum_error_distance: null };
  let minimumError: number | null = null;
  for (let d = 3; d <= 35; d += 2) {
    const calculation = calculateSurfaceCode({ ...inputs, code_distance_d: d });
    if (required !== null && calculation.err_2q > required) continue;
    minimumError ??= d;
    const candidate = applySurfaceCodeParameters(profile, { ...inputs, code_distance_d: d });
    const check = evaluateInverseCircuit(spec, candidate);
    if (check.point_log + 1e-12 < Math.log(target)) continue;
    const activeFootprint = calculation.physical_qubits_per_logical * spec.n_qubits;
    return { ...common, status: "verified" as const, minimum_error_distance: minimumError, minimum_verified_distance: d,
      generator: calculation.metadata, logical_err_2q: calculation.err_2q,
      total_physical_qubits: calculation.total_physical_qubits, active_circuit_physical_qubits: activeFootprint,
      nighthawk_r3_modules_required: calculation.nighthawk_r3_modules_required, active_circuit_modules_required: Math.ceil(activeFootprint / 520),
      verified_survival: check.survival, worst_survival: check.worst_survival, circuit_us: check.circuit_us,
      shot_period_ns: check.shot_period_ns };
  }
  return { ...common, status: "unreachable_in_range" as const, minimum_error_distance: minimumError,
    reason: "No odd distance from 3 through 35 meets both the required logical 2Q error and whole-circuit target under this calibrated proxy." };
}

/** Stateless and safe on restored/legacy telemetry: never guess missing resources.
 * Validate the embedded custom characterization and replay every recorded loss
 * before allowing a verified recipe. Incoming inverse_design_targets are ignored. */
export function inverseDesignTargets(run: CompletedRun) {
  const unavailable = (reason: string) => ({ version: 1 as const, status: "unavailable" as const, reason });
  if (run.request.hardware_profile !== "custom") return unavailable("Inverse design requires a custom profile.");
  try {
    const stage = run.telemetry.stages.stage_2_quantum_kernel, m = stage.metrics;
    if (stage.node !== "QPU" || m.execution_feasible === false || m.routing_supported === false ||
      Object.entries(run.telemetry.stages).some(([key, stage]) => key !== "stage_2_quantum_kernel" && stage.node === "QPU")) return unavailable("Resolve routing or capacity blockers before inverse design.");
    for (const [key, field, fallback] of [["stage_1_classical_pre", "stage_1_node", "CPU"], ["stage_2_quantum_kernel", "stage_2_node", "QPU"], ["stage_3_classical_post", "stage_3_node", "CPU"]] as const) {
      if (run.telemetry.stages[key].node !== (run.request.routing?.[field] ?? fallback)) return unavailable("Captured routing does not match executed stages.");
    }
    const capacity = run.request.available_qubits ?? m.available_qubits;
    if (typeof capacity !== "number" || !Number.isSafeInteger(capacity) || capacity < 1 || capacity > 2147483647) return unavailable("Captured execution capacity is required; rerun this historical record.");
    const capturedRequest = { ...run.request, available_qubits: capacity };
    const profile = parseCustomProfile(run.request.custom_profile);
    parseInterconnect(run.request.interconnect, "custom", profile);
    validateCustomTelemetryProfile(m.qpu_profile, profile);
    if (m.resource_model_version !== 2 || !m.log_survival_terms) return unavailable("Exact calibrated circuit resources and survival terms are required; rerun this historical record.");
    const spec = parseInverseCircuit(m.circuit_spec);
    if (spec.n_qubits > capacity) return unavailable("The captured capacity cannot execute this circuit.");
    const forward = evaluateInverseCircuit(spec, profile, run.request.interconnect);
    const recorded = m.log_survival_terms;
    for (const key of [...POINT_TERMS, "idle_t2"] as const) {
      const term = key === "interconnect" && recorded[key] === undefined ? 0 : recorded[key];
      if (term === undefined || !close(term === null ? -Infinity : term, forward.terms[key])) throw new Error("Recorded loss terms do not match the captured profile and circuit.");
    }
    for (const [key, expected] of Object.entries({ n_2q: forward.N2, circuit_depth: forward.depth, t_circuit_us: forward.circuit_us,
      transfers_per_shot: forward.transfers_per_shot, scheduled_transfer_rounds: forward.scheduled_transfer_rounds, link_time_ns: forward.link_time_ns })) {
      if (typeof m[key] !== "number" || !close(m[key] as number, expected)) throw new Error("Missing or inconsistent exact circuit diagnostics.");
    }
    if (m.coherence_log_survival !== undefined && !close(m.coherence_log_survival === null ? -Infinity : m.coherence_log_survival, forward.point_log)) throw new Error("Recorded point survival is inconsistent.");
    if (typeof m.coherence_survival_pct !== "number" || !close(m.coherence_survival_pct, forward.survival * 100)) throw new Error("Recorded survival percentage is inconsistent.");
    return { version: 1 as const, status: "available" as const, survival_basis: "Per-shot T1 point estimate; T2 is an alternative worst sensitivity bound, not statistical confidence.",
      source: { available_qubits: capacity, n_1q: spec.n_1q, N2: forward.N2, n_meas: spec.n_meas, n_qubits: spec.n_qubits, circuit_us: forward.circuit_us,
        exposure_us: forward.exposure_us, transfers_per_shot: forward.transfers_per_shot, current_survival: forward.survival,
        current_log_survival: wireLog(forward.point_log), log_survival_terms: Object.fromEntries(Object.entries(forward.terms).map(([key, value]) => [key, wireLog(value)])) as unknown as LogSurvivalTerms },
      targets: [0.5, 0.8].map(target => {
        const recipe = balanced(spec, profile, capturedRequest, forward, target);
        return { target_survival: target, balanced: recipe, single_bottleneck: isolated(forward, target),
          surface_code: surfaceBridge(spec, profile, capturedRequest, forward, target, recipe) };
      }) };
  } catch (error) { return unavailable(error instanceof Error ? error.message : "Invalid captured resources."); }
}

/** Apply only freshly verified local recipes, preserving captured workload,
 * capacity tier and routing even if the user has since edited live controls. */
export function applyInverseDesignRecipe(run: CompletedRun, target: number, path: "balanced" | "surface_code" = "balanced"): SimulationRequest {
  const result = inverseDesignTargets(run);
  if (result.status !== "available") throw new Error(result.reason);
  const goal = result.targets.find(item => item.target_survival === target);
  if (!goal) throw new Error("Unsupported survival target.");
  const request = structuredClone(run.request), base = parseCustomProfile(request.custom_profile);
  request.available_qubits = result.source.available_qubits;
  if (path === "balanced") {
    if (goal.balanced.status !== "verified") throw new Error("No verified balanced recipe is available.");
    request.custom_profile = profileWithRecipe(base, goal.balanced.parameters, request);
  } else {
    if (goal.surface_code?.status !== "verified") throw new Error("No verified surface-code alternative is available.");
    request.custom_profile = parseCustomProfile(applySurfaceCodeParameters(base, goal.surface_code.generator));
    delete request.interconnect;
  }
  return request;
}

export function inverseDesignRecommendation(run: CompletedRun): string | null {
  if (run.request.hardware_profile !== "custom") return null;
  const result = inverseDesignTargets(run);
  if (result.status !== "available") return `Inverse design unavailable: ${result.reason}`;
  const target = result.targets[0], recipe = target.balanced, fmt = (n: number) => n.toExponential(6);
  let text = `For ${run.telemetry.scale_label}, 50% per-shot T1 point survival: `;
  if (recipe.status === "verified") {
    const p = recipe.parameters;
    text += `1Q error ${fmt(p.err_1q)}, 2Q error ${fmt(p.err_2q)}, readout error ${fmt(p.err_meas)}, T1 ${p.t1_us === null ? "disabled" : fmt(p.t1_us) + " µs"}, T2 ${p.t2_us === null ? "fallback/disabled" : fmt(p.t2_us) + " µs"}${p.l_coupler_fidelity === undefined ? "" : `, link fidelity ${p.l_coupler_fidelity.toPrecision(12)}`}; verified point ${(100 * recipe.verified_survival).toFixed(2)}%, T2 worst ${(100 * recipe.worst_survival).toFixed(2)}%. Apply the full-precision recipe, then rerun.`;
  } else text += recipe.status === "already_met" ? "already met; retain current parameters." : `${recipe.status}; no exact balanced Apply action is available.`;
  const isolated = target.single_bottleneck;
  text += ` Perfecting ${isolated.subsystem} alone has a ${(100 * isolated.ceiling_survival).toPrecision(4)}% survival ceiling.`;
  const surface = target.surface_code;
  if (surface?.status === "verified") text += ` Alternative: minimum verified surface-code d=${surface.minimum_verified_distance}, ${surface.total_physical_qubits} physical qubits (${surface.nighthawk_r3_modules_required} r3 modules at 520 programmable qubits each), with slower logical gates and no separate idle decay; a calibrated model proxy.`;
  else if (surface) text += ` Surface-code bridge: ${surface.status}.`;
  return text;
}

import assert from "node:assert/strict";
import { test } from "node:test";
import { ADVISOR_MAX_OUTPUT_CHARS, ADVISOR_SECTION_MAX_CHARS, parseGeneratedOutput, validateGeneratedSections } from "./advisor-output";

const valid = () => ({
  routingDiagnosis: "CPU → QPU → CPU routing is unchanged. The QPU reports 0.14 ms of modeled latency.",
  spaceTimeTradeOff: "At n = 5, capacity of 15 qubits selects Windowed Parallel. The modeled depth is 262 and coherence is 80.38%.",
  optimizationRecommendation: "Set available_qubits to 28 to reach Carry-Lookahead Parallel. Compare the new depth and latency at the same scale.",
});

test("generated diagnostics accept exact sections, normalize text, and count decimal values correctly", () => {
  const sections = valid();
  assert.deepEqual(parseGeneratedOutput(JSON.stringify(sections)), sections);
  sections.routingDiagnosis = "  CPU → QPU → CPU routing is unchanged.\n\nThe QPU reports 0.14 ms of modeled latency.  ";
  assert.equal(validateGeneratedSections(sections).routingDiagnosis, valid().routingDiagnosis);
  sections.routingDiagnosis = "The QPU reports 0.14 ms. State preparation is 0.05 ms. Coherence is 90.33%. Try the ideal profile.";
  assert.doesNotThrow(() => validateGeneratedSections(sections));
  sections.routingDiagnosis += " Keep the scale fixed.";
  assert.throws(() => validateGeneratedSections(sections));
});

test("generated diagnostics reject malformed schemas, short/long sections, control text, and oversized JSON", () => {
  for (const value of [null, [], {}, { ...valid(), extra: "unexpected" }, { ...valid(), routingDiagnosis: undefined },
    { ...valid(), routingDiagnosis: 42 }, { ...valid(), routingDiagnosis: "  " },
    { ...valid(), routingDiagnosis: "Too short." }, { ...valid(), routingDiagnosis: "x".repeat(ADVISOR_SECTION_MAX_CHARS + 1) },
    { ...valid(), routingDiagnosis: "Invalid control\u0000characters in this sentence." },
  ]) assert.throws(() => validateGeneratedSections(value));
  assert.throws(() => parseGeneratedOutput("```json\n" + JSON.stringify(valid()) + "\n```"));
  assert.throws(() => parseGeneratedOutput("{"));
  assert.throws(() => parseGeneratedOutput(" ".repeat(ADVISOR_MAX_OUTPUT_CHARS + 1)));
  assert.doesNotThrow(() => validateGeneratedSections({ ...valid(), routingDiagnosis: "x".repeat(ADVISOR_SECTION_MAX_CHARS) }));
});

test("unsupported physical hardware actions and claims are rejected in every diagnostic section", () => {
  const banned = [
    "Perform pulse calibration to improve coherence survival.",
    "Perform PULSE-LEVEL CALIBRATION to improve coherence survival.",
    "Perform pul\u200bse‑level calibra\u200btion to improve coherence survival.",
    "Calibrate the microwave pulses to reduce gate errors.",
    "Recalibrate the QPU before rerunning this workload.",
    "Tune microwave pulses to improve survival probability.",
    "Use pulse shaping to reduce two-qubit gate errors.",
    "Add error-correction buffers to the available qubits.",
    "Reserve fault-tolerant overhead qubits for the workload.",
    "Reserve ancilla qubits for QEC to improve survival.",
    "Enable surface-code error correction on this device.",
    "Apply error mitigation to recover the factors.",
    "Apply dynamical decoupling to preserve coherence.",
    "This circuit executed on a physical QPU and returned factors.",
    "The actual quantum hardware measured these latencies.",
  ];
  for (const key of Object.keys(valid())) for (const text of banned) {
    assert.throws(() => validateGeneratedSections({ ...valid(), [key]: text }), `${key}: ${text}`);
  }
  const limitations = valid();
  limitations.spaceTimeTradeOff = "Physical error-correction overhead is excluded from this model. The ideal profile is not a physical error-corrected device.";
  assert.doesNotThrow(() => validateGeneratedSections(limitations));
  for (const disclaimer of [
    "This workload was not executed on a physical QPU.",
    "The reference circuit executed on Aer, not a physical QPU.",
    "No physical QPU was measured in this simulation.",
  ]) assert.doesNotThrow(() => validateGeneratedSections({ ...valid(), routingDiagnosis: disclaimer }));
});

import "server-only";
import { parseAdvisorSections } from "@/lib/advisor";
import type { AdvisorSections } from "@/types/advisor";

export const ADVISOR_TIMEOUT_MS = 18_000;
export const ADVISOR_OUTPUT_TOKENS = 1024;
export const ADVISOR_TEMPERATURE = 0.1;
export const ADVISOR_SECTION_MIN_CHARS = 20;
export const ADVISOR_SECTION_MAX_CHARS = 900;
export const ADVISOR_MAX_SENTENCES = 4;
export const ADVISOR_MAX_OUTPUT_CHARS = 4096;

const sectionKeys = ["routingDiagnosis", "spaceTimeTradeOff", "optimizationRecommendation"] as const;

export const ADVISOR_RESPONSE_SCHEMA = {
  type: "object", additionalProperties: false, required: sectionKeys,
  properties: Object.fromEntries(sectionKeys.map((key) => [key, {
    type: "string", minLength: ADVISOR_SECTION_MIN_CHARS, maxLength: ADVISOR_SECTION_MAX_CHARS,
    description: "1–4 concise plain-text sentences grounded in the supplied telemetry and Q-Split controls.",
  }])),
};

const sentenceSegmenter = new Intl.Segmenter("en", { granularity: "sentence" });

// Fail closed on known unsupported controls, including spelling/hyphen variants.
// Error-correction *limitations* remain valid context; prescribing correction,
// calibration, mitigation, or physical-device execution does not.
const unsupportedClaims = [
  /\bpulse(?:[\s-]+level)?[\s-]+calibrat\w*\b/i,
  /\bcalibrat\w*\b[^.!?]{0,60}\bpulses?\b/i,
  /\b(?:recalibrat\w*|calibrate|calibrating)\b/i,
  /\b(?:perform|apply|enable|run|implement)\b[^.!?]{0,60}\bcalibration\b/i,
  /\bpulse[\s-]+(?:shap\w*|schedul\w*|tun\w*|optimi[sz]\w*)\b/i,
  /\b(?:tune|adjust|shape|optimi[sz]e)\b[^.!?]{0,40}\b(?:microwave[\s-]+)?pulses?\b/i,
  /\b(?:error[\s-]+correct(?:ion|ed)|fault[\s-]+toleran\w*|surface[\s-]+code|QEC)(?:[\s-]+\w+){0,2}[\s-]+buffers?\b/i,
  /\b(?:add|allocate|reserve|enable|deploy|use|increase|implement|apply)\b[^.!?]{0,80}\b(?:error[\s-]+correct(?:ion|ed)|fault[\s-]+toleran\w*|surface[\s-]+code|QEC|error[\s-]+mitigation)\b/i,
  /\b(?:dynamical[\s-]+decoupling|zero[\s-]+noise[\s-]+extrapolation|probabilistic[\s-]+error[\s-]+cancellation|syndrome[\s-]+(?:measur\w*|decod\w*))\b/i,
];
const physicalClaims = [
  /\b(?:execute[ds]?|ran|running|measured|benchmarked|deployed)\b[^.!?]{0,60}\b(?:physical|real|actual)[\s-]+(?:QPU|quantum[\s-]+(?:hardware|processor|device))\b/gi,
  /\b(?:physical|real|actual)[\s-]+(?:QPU|quantum[\s-]+(?:hardware|processor|device))\b[^.!?]{0,40}\b(?:executed|ran|measured|benchmarked)\b/gi,
];

function claimsPhysicalExecution(sentence: string): boolean {
  return physicalClaims.some((pattern) => [...sentence.matchAll(pattern)].some((match) => {
    const preceding = sentence.slice(Math.max(0, match.index! - 40), match.index);
    // Preserve explicit disclaimers: "not executed on a physical QPU" and
    // "executed on Aer, not a physical QPU" are valid model limitations.
    return !/\b(?:not|never|no)(?:\s+actually)?\s*$/i.test(preceding) && !/\b(?:not|never|no)\b/i.test(match[0]);
  }));
}

function normalizeSection(value: string): string {
  return value.normalize("NFKC")
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, "")
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/\s+/g, " ").trim();
}

/** Stricter live-generation gate, separate from legacy history serialization. */
export function validateGeneratedSections(value: unknown): AdvisorSections {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== sectionKeys.length ||
      sectionKeys.some((key) => !Object.hasOwn(value, key))) throw new Error("Unexpected advisor output schema.");
  const sections = parseAdvisorSections(value);
  for (const key of sectionKeys) {
    const raw = sections[key];
    if (raw.length > ADVISOR_SECTION_MAX_CHARS || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(raw)) throw new Error("Invalid advisor output text.");
    const text = normalizeSection(raw);
    const sentences = [...sentenceSegmenter.segment(text)].filter(({ segment }) => /[\p{L}\p{N}]/u.test(segment));
    if (text.length < ADVISOR_SECTION_MIN_CHARS || text.length > ADVISOR_SECTION_MAX_CHARS ||
        sentences.length < 1 || sentences.length > ADVISOR_MAX_SENTENCES ||
        unsupportedClaims.some((pattern) => pattern.test(text)) ||
        sentences.some(({ segment }) => claimsPhysicalExecution(segment))) throw new Error("Advisor output failed validation.");
    sections[key] = text;
  }
  return sections;
}

export function parseGeneratedOutput(text: unknown): AdvisorSections {
  if (typeof text !== "string" || !text.trim() || text.length > ADVISOR_MAX_OUTPUT_CHARS) throw new Error("Invalid advisor output size.");
  return validateGeneratedSections(JSON.parse(text));
}

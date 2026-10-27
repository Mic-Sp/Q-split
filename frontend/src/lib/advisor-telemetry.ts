import type { AdvisorInsight, AdvisorTelemetry, AdvisorUsage } from "@/types/advisor";

export const INPUT_USD_PER_MILLION = 0.15;
export const OUTPUT_USD_PER_MILLION = 0.60;
export const tokenCostUsd = (input: number, output: number) =>
  (input * INPUT_USD_PER_MILLION + output * OUTPUT_USD_PER_MILLION) / 1_000_000;

export const zeroUsage = (): AdvisorUsage => ({
  inputTokens: 0, outputTokens: 0, totalTokens: 0, tokenSource: "none", estimatedCostUsd: 0,
});
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000;
const estimate = (text: string) => Math.ceil(text.length / 4);

export function geminiUsage(metadata: unknown, prompt: string, completion: string): AdvisorUsage {
  const raw = metadata && typeof metadata === "object" ? metadata as Record<string, unknown> : {};
  const inputTokens = count(raw.promptTokenCount) ? raw.promptTokenCount : estimate(prompt);
  // Thinking tokens are generated output too, even though they are not displayed.
  const outputTokens = (count(raw.candidatesTokenCount) ? raw.candidatesTokenCount : estimate(completion)) +
    (count(raw.thoughtsTokenCount) ? raw.thoughtsTokenCount : 0);
  return {
    inputTokens, outputTokens,
    totalTokens: Math.max(inputTokens + outputTokens, count(raw.totalTokenCount) ? raw.totalTokenCount : 0),
    tokenSource: count(raw.promptTokenCount) && count(raw.candidatesTokenCount) ? "provider" : "estimated",
    estimatedCostUsd: tokenCostUsd(inputTokens, outputTokens),
  };
}

export function withLookupTelemetry(insight: AdvisorInsight, latencyMs: number | null, shared = false): AdvisorInsight {
  const free = insight.source !== "gemini" || shared;
  const usage = free ? zeroUsage() : insight.usage;
  if (!usage) return insight; // Legacy historical entries have unknown original usage.
  return { ...insight, telemetry: {
    ...usage, latencyMs, shared,
    costSavedUsd: insight.source === "cached" || shared ? insight.usage?.estimatedCostUsd ?? 0 : 0,
  } };
}

export function cachedInsight(insight: AdvisorInsight, latencyMs: number | null = null): AdvisorInsight {
  return withLookupTelemetry({ ...insight, source: insight.source === "fallback" ? "fallback" : "cached" }, latencyMs);
}

// Optional fields support historical rows saved before telemetry was introduced.
export function parseAdvisorUsage(value: unknown): AdvisorUsage {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid advisor usage.");
  const usage = value as AdvisorUsage;
  if (![usage.inputTokens, usage.outputTokens, usage.totalTokens].every(count) ||
      usage.totalTokens < usage.inputTokens + usage.outputTokens ||
      !["provider", "estimated", "none"].includes(usage.tokenSource) ||
      usage.estimatedCostUsd !== tokenCostUsd(usage.inputTokens, usage.outputTokens) ||
      (usage.tokenSource === "none" && usage.totalTokens !== 0)) throw new Error("Invalid advisor usage.");
  return { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: usage.totalTokens,
    tokenSource: usage.tokenSource, estimatedCostUsd: usage.estimatedCostUsd };
}

export function parseAdvisorTelemetry(value: unknown, source: AdvisorInsight["source"], original?: AdvisorUsage): AdvisorTelemetry {
  const usage = parseAdvisorUsage(value);
  const raw = value as AdvisorTelemetry;
  if ((raw.latencyMs !== null && (typeof raw.latencyMs !== "number" || !Number.isFinite(raw.latencyMs) || raw.latencyMs < 0)) ||
      typeof raw.shared !== "boolean" || typeof raw.costSavedUsd !== "number" || !Number.isFinite(raw.costSavedUsd) || raw.costSavedUsd < 0 ||
      ((source !== "gemini" || raw.shared) && usage.totalTokens !== 0) ||
      raw.costSavedUsd !== (source === "cached" || raw.shared ? original?.estimatedCostUsd ?? 0 : 0)) throw new Error("Invalid advisor lookup telemetry.");
  return { ...usage, latencyMs: raw.latencyMs, shared: raw.shared, costSavedUsd: raw.costSavedUsd };
}

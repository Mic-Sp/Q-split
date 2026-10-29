import type { CompletedRun } from "@/types/run-history";

/** Three plain-text diagnostic fields shared by provider schema, local fallback, and saved history. */
export interface AdvisorSections {
  routingDiagnosis: string;
  spaceTimeTradeOff: string;
  optimizationRecommendation: string;
}

export type FallbackReason = "missing_key" | "rate_limited" | "timeout" | "provider_error" | "invalid_response" | "network_error";

/** Original generation usage and configured USD estimate; may be absent on legacy saved insights. */
export interface AdvisorUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  tokenSource: "provider" | "estimated" | "none";
  estimatedCostUsd: number;
}

/** Current lookup accounting; reuse/fallback charges zero while original generation usage remains separate. */
export interface AdvisorTelemetry extends AdvisorUsage {
  latencyMs: number | null;
  costSavedUsd: number;
  shared: boolean;
}

/** Run-bound diagnostic provenance, optional context fingerprint, and original/current usage metadata. */
export interface AdvisorInsight {
  runId: string;
  previousRunId: string | null;
  source: "gemini" | "cached" | "fallback";
  model: string | null;
  generatedAt: string;
  fallbackReason: FallbackReason | null;
  notice: string | null;
  sections: AdvisorSections;
  cacheKey?: string;
  // Original generation metrics survive cache hits and history round trips.
  usage?: AdvisorUsage;
  // Current lookup metrics; cache/fallback/shared responses consume no new tokens.
  telemetry?: AdvisorTelemetry;
}

/** Analysis plus independent database persistence status; unavailable storage does not invalidate the diagnostic. */
export interface AdvisorResponse {
  insight: AdvisorInsight;
  persistence?: { status: "saved" | "pending" | "unavailable" | "unconfigured"; message?: string };
}

/** Completed current run and optional previous run from the same workload family. */
export interface AdvisorRequest {
  current: CompletedRun;
  previous?: CompletedRun;
}

export const ADVISOR_HEADINGS: Record<keyof AdvisorSections, string> = {
  routingDiagnosis: "Bottleneck & Routing Diagnosis",
  spaceTimeTradeOff: "Space-Time & Qubit Budget Trade-Off",
  optimizationRecommendation: "Optimization Recommendation",
};

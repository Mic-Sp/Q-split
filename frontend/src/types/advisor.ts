import type { CompletedRun } from "@/types/run-history";

export interface AdvisorSections {
  routingDiagnosis: string;
  spaceTimeTradeOff: string;
  optimizationRecommendation: string;
}

export type FallbackReason = "missing_key" | "rate_limited" | "timeout" | "provider_error" | "invalid_response" | "network_error";

export interface AdvisorUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  tokenSource: "provider" | "estimated" | "none";
  estimatedCostUsd: number;
}

export interface AdvisorTelemetry extends AdvisorUsage {
  latencyMs: number | null;
  costSavedUsd: number;
  shared: boolean;
}

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

export interface AdvisorResponse {
  insight: AdvisorInsight;
  persistence?: { status: "saved" | "pending" | "unavailable" | "unconfigured"; message?: string };
}

export interface AdvisorRequest {
  current: CompletedRun;
  previous?: CompletedRun;
}

export const ADVISOR_HEADINGS: Record<keyof AdvisorSections, string> = {
  routingDiagnosis: "Bottleneck & Routing Diagnosis",
  spaceTimeTradeOff: "Space-Time & Qubit Budget Trade-Off",
  optimizationRecommendation: "Optimization Recommendation",
};

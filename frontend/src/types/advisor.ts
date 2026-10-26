import type { CompletedRun } from "@/types/run-history";

export interface AdvisorSections {
  routingDiagnosis: string;
  spaceTimeTradeOff: string;
  optimizationRecommendation: string;
}

export type FallbackReason = "missing_key" | "rate_limited" | "timeout" | "provider_error" | "invalid_response" | "network_error";

export interface AdvisorInsight {
  runId: string;
  previousRunId: string | null;
  source: "gemini" | "fallback";
  model: string | null;
  generatedAt: string;
  fallbackReason: FallbackReason | null;
  notice: string | null;
  sections: AdvisorSections;
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

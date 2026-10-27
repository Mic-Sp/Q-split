import assert from "node:assert/strict";
import { test } from "node:test";
import { cachedInsight, geminiUsage, parseAdvisorUsage, parseAdvisorTelemetry, tokenCostUsd, withLookupTelemetry, zeroUsage } from "./advisor-telemetry";
import { parseAdvisorInsight } from "./advisor";
import type { AdvisorInsight } from "@/types/advisor";

const insight = (): AdvisorInsight => ({ runId: "run", previousRunId: null, source: "gemini", model: "gemini-test",
  generatedAt: "2026-10-27T12:00:00.000Z", fallbackReason: null, notice: null,
  sections: { routingDiagnosis: "Routing diagnosis", spaceTimeTradeOff: "Space time analysis", optimizationRecommendation: "Try a new scale" },
  usage: geminiUsage({ promptTokenCount: 1000, candidatesTokenCount: 90, totalTokenCount: 1090 }, "ignored", "ignored"),
});

test("provider usage uses the configured rates and includes generated thinking tokens", () => {
  assert.equal(tokenCostUsd(1000, 90), 0.000204);
  assert.deepEqual(geminiUsage({ promptTokenCount: 1000, candidatesTokenCount: 70, thoughtsTokenCount: 20, totalTokenCount: 1090 }, "", ""), insight().usage);
  assert.deepEqual(geminiUsage({ promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 }, "long prompt", "response"), {
    ...zeroUsage(), tokenSource: "provider",
  });
});

test("missing, partial, or invalid metadata estimates only missing counts from payload length", () => {
  for (const metadata of [undefined, null, [], {}, { promptTokenCount: -1, candidatesTokenCount: "12", totalTokenCount: Infinity }]) {
    assert.deepEqual(geminiUsage(metadata, "123456789", "12345"), {
      inputTokens: 3, outputTokens: 2, totalTokens: 5, tokenSource: "estimated", estimatedCostUsd: tokenCostUsd(3, 2),
    });
  }
  const partial = geminiUsage({ promptTokenCount: 100, totalTokenCount: 102 }, "", "12345");
  assert.equal(partial.inputTokens, 100);
  assert.equal(partial.outputTokens, 2);
  assert.equal(partial.totalTokens, 102);
  assert.equal(partial.tokenSource, "estimated");
});

test("cached and shared lookups retain original usage without charging it again", () => {
  const live = withLookupTelemetry(insight(), 123);
  const cached = cachedInsight(live, 7);
  assert.equal(cached.source, "cached");
  assert.deepEqual(cached.usage, live.usage);
  assert.deepEqual(cached.telemetry, { ...zeroUsage(), latencyMs: 7, shared: false, costSavedUsd: 0.000204 });
  assert.deepEqual(parseAdvisorInsight(cached, "run"), cached);
  const shared = withLookupTelemetry(live, 12, true);
  assert.equal(shared.source, "gemini");
  assert.equal(shared.telemetry?.totalTokens, 0);
  assert.deepEqual(parseAdvisorInsight(shared, "run"), shared);
  assert.equal(cachedInsight(live).telemetry?.latencyMs, null, "History does not pretend the original inference duration is this lookup's latency");
  assert.equal(live.telemetry?.estimatedCostUsd, 0.000204, "Views do not mutate the saved original");
});

test("legacy history stays readable with unknown original usage and zero cache cost", () => {
  const legacy = insight(); delete legacy.usage;
  const cached = cachedInsight(legacy, 2);
  assert.equal(cached.usage, undefined);
  assert.equal(cached.telemetry?.estimatedCostUsd, 0);
  assert.deepEqual(parseAdvisorInsight(cached, "run"), cached);
});

test("history validation rejects corrupt token, cost, and lookup metrics", () => {
  const usage = insight().usage!;
  for (const patch of [{ inputTokens: -1 }, { outputTokens: 1.5 }, { totalTokens: 10 }, { estimatedCostUsd: Infinity },
    { inputTokens: "1000" }, { tokenSource: "unknown" }, { tokenSource: "none" }]) {
    assert.throws(() => parseAdvisorUsage({ ...usage, ...patch }));
  }
  const telemetry = withLookupTelemetry(insight(), 12).telemetry!;
  for (const patch of [{ latencyMs: -1 }, { latencyMs: NaN }, { latencyMs: "12" }, { shared: "true" }, { costSavedUsd: -1 }]) {
    assert.throws(() => parseAdvisorTelemetry({ ...telemetry, ...patch }, "gemini", usage));
  }
  assert.throws(() => parseAdvisorTelemetry(telemetry, "cached", usage));
});

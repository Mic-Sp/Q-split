import "server-only";
import { createHash } from "node:crypto";
import { parseAdvisorInsight } from "@/lib/advisor";
import { advisorDigest } from "@/lib/advisor-input";
import { validateGeneratedSections } from "@/lib/advisor-output";
import { getDatabase, withDatabaseTimeout } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import type { AdvisorInsight, AdvisorRequest, AdvisorResponse } from "@/types/advisor";
import { cachedInsight, withLookupTelemetry } from "@/lib/advisor-telemetry";

const CACHE_VERSION = "validated-advisor-v2-global";
const CACHE_TIMEOUT_MS = 1500;
// Coalesces concurrent requests within this server process, including tabs.
// Completed results live in Neon, not in an unbounded in-memory cache.
const inFlight = new Map<string, Promise<AdvisorResponse>>();

/**
 * Hash normalized current/previous telemetry, model, schema, and generation policy.
 * UUIDs, timestamps, and sessions are deliberately absent: identical analysis
 * context can share generated prose without sharing run ownership or metadata.
 */
export function advisorCacheKey(input: AdvisorRequest, model: string, policy: string): string {
  return createHash("sha256").update(JSON.stringify({
    version: CACHE_VERSION, policy, model,
    current: advisorDigest(input.current),
    previous: input.previous ? advisorDigest(input.previous) : null,
  })).digest("hex");
}

/**
 * Resolve one analysis via Neon read-through cache, coalesced generation, or fallback.
 * Revalidate saved output before reuse; database failures never prevent generation.
 * The in-process map shares generation globally. Server-generated diagnostics live
 * in AdvisorCache, independent of session-owned runs and client-supplied insights.
 * Each caller binds the result to its own UUIDs and persists with a session guard.
 * @param generate Provider-or-fallback producer with its own bounded deadline.
 * @param started Lookup start time for current telemetry, including cache wait.
 * @returns Insight plus persistence status; cache/shared followers incur no new API cost.
 */
export async function adviseWithCache(input: AdvisorRequest, model: string, policy: string,
  generate: () => Promise<AdvisorInsight>, started = performance.now(), sessionId: string | null = null): Promise<AdvisorResponse> {
  const elapsed = () => Math.round(performance.now() - started);
  const cacheKey = advisorCacheKey(input, model, policy);
  // Session ownership governs writes below, never the shared lookup or generation.
  const active = inFlight.get(cacheKey);
  const work = active ?? (async (): Promise<AdvisorResponse> => {
    let database: ReturnType<typeof getDatabase> = null;
    let persistence: AdvisorResponse["persistence"] = { status: "unconfigured", message: "Advisor history is not configured. Analysis is still available in this tab." };
    try {
      database = getDatabase();
      if (database) {
        persistence = { status: "pending" };
        const row = await withDatabaseTimeout(database.advisorCache.findUnique({
          where: { cacheKey }, select: { runId: true, advisorInsight: true },
        }), CACHE_TIMEOUT_MS);
        if (row?.advisorInsight) {
          try {
            const saved = parseAdvisorInsight(row.advisorInsight, row.runId);
            // Revalidate provenance and comparison presence; identities are rebound per caller.
            if (saved.source !== "fallback" && saved.cacheKey === cacheKey && saved.model === model &&
                (saved.previousRunId !== null) === (input.previous !== undefined)) {
              const sections = validateGeneratedSections(saved.sections);
              return { insight: cachedInsight({ ...saved, notice: null, sections }, elapsed()), persistence };
            }
          } catch { /* Invalid, outdated, or legacy output is a cache miss. */ }
        }
      }
    } catch {
      persistence = { status: "unavailable", message: "Advisor history is temporarily unavailable. Analysis still works; saving can be retried from Persistent Run History." };
    }
    const generated = await generate();
    if (generated.source !== "gemini") return { insight: withLookupTelemetry(generated, elapsed()), persistence };
    const insight = withLookupTelemetry({ ...generated, cacheKey, sections: validateGeneratedSections(generated.sections) }, elapsed());
    if (database) {
      try {
        const data = { runId: input.current.id, advisorInsight: insight as unknown as Prisma.InputJsonValue };
        await withDatabaseTimeout(database.advisorCache.upsert({ where: { cacheKey }, create: { cacheKey, ...data }, update: data }), CACHE_TIMEOUT_MS);
      } catch {
        // Cache outages must not prevent a live response or the scoped history save.
      }
    }
    return { insight, persistence };
  })();
  if (!active) inFlight.set(cacheKey, work);
  try {
    const result = await work;
    const insight = withLookupTelemetry({ ...result.insight, runId: input.current.id,
      previousRunId: input.previous?.id ?? null }, elapsed(), Boolean(active) && result.insight.source === "gemini");
    let persistence = result.persistence;
    if (insight.source !== "fallback") {
      try {
        const database = getDatabase();
        if (database) {
          // Never create a partial run or mutate another session's diagnostic.
          const saved = await withDatabaseTimeout(database.simulationRun.updateMany({
            where: { id: input.current.id, sessionId }, data: { advisorInsight: insight as unknown as Prisma.InputJsonValue },
          }), CACHE_TIMEOUT_MS);
          persistence = saved.count > 0 ? { status: "saved" } : {
            status: "pending", message: "The simulation record is still awaiting save. Its diagnostic remains available and will use the background save queue.",
          };
        }
      } catch {
        persistence = { status: "unavailable", message: "The diagnostic could not be saved to history. It is still available; retry saving from Persistent Run History." };
      }
    }
    return { insight, persistence };
  } finally { if (!active && inFlight.get(cacheKey) === work) inFlight.delete(cacheKey); }
}

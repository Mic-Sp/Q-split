import "server-only";
import { createHash } from "node:crypto";
import { parseAdvisorInsight } from "@/lib/advisor";
import { advisorDigest } from "@/lib/advisor-input";
import { validateGeneratedSections } from "@/lib/advisor-output";
import { getDatabase, withDatabaseTimeout } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import type { AdvisorInsight, AdvisorRequest, AdvisorResponse } from "@/types/advisor";
import { cachedInsight, withLookupTelemetry } from "@/lib/advisor-telemetry";

const CACHE_VERSION = "validated-advisor-v1";
const CACHE_TIMEOUT_MS = 1500;
// Coalesces concurrent requests within this server process, including tabs.
// Completed results live in Neon, not in an unbounded in-memory cache.
const inFlight = new Map<string, Promise<AdvisorResponse>>();

export function advisorCacheKey(input: AdvisorRequest, model: string, policy: string): string {
  return createHash("sha256").update(JSON.stringify({
    version: CACHE_VERSION, policy, model,
    current: { id: input.current.id, digest: advisorDigest(input.current) },
    previous: input.previous ? { id: input.previous.id, digest: advisorDigest(input.previous) } : null,
  })).digest("hex");
}

export async function adviseWithCache(input: AdvisorRequest, model: string, policy: string,
  generate: () => Promise<AdvisorInsight>, started = performance.now()): Promise<AdvisorResponse> {
  const elapsed = () => Math.round(performance.now() - started);
  const cacheKey = advisorCacheKey(input, model, policy);
  const active = inFlight.get(cacheKey);
  if (active) {
    const result = await active;
    // Sharing an in-flight generation incurs no additional API charge, but is
    // not a Neon read-through cache hit.
    return { ...result, insight: withLookupTelemetry(result.insight, elapsed(), result.insight.source === "gemini") };
  }
  const work = (async (): Promise<AdvisorResponse> => {
    let database: ReturnType<typeof getDatabase> = null;
    let persistence: AdvisorResponse["persistence"] = { status: "unconfigured", message: "Advisor history is not configured. Analysis is still available in this tab." };
    try {
      database = getDatabase();
      if (database) {
        persistence = { status: "pending" };
        const row = await withDatabaseTimeout(database.simulationRun.findUnique({
          where: { id: input.current.id }, select: { advisorInsight: true },
        }), CACHE_TIMEOUT_MS);
        if (row?.advisorInsight) {
          try {
            const saved = parseAdvisorInsight(row.advisorInsight, input.current.id);
            if (saved.source !== "fallback" && saved.cacheKey === cacheKey && saved.model === model &&
                saved.previousRunId === (input.previous?.id ?? null)) {
              const sections = validateGeneratedSections(saved.sections);
              return { insight: cachedInsight({ ...saved, notice: null, sections }, elapsed()), persistence: { status: "saved" } };
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
        // Never create a pruned simulation record here: the dashboard saves the
        // complete original telemetry. If that save is pending, its retry queue
        // attaches this insight after the simulation record is created.
        const result = await withDatabaseTimeout(database.simulationRun.updateMany({
          where: { id: input.current.id }, data: { advisorInsight: insight as unknown as Prisma.InputJsonValue },
        }), CACHE_TIMEOUT_MS);
        persistence = result.count > 0 ? { status: "saved" } : {
          status: "pending", message: "The simulation record is still awaiting save. Its diagnostic remains available and will use the background save queue.",
        };
      } catch {
        persistence = { status: "unavailable", message: "The diagnostic could not be saved to history. It is still available; retry saving from Persistent Run History." };
      }
    }
    return { insight, persistence };
  })();
  inFlight.set(cacheKey, work);
  try { return await work; }
  finally { if (inFlight.get(cacheKey) === work) inFlight.delete(cacheKey); }
}

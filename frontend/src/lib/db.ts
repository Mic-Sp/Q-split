import "server-only";
import { PrismaNeon } from "@prisma/adapter-neon";
import { PrismaClient } from "@/generated/prisma/client";

const globalDatabase = globalThis as unknown as {
  qSplitDatabase?: { url: string; client: PrismaClient; schemaVersion?: string };
};

// Invalidate the development singleton after regenerating a changed Prisma schema.
export const DATABASE_CLIENT_SCHEMA = "simulation-run-sessions-global-advisor-v3";

export const DATABASE_NOT_CONFIGURED = "Persistent history is not configured. Add your Neon DATABASE_URL to frontend/.env.local and restart the app. Simulations still work normally.";

/**
 * Lazily obtain a server-only Neon-backed Prisma client or an unconfigured null.
 * Reuse the development singleton only when connection URL and schema version match;
 * disconnect obsolete clients after configuration/client-generation changes. This
 * constructs the client and validates URL shape, not database reachability.
 */
export function getDatabase(): PrismaClient | null {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString || /YOUR_ENDPOINT|REPLACE_ME/.test(connectionString)) return null;
  try {
    const url = new URL(connectionString);
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname) return null;
  } catch {
    return null;
  }
  if (globalDatabase.qSplitDatabase?.url === connectionString && globalDatabase.qSplitDatabase.schemaVersion === DATABASE_CLIENT_SCHEMA) return globalDatabase.qSplitDatabase.client;
  if (globalDatabase.qSplitDatabase) void globalDatabase.qSplitDatabase.client.$disconnect().catch(() => {});
  const adapter = new PrismaNeon({
    connectionString,
    max: 3,
    connectionTimeoutMillis: 5_000,
    query_timeout: 5_000,
    idleTimeoutMillis: 10_000,
  });
  const client = new PrismaClient({ adapter });
  globalDatabase.qSplitDatabase = { url: connectionString, client, schemaVersion: DATABASE_CLIENT_SCHEMA };
  return client;
}

/**
 * Map known schema failures to actionable notices without exposing driver text or credentials.
 */
export function databaseNotice(error: unknown): string {
  // Never return driver error messages: they can contain connection credentials.
  if (error && typeof error === "object" && "code" in error && ["P2021", "P2022"].includes(String(error.code))) {
    return "The history database schema is not ready. Apply the prepared migration after confirming the Neon connection. Simulations are unaffected.";
  }
  return "Persistent history is temporarily unavailable. Your simulation still completed; retry saving when the database is reachable.";
}

/**
 * Bound application wait time for a database promise and always clear its timer.
 * Promise.race does not cancel the underlying operation; driver query/connection
 * timeouts remain separate safeguards, and a timed-out write may still finish.
 * @throws Error When the application deadline wins, or the original operation rejects.
 */
export async function withDatabaseTimeout<T>(operation: Promise<T>, timeoutMs = 6_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("History database timeout")), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

import "server-only";
import { PrismaNeon } from "@prisma/adapter-neon";
import { PrismaClient } from "@/generated/prisma/client";

const globalDatabase = globalThis as unknown as {
  qSplitDatabase?: { url: string; client: PrismaClient; schemaVersion?: string };
};

// Invalidate the development singleton after regenerating a changed Prisma schema.
export const DATABASE_CLIENT_SCHEMA = "simulation-run-snapshots-v2";

export const DATABASE_NOT_CONFIGURED = "Persistent history is not configured. Add your Neon DATABASE_URL to frontend/.env.local and restart the app. Simulations still work normally.";

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

export function databaseNotice(error: unknown): string {
  // Never return driver error messages: they can contain connection credentials.
  if (error && typeof error === "object" && "code" in error && ["P2021", "P2022"].includes(String(error.code))) {
    return "The history database schema is not ready. Apply the prepared migration after confirming the Neon connection. Simulations are unaffected.";
  }
  return "Persistent history is temporarily unavailable. Your simulation still completed; retry saving when the database is reachable.";
}

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

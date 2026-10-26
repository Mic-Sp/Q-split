import { loadEnvConfig } from "@next/env";
import { defineConfig } from "prisma/config";

// Prisma CLI does not load Next.js's .env.local automatically.
loadEnvConfig(process.cwd());
const url = process.env.DATABASE_URL_UNPOOLED?.trim() || process.env.DATABASE_URL?.trim();

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  // Generation works without credentials. Migration commands require a real URL.
  ...(url ? { datasource: { url } } : {}),
});

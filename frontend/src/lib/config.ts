// NEXT_PUBLIC values are inlined by Next.js when the frontend is built.
export const API_BASE_URL = (
  process.env.NEXT_PUBLIC_API_URL?.trim() || "http://localhost:8000"
).replace(/\/+$/, "");

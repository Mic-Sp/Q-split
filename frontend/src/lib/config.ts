// NEXT_PUBLIC values are inlined by Next.js when the frontend is built.
/** Legacy build-time backend fallback; the server proxy first checks runtime SIMULATION_API_URL. */
export const API_BASE_URL = (
  process.env.NEXT_PUBLIC_API_URL?.trim() || "http://localhost:8000"
).replace(/\/+$/, "");

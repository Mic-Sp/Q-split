import { engineUrl } from "@/lib/engine";

export const maxDuration = 90;

/** Wake the public engine health probe without exposing its URL or credentials. */
export async function GET(request: Request) {
  const headers = { "Cache-Control": "no-store" };
  try {
    const response = await fetch(`${engineUrl()}/`, {
      method: "GET", cache: "no-store",
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(60_000)]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return Response.json({ status: "unavailable" }, { status: 503, headers });
    }
    const body: unknown = await response.json();
    if (!body || typeof body !== "object" || !("status" in body) || body.status !== "online") {
      return Response.json({ status: "unavailable" }, { status: 503, headers });
    }
    return Response.json({ status: "online" }, { headers });
  } catch {
    return Response.json({ status: "unavailable" }, { status: 503, headers });
  }
}

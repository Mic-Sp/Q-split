import assert from "node:assert/strict";

export const SESSION_A = "a367fe2e-f083-4996-8cbd-c895d7a26b8a";
export const SESSION_B = "b367fe2e-f083-4996-8cbd-c895d7a26b8b";
export const SESSION_C = "c367fe2e-f083-4996-8cbd-c895d7a26b8c";

/** Use the real session contract in tests unrelated to session validation. */
export function apiRequest(url: string, options: RequestInit = {}): Request {
  const headers = new Headers(options.headers);
  if (!headers.has("X-Session-Id")) headers.set("X-Session-Id", SESSION_A);
  return new Request(url, { ...options, headers });
}

export function parseAdvisorPrompt(text: string) {
  const match = /^<benchmark_telemetry>\n([^]*?)\n<\/benchmark_telemetry>$/.exec(text);
  assert.ok(match, "Telemetry must be enclosed in a single XML data boundary");
  assert.ok(!/[<>]/.test(match[1]), "JSON values cannot break out of the telemetry block");
  return JSON.parse(match[1]);
}

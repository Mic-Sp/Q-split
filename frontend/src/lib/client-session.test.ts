import assert from "node:assert/strict";
import { test } from "node:test";
import { CLIENT_SESSION_STORAGE_KEY, createClientId, createSessionClient, getClientSessionId } from "./client-session";
import { isRunSessionId, readRunSession, RUN_SESSION_HEADER } from "./run-session";
import { SESSION_A, SESSION_B } from "./test-support/api";

const storage = () => {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("a browser initializes once, survives reloads, and isolates independent session stores", () => {
  const firstStore = storage(), secondStore = storage();
  const first = createSessionClient(() => ({ sessionStorage: firstStore }));
  assert.equal(firstStore.values.size, 0, "Constructing a client must not touch browser storage");
  const token = first.getSessionId();
  assert.match(token!, uuid); assert.ok(isRunSessionId(token));
  assert.equal(first.getSessionId(), token);
  assert.equal(firstStore.getItem(CLIENT_SESSION_STORAGE_KEY), token);
  const reloaded = createSessionClient(() => ({ sessionStorage: firstStore }));
  assert.equal(reloaded.getSessionId(), token);
  const second = createSessionClient(() => ({ sessionStorage: secondStore }));
  assert.notEqual(second.getSessionId(), token);
  // A queued save cannot change workspace when storage is externally edited.
  firstStore.setItem(CLIENT_SESSION_STORAGE_KEY, "changed-externally");
  assert.equal(first.getSessionId(), token);
});

test("stored tokens follow the server contract and invalid values are replaced", () => {
  for (const stored of [SESSION_A, SESSION_A.toUpperCase(), "existing_session-1", "", "a,b", "bad token", "x".repeat(129)]) {
    const saved = storage(); saved.setItem(CLIENT_SESSION_STORAGE_KEY, stored);
    const client = createSessionClient(() => ({ sessionStorage: saved }));
    const token = client.getSessionId();
    assert.ok(isRunSessionId(token));
    if (isRunSessionId(stored)) assert.equal(token, stored.toLowerCase()); else assert.notEqual(token, stored);
    assert.equal(saved.getItem(CLIENT_SESSION_STORAGE_KEY), token);
  }
});

test("session validation requires the complete UUID v4 representation and normalizes hex case", () => {
  for (const invalid of [null, undefined, 42, {}, "", "session-a", "00000000-0000-0000-0000-000000000000",
    SESSION_A.replace("-4996-", "-1996-"), SESSION_A.replace("-8cbd-", "-7cbd-"),
    SESSION_A.replaceAll("-", ""), `{${SESSION_A}}`, `urn:uuid:${SESSION_A}`, `${SESSION_A},${SESSION_B}`,
    `${SESSION_A}\n`, ` ${SESSION_A}`, `${SESSION_A}suffix`]) {
    assert.equal(isRunSessionId(invalid), false, String(invalid));
  }
  for (const valid of [SESSION_A, SESSION_A.toUpperCase(), SESSION_A.replace("-8cbd-", "-bcbd-")]) {
    assert.ok(isRunSessionId(valid));
    assert.equal(readRunSession(new Request("http://localhost/api/runs", { headers: { [RUN_SESSION_HEADER]: valid } })), valid.toLowerCase());
  }
  assert.throws(() => readRunSession(new Request("http://localhost/api/runs")), /canonical UUID v4/);
  const combined = new Headers([[RUN_SESSION_HEADER, SESSION_A], [RUN_SESSION_HEADER, SESSION_B]]);
  assert.throws(() => readRunSession(new Request("http://localhost/api/runs", { headers: combined })), /canonical UUID v4/);
});

test("blocked storage access, reads, or writes keep a stable page-local fallback", () => {
  const denied = () => { throw new Error("Storage unavailable"); };
  const browsers = [
    { get sessionStorage(): Storage { return denied(); } },
    { sessionStorage: { getItem: denied, setItem: denied } },
    { sessionStorage: { getItem: () => null, setItem: denied } },
    { sessionStorage: { getItem: () => "existing-token", setItem: denied } },
  ];
  for (const browser of browsers) {
    const client = createSessionClient(() => browser);
    const token = client.getSessionId();
    assert.ok(isRunSessionId(token)); assert.equal(client.getSessionId(), token);
  }
});

test("missing randomUUID falls back to random bytes, and missing crypto still yields valid unique run/session UUIDs", t => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto")!;
  t.after(() => Object.defineProperty(globalThis, "crypto", descriptor));
  let calls = 0;
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: {
    getRandomValues: (bytes: Uint8Array) => { calls++; bytes.fill(255); return bytes; },
  } });
  assert.equal(createClientId(), "ffffffff-ffff-4fff-bfff-ffffffffffff"); assert.equal(calls, 1);
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: undefined });
  const ids = new Set(Array.from({ length: 20 }, createClientId));
  assert.equal(ids.size, 20);
  for (const id of ids) assert.match(id, uuid);
});

test("SSR does not access storage, create a shared token, or issue an unscoped request", async t => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => { requests++; return Response.json({}); });
  const client = createSessionClient(() => null);
  assert.equal(client.getSessionId(), null); assert.equal(getClientSessionId(), null);
  await assert.rejects(client.fetch("/api/runs"), /browser session/);
  assert.equal(requests, 0);
});

test("all session API requests preserve options and share the token, including retries and the Advisor alias", async t => {
  const saved = storage(), calls: Request[] = [];
  const client = createSessionClient(() => ({ sessionStorage: saved }));
  t.mock.method(globalThis, "fetch", async (path: RequestInfo | URL, options?: RequestInit) => {
    calls.push(new Request(`http://localhost${path}`, options)); return Response.json({});
  });
  const signal = new AbortController().signal;
  const paths = [
    ["/api/runs?limit=20&workload=shors_crypto", "GET"],
    ["/api/runs", "POST"], ["/api/runs", "POST"],
    ["/api/runs/example", "PATCH"], ["/api/runs/example", "DELETE"],
    ["/api/advisor", "POST"], ["/api/analyze-telemetry", "POST"],
    ["/api/runs?limit=20&workload=quantum_mips", "GET"],
  ];
  for (const [path, method] of paths) {
    await client.fetch(path, { method, headers: new Headers({ "Content-Type": "application/json", [RUN_SESSION_HEADER]: "cannot-override-session" }),
      cache: "no-store", signal, ...(method === "POST" || method === "PATCH" ? { body: "{}" } : {}),
    });
  }
  assert.equal(calls.length, paths.length);
  for (const call of calls) {
    assert.equal(readRunSession(call), saved.getItem(CLIENT_SESSION_STORAGE_KEY));
    assert.equal(call.headers.get("Content-Type"), "application/json"); assert.equal(call.cache, "no-store");
    assert.equal(call.signal.aborted, false);
    if (call.method === "POST" || call.method === "PATCH") assert.equal(await call.text(), "{}");
  }
});

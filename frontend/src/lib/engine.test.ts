import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { engineHeaders, prewarmEngine } from "./engine";
import { POST } from "@/app/api/simulate/route";
import { register } from "../instrumentation";
import { GET as health } from "@/app/api/health/route";

function setEnv(t: TestContext, name: string, value: string) {
  const previous = process.env[name];
  process.env[name] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

test("simulation proxy attaches only its configured server credential", async t => {
  setEnv(t, "SIMULATION_API_URL", "http://engine.internal///");
  setEnv(t, "ENGINE_SECRET", " server-secret ");
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, "http://engine.internal/api/simulate");
    assert.equal(new Headers(init.headers).get("X-Engine-Secret"), "server-secret");
    assert.equal(new Headers(init.headers).get("Content-Type"), "application/json");
    return Response.json({ detail: "Invalid engine credentials." }, { status: 401 });
  });
  const response = await POST(new Request("http://localhost/api/simulate", {
    method: "POST", headers: { "X-Engine-Secret": "browser-controlled" },
    body: JSON.stringify({ workload_id: "shors_crypto", scale_param: 21, hardware_profile: "ideal_sim", available_qubits: 133 }),
  }));
  assert.equal(response.status, 401);
  assert.doesNotMatch(await response.text(), /server-secret|browser-controlled/);
});

test("blank secrets leave local proxy requests unauthenticated", t => {
  setEnv(t, "ENGINE_SECRET", "   ");
  assert.deepEqual(engineHeaders(), {});
});

test("Node server startup pre-warms the public health route without credentials", async t => {
  setEnv(t, "NEXT_RUNTIME", "nodejs");
  setEnv(t, "SIMULATION_API_URL", "http://engine.internal/");
  setEnv(t, "ENGINE_SECRET", "server-secret");
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    calls++;
    assert.equal(url, "http://engine.internal/");
    assert.equal(init.cache, "no-store");
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(new Headers(init.headers).get("X-Engine-Secret"), null);
    return Response.json({ status: "online" });
  });
  await register();
  assert.equal(calls, 1);
  process.env.NEXT_RUNTIME = "edge";
  await register();
  assert.equal(calls, 1);
});

test("pre-warm handles offline engines, non-2xx responses, and timeout", async t => {
  t.mock.method(globalThis, "fetch", async () => { throw new TypeError("offline"); });
  assert.equal(await prewarmEngine(), false);
  t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 503 }));
  assert.equal(await prewarmEngine(), false);
  t.mock.method(AbortSignal, "timeout", (milliseconds: number) => {
    assert.equal(milliseconds, 3_000);
    return AbortSignal.abort(new DOMException("Timed out", "TimeoutError"));
  });
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    init.signal?.throwIfAborted();
    throw new Error("Expected a timeout");
  });
  assert.equal(await prewarmEngine(), false);
});

test("page-load health proxy is uncached, public, and returns only normalized health", async t => {
  setEnv(t, "SIMULATION_API_URL", "http://engine.internal///");
  setEnv(t, "ENGINE_SECRET", "server-secret");
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, "http://engine.internal/");
    assert.equal(init.method, "GET");
    assert.equal(init.cache, "no-store");
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(new Headers(init.headers).get("X-Engine-Secret"), null);
    return Response.json({ status: "online", engine: "private deployment details" });
  });
  const response = await health(new Request("http://localhost/api/health", { headers: { "X-Engine-Secret": "browser-controlled" } }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await response.json(), { status: "online" });
});

test("health proxy handles offline, rejected, and malformed engine responses without leaking details", async t => {
  for (const upstream of [
    async () => { throw new Error("private engine connection details"); },
    async () => new Response("private upstream details", { status: 503 }),
    async () => new Response("<html>Service starting</html>"),
    async () => Response.json({ status: "starting" }),
  ]) {
    t.mock.method(globalThis, "fetch", upstream);
    const response = await health(new Request("http://localhost/api/health"));
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.deepEqual(await response.json(), { status: "unavailable" });
  }
});

test("health proxy bounds cold-start waiting and propagates caller cancellation", async t => {
  const caller = new AbortController();
  t.mock.method(AbortSignal, "timeout", (milliseconds: number) => {
    assert.equal(milliseconds, 60_000);
    return new AbortController().signal;
  });
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    assert.equal(init.signal?.aborted, false);
    caller.abort();
    assert.equal(init.signal?.aborted, true);
    init.signal?.throwIfAborted();
    throw new Error("Expected cancellation");
  });
  assert.equal((await health(new Request("http://localhost/api/health", { signal: caller.signal }))).status, 503);
  t.mock.method(AbortSignal, "timeout", () => AbortSignal.abort(new DOMException("Timed out", "TimeoutError")));
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    init.signal?.throwIfAborted();
    throw new Error("Expected timeout");
  });
  assert.equal((await health(new Request("http://localhost/api/health"))).status, 503);
});

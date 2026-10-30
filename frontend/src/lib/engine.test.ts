import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { engineHeaders, prewarmEngine } from "./engine";
import { POST } from "@/app/api/simulate/route";
import { register } from "../instrumentation";

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

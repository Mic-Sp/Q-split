import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { AdvisorRateLimiter, ADVISOR_RATE_WINDOW_MS, readTrustedClientIp } from "./advisor-rate-limit";

function controlled(t: TestContext, maxKeys?: number) {
  let now = 0;
  const limiter = new AdvisorRateLimiter(() => now, maxKeys);
  t.after(() => limiter.dispose());
  return { limiter, at: (time: number) => { now = time; } };
}

test("session window permits five attempts across IPs and slides at the exact 60-second boundary", t => {
  const { limiter, at } = controlled(t);
  for (let index = 0; index < 5; index++) {
    at(index * 10_000);
    assert.deepEqual(limiter.consume("session-a", `192.0.2.${index + 1}`), { allowed: true });
  }
  at(59_999);
  assert.deepEqual(limiter.consume("session-a", "192.0.2.20"), { allowed: false, retryAfterSeconds: 1 });
  at(60_000);
  assert.deepEqual(limiter.consume("session-a", "192.0.2.20"), { allowed: true });
  at(60_001);
  assert.deepEqual(limiter.consume("session-a", "192.0.2.21"), { allowed: false, retryAfterSeconds: 10 });
});

test("IP window permits eight attempts across sessions, independently of other IPs", t => {
  const { limiter, at } = controlled(t);
  for (let index = 0; index < 8; index++) assert.equal(limiter.consume(`session-${index}`, "192.0.2.1").allowed, true);
  assert.deepEqual(limiter.consume("ninth-session", "192.0.2.1"), { allowed: false, retryAfterSeconds: 60 });
  assert.equal(limiter.consume("ninth-session", "192.0.2.2").allowed, true);
  at(ADVISOR_RATE_WINDOW_MS);
  assert.equal(limiter.consume("ninth-session", "192.0.2.1").allowed, true);
});

test("a rejection by either quota never consumes the other quota", t => {
  const { limiter } = controlled(t);
  for (let index = 0; index < 5; index++) assert.equal(limiter.consume("full-session", `192.0.2.${index + 1}`).allowed, true);
  for (let index = 0; index < 10; index++) assert.equal(limiter.consume("full-session", "198.51.100.1").allowed, false);
  for (let index = 0; index < 8; index++) assert.equal(limiter.consume(`ip-session-${index}`, "198.51.100.1").allowed, true);
  for (let index = 0; index < 10; index++) assert.equal(limiter.consume("untouched-session", "198.51.100.1").allowed, false);
  for (let index = 0; index < 5; index++) assert.equal(limiter.consume("untouched-session", "198.51.100.2").allowed, true);
});

test("cooldown waits until both full windows permit another attempt", t => {
  const { limiter, at } = controlled(t);
  for (let index = 0; index < 8; index++) limiter.consume(`session-${index}`, "192.0.2.1");
  at(20_000);
  for (let index = 0; index < 5; index++) limiter.consume("later-session", `198.51.100.${index + 1}`);
  assert.deepEqual(limiter.consume("later-session", "192.0.2.1"), { allowed: false, retryAfterSeconds: 60 });
  at(60_000);
  assert.deepEqual(limiter.consume("later-session", "192.0.2.1"), { allowed: false, retryAfterSeconds: 20 });
  at(80_000);
  assert.equal(limiter.consume("later-session", "192.0.2.1").allowed, true);
});

test("missing session and IP identities use shared quotas rather than bypassing limits", t => {
  const { limiter } = controlled(t);
  for (let index = 0; index < 5; index++) assert.equal(limiter.consume(null, `192.0.2.${index + 1}`).allowed, true);
  assert.equal(limiter.consume(null, "192.0.2.20").allowed, false);
  for (let index = 0; index < 8; index++) assert.equal(limiter.consume(`session-${index}`, null).allowed, true);
  assert.equal(limiter.consume("new-session", null).allowed, false);
});

test("automatic sweeps remove expired idle entries, and active quotas survive the memory cap", t => {
  let sweep!: () => void;
  const original = globalThis.setInterval;
  t.mock.method(globalThis, "setInterval", (callback: () => void, delay: number) => {
    assert.equal(delay, ADVISOR_RATE_WINDOW_MS);
    sweep = callback;
    return original(callback, delay);
  });
  const { limiter, at } = controlled(t, 4);
  assert.equal(limiter.consume("session-a", "192.0.2.1").allowed, true);
  assert.equal(limiter.consume("session-b", "192.0.2.2").allowed, true);
  assert.equal(limiter.size, 4);
  assert.equal(limiter.consume("new-session", "192.0.2.3").allowed, false);
  assert.equal(limiter.size, 4);
  for (let index = 0; index < 4; index++) assert.equal(limiter.consume("session-a", "192.0.2.1").allowed, true);
  assert.equal(limiter.consume("session-a", "192.0.2.1").allowed, false, "Capacity pressure cannot evict an existing quota");
  at(ADVISOR_RATE_WINDOW_MS);
  sweep();
  assert.equal(limiter.size, 0, "Idle keys expire even when they are never requested again");
  assert.equal(limiter.consume("new-session", "192.0.2.3").allowed, true);
});

test("only trusted Vercel headers identify clients, with canonical IPv6/mapped-IPv4 keys", t => {
  const original = process.env.VERCEL;
  t.after(() => { if (original === undefined) delete process.env.VERCEL; else process.env.VERCEL = original; });
  const headers = new Headers({ "x-vercel-forwarded-for": "192.0.2.1", "x-real-ip": "192.0.2.2", "x-forwarded-for": "192.0.2.3", "x-vercel-id": "client-spoofed" });
  delete process.env.VERCEL;
  assert.equal(readTrustedClientIp(headers), null, "Client-supplied platform markers do not establish trust");
  process.env.VERCEL = "1";
  assert.equal(readTrustedClientIp(headers), "192.0.2.1");
  headers.delete("x-vercel-forwarded-for");
  assert.equal(readTrustedClientIp(headers), "192.0.2.2");
  headers.delete("x-real-ip");
  assert.equal(readTrustedClientIp(headers), null, "Generic forwarding chains are not authoritative");
  for (const invalid of ["unknown", "192.0.2.1, 192.0.2.2", "192.0.2.1:443", "[2001:db8::1]", "fe80::1%eth0"]) {
    headers.set("x-vercel-forwarded-for", invalid);
    headers.set("x-real-ip", "192.0.2.2");
    assert.equal(readTrustedClientIp(headers), null);
  }
  headers.set("x-vercel-forwarded-for", "2001:0DB8:0000:0000:0000:0000:0000:0001");
  assert.equal(readTrustedClientIp(headers), "2001:db8::1");
  for (const mapped of ["::ffff:192.0.2.1", "::FFFF:c000:0201"]) {
    headers.set("x-vercel-forwarded-for", mapped);
    assert.equal(readTrustedClientIp(headers), "192.0.2.1");
  }
});

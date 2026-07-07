import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeConfig } from "./types";
import { createHandler } from "./http";
import { isLoopbackPeer } from "./lib/origin-trust";

// Regression guard for the non-loopback-bind trust boundary (GINI_BIND_HOST=
// 0.0.0.0, the Docker/Xvfb deployment). When the gateway binds a non-loopback
// interface, a remote peer can open the socket AND forge `Host: localhost`.
// Loopback-operator trust must therefore key on the REAL socket peer
// (server.requestIP, threaded into createHandler's handler as the 2nd arg), not
// the forgeable Host header. These tests pin that a forged loopback Host from a
// non-loopback peer gets NO loopback bypass. See ADR docker-xvfb-deployment.md
// and ADR owner-token-auth.md.

let root = "";
function testConfig(instance: string): RuntimeConfig {
  root = mkdtempSync(join(tmpdir(), `gini-nlb-${instance}-`));
  process.env.GINI_STATE_ROOT = root;
  process.env.GINI_LOG_ROOT = `${root}-logs`;
  return {
    instance,
    port: 7337,
    token: "test-token",
    provider: { name: "echo", model: "gini-echo-v0" },
    workspaceRoot: "/tmp",
    stateRoot: `${root}/instances/${instance}`,
    logRoot: `${root}-logs/${instance}`,
    approvalMode: "strict"
  };
}

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  if (root) rmSync(`${root}-logs`, { recursive: true, force: true });
  delete process.env.GINI_STATE_ROOT;
  delete process.env.GINI_LOG_ROOT;
});

// The Docker bridge gateway address an external peer presents after NAT.
const EXTERNAL_PEER = "172.29.0.1";

describe("isLoopbackPeer", () => {
  test("treats null/undefined/empty as loopback (loopback-bind / in-process default)", () => {
    expect(isLoopbackPeer(null)).toBe(true);
    expect(isLoopbackPeer(undefined)).toBe(true);
    expect(isLoopbackPeer("")).toBe(true);
  });
  test("accepts IPv4 loopback, ::1, and IPv4-mapped loopback", () => {
    expect(isLoopbackPeer("127.0.0.1")).toBe(true);
    expect(isLoopbackPeer("127.0.0.5")).toBe(true);
    expect(isLoopbackPeer("::1")).toBe(true);
    expect(isLoopbackPeer("::ffff:127.0.0.1")).toBe(true);
  });
  test("rejects a non-loopback peer (Docker bridge, LAN, public)", () => {
    expect(isLoopbackPeer(EXTERNAL_PEER)).toBe(false);
    expect(isLoopbackPeer("192.168.1.50")).toBe(false);
    expect(isLoopbackPeer("10.0.0.4")).toBe(false);
    expect(isLoopbackPeer("203.0.113.7")).toBe(false);
    expect(isLoopbackPeer("::ffff:172.29.0.1")).toBe(false);
  });
});

describe("createHandler — forged Host: localhost from an external peer", () => {
  test("a web-bound page request with forged loopback Host + external peer is refused (404), not served", async () => {
    const config = testConfig("nlb-page");
    const handler = createHandler(config);
    // Forged loopback Host; peer is the Docker bridge.
    const res = await handler(
      new Request("http://127.0.0.1:7337/chat", { headers: { host: "localhost" } }),
      EXTERNAL_PEER
    );
    expect(res.status).toBe(404);
  });

  test("a forged-loopback BFF call from an external peer is refused (401), not admitted as loopback", async () => {
    const config = testConfig("nlb-bff");
    const handler = createHandler(config);
    const res = await handler(
      new Request("http://127.0.0.1:7337/api/runtime/status", { headers: { host: "localhost" } }),
      EXTERNAL_PEER
    );
    // The loopback-Host lane requires a genuine loopback peer; the BFF
    // namespace gets a 401 rather than being proxied under the owner bearer.
    expect(res.status).toBe(401);
  });

  test("the SAME request from a genuine loopback peer is admitted (proves we didn't break local use)", async () => {
    const config = testConfig("nlb-local");
    const handler = createHandler(config);
    const res = await handler(
      new Request("http://127.0.0.1:7337/api/runtime/status", { headers: { host: "localhost" } }),
      "127.0.0.1"
    );
    // Loopback peer + loopback Host = trusted local: the gates do NOT fire, so
    // we get past them to the proxy (502 because no web child is running in the
    // test, NOT a 401/403 auth refusal — that's the point).
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  test("owner-only bearer: a gini_device_-shaped token is 401 on the native /api surface", async () => {
    const config = testConfig("nlb-device-bearer");
    const handler = createHandler(config);
    const res = await handler(
      new Request("http://127.0.0.1:7337/api/agents", {
        headers: { authorization: "Bearer gini_device_00000000-0000-0000-0000-000000000000" }
      }),
      "127.0.0.1"
    );
    expect(res.status).toBe(401);
    // The real owner token still authorizes.
    const ok = await handler(
      new Request("http://127.0.0.1:7337/api/agents", {
        headers: { authorization: "Bearer test-token" }
      }),
      "127.0.0.1"
    );
    expect(ok.status).toBe(200);
  });
});

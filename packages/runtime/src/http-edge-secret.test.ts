import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeConfig } from "./types";
import { createHandler, edgeTrustedRequest } from "./http";

// The trusted-front seam (GINI_EDGE_SECRET). A hosted "edge" reverse proxy in
// front of the gateway carries a shared secret in the X-Gini-Edge header; a
// request that presents it is owner/operator-equivalent — it rides the same
// bypass the local loopback operator does. Two grants:
//   (a) web/document requests skip the forged-loopback-Host peer denial, and
//   (b) /api/* requests resolve the credential as "owner" (like config.token).
// Default OFF: with GINI_EDGE_SECRET unset/empty the header is never honored and
// every trust decision is byte-for-byte the pre-edge behavior. These tests reuse
// the forged-`Host: localhost` + external-peer construction from
// http-nonloopback-bind.test.ts so the edge bypass is isolated from — and pinned
// against — the peer-based loopback denial.

let root = "";
function testConfig(instance: string): RuntimeConfig {
  root = mkdtempSync(join(tmpdir(), `gini-edge-${instance}-`));
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
  delete process.env.GINI_EDGE_SECRET;
});

// The Docker bridge gateway address an external (non-loopback) peer presents.
const EXTERNAL_PEER = "172.29.0.1";
const SECRET = "s3cr3t-edge-token";

describe("edgeTrustedRequest", () => {
  test("is false when GINI_EDGE_SECRET is unset (default off), even with a header", () => {
    delete process.env.GINI_EDGE_SECRET;
    const req = new Request("http://127.0.0.1:7337/api/state", { headers: { "x-gini-edge": "anything" } });
    expect(edgeTrustedRequest(req)).toBe(false);
  });
  test("is false when GINI_EDGE_SECRET is empty (empty is never a valid secret)", () => {
    process.env.GINI_EDGE_SECRET = "";
    const req = new Request("http://127.0.0.1:7337/api/state", { headers: { "x-gini-edge": "" } });
    expect(edgeTrustedRequest(req)).toBe(false);
  });
  test("is false with the secret set but the header absent or wrong", () => {
    process.env.GINI_EDGE_SECRET = SECRET;
    expect(edgeTrustedRequest(new Request("http://127.0.0.1:7337/api/state"))).toBe(false);
    expect(
      edgeTrustedRequest(new Request("http://127.0.0.1:7337/api/state", { headers: { "x-gini-edge": "wrong" } }))
    ).toBe(false);
    // An empty header must not match a non-empty secret either.
    expect(
      edgeTrustedRequest(new Request("http://127.0.0.1:7337/api/state", { headers: { "x-gini-edge": "" } }))
    ).toBe(false);
  });
  test("is true only when the secret is set and the header equals it exactly", () => {
    process.env.GINI_EDGE_SECRET = SECRET;
    expect(
      edgeTrustedRequest(new Request("http://127.0.0.1:7337/api/state", { headers: { "x-gini-edge": SECRET } }))
    ).toBe(true);
  });
});

describe("createHandler — X-Gini-Edge from an external peer", () => {
  test("with the secret set, the correct header lets a web page nav through the forged-loopback denial", async () => {
    process.env.GINI_EDGE_SECRET = SECRET;
    const config = testConfig("edge-page-ok");
    const handler = createHandler(config);
    const res = await handler(
      new Request("http://127.0.0.1:7337/chat", { headers: { host: "localhost", "x-gini-edge": SECRET } }),
      EXTERNAL_PEER
    );
    // The forged-loopback peer denial did NOT fire. It falls through to the
    // proxy, which 502s because no web child runs in the test — the point is it
    // is NOT the 404 an untrusted forged-Host nav would get.
    expect(res.status).not.toBe(404);
    expect(res.status).not.toBe(401);
  });

  test("with the secret set, the correct header makes an /api/* call resolve as owner (200, not 401)", async () => {
    process.env.GINI_EDGE_SECRET = SECRET;
    const config = testConfig("edge-api-ok");
    const handler = createHandler(config);
    // No bearer at all — only the edge header — must still be owner-admitted.
    const res = await handler(
      new Request("http://127.0.0.1:7337/api/state", { headers: { host: "localhost", "x-gini-edge": SECRET } }),
      EXTERNAL_PEER
    );
    expect(res.status).toBe(200);
  });

  test("with the secret set, a per-route credential lookup resolves the edge as owner (no 401)", async () => {
    process.env.GINI_EDGE_SECRET = SECRET;
    const config = testConfig("edge-credential");
    const handler = createHandler(config);
    // POST /api/push/devices resolves the credential via bearerFromRequest ->
    // resolveCredentialFromBearer. With only the edge header (no bearer) the
    // lookup must yield "owner" (config.token), so the route runs the
    // owner-scoped upsert instead of the null-credential 401.
    const res = await handler(
      new Request("http://127.0.0.1:7337/api/push/devices", {
        method: "POST",
        headers: { host: "localhost", "x-gini-edge": SECRET, "content-type": "application/json" },
        body: JSON.stringify({ token: "apns-tok", platform: "ios", bundleId: "ai.lilaclabs.gini" })
      }),
      EXTERNAL_PEER
    );
    expect(res.status).not.toBe(401);
    const payload = (await res.json()) as { ok?: boolean; device?: { credentialId?: string } };
    expect(payload.ok).toBe(true);
    // Scoped to the owner credential — identical to a real config.token bearer.
    expect(payload.device?.credentialId).toBe("owner");
  });

  test("with the secret UNSET, the same per-route call with the header is a 401 (edge ignored)", async () => {
    delete process.env.GINI_EDGE_SECRET;
    const config = testConfig("edge-credential-off");
    const handler = createHandler(config);
    const res = await handler(
      new Request("http://127.0.0.1:7337/api/push/devices", {
        method: "POST",
        headers: { host: "localhost", "x-gini-edge": SECRET, "content-type": "application/json" },
        body: JSON.stringify({ token: "apns-tok", platform: "ios", bundleId: "ai.lilaclabs.gini" })
      }),
      EXTERNAL_PEER
    );
    expect(res.status).toBe(401);
  });

  test("with the secret set, a WRONG header is refused exactly as today (page 404, api 401)", async () => {
    process.env.GINI_EDGE_SECRET = SECRET;
    const config = testConfig("edge-wrong");
    const handler = createHandler(config);
    const page = await handler(
      new Request("http://127.0.0.1:7337/chat", { headers: { host: "localhost", "x-gini-edge": "nope" } }),
      EXTERNAL_PEER
    );
    expect(page.status).toBe(404);
    const api = await handler(
      new Request("http://127.0.0.1:7337/api/state", { headers: { host: "localhost", "x-gini-edge": "nope" } }),
      EXTERNAL_PEER
    );
    expect(api.status).toBe(401);
  });

  test("with the secret set, an ABSENT header is refused exactly as today (page 404, api 401)", async () => {
    process.env.GINI_EDGE_SECRET = SECRET;
    const config = testConfig("edge-absent");
    const handler = createHandler(config);
    const page = await handler(
      new Request("http://127.0.0.1:7337/chat", { headers: { host: "localhost" } }),
      EXTERNAL_PEER
    );
    expect(page.status).toBe(404);
    const api = await handler(
      new Request("http://127.0.0.1:7337/api/state", { headers: { host: "localhost" } }),
      EXTERNAL_PEER
    );
    expect(api.status).toBe(401);
  });

  test("with the secret UNSET, the header is ignored — refused exactly as today (page 404, api 401)", async () => {
    delete process.env.GINI_EDGE_SECRET;
    const config = testConfig("edge-off");
    const handler = createHandler(config);
    const page = await handler(
      new Request("http://127.0.0.1:7337/chat", { headers: { host: "localhost", "x-gini-edge": SECRET } }),
      EXTERNAL_PEER
    );
    expect(page.status).toBe(404);
    const api = await handler(
      new Request("http://127.0.0.1:7337/api/state", { headers: { host: "localhost", "x-gini-edge": SECRET } }),
      EXTERNAL_PEER
    );
    expect(api.status).toBe(401);
  });
});

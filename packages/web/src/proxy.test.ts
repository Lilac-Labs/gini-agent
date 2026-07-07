// Proxy unit tests. Exercise the Host-classifier lanes (loopback / trusted /
// unknown) and the loopback-only setup gate by driving proxy() with a
// synthetic NextRequest.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { proxy } from "./proxy";

const originalTrusted = process.env.GINI_TRUSTED_ORIGINS;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  delete process.env.GINI_TRUSTED_ORIGINS;
});

afterEach(() => {
  if (originalTrusted === undefined) delete process.env.GINI_TRUSTED_ORIGINS;
  else process.env.GINI_TRUSTED_ORIGINS = originalTrusted;
  globalThis.fetch = originalFetch;
});

function makeRequest(opts: { url: string; host: string; method?: string; secFetchDest?: string; accept?: string }): NextRequest {
  const headers: Record<string, string> = { host: opts.host };
  if (opts.secFetchDest) headers["sec-fetch-dest"] = opts.secFetchDest;
  if (opts.accept) headers["accept"] = opts.accept;
  return new NextRequest(opts.url, {
    method: opts.method ?? "GET",
    headers
  });
}

// Stub the provider-status probe the loopback setup gate calls.
function stubSetupStatus(providerConfigured: boolean): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ providerConfigured }), {
      status: 200,
      headers: { "content-type": "application/json" }
    })) as unknown as typeof fetch;
}

function failIfFetched(reason: string): void {
  globalThis.fetch = (async () => {
    throw new Error(reason);
  }) as unknown as typeof fetch;
}

describe("proxy Host classifier", () => {
  test("unknown Host → 404", async () => {
    const res = await proxy(makeRequest({ url: "https://evil.example/", host: "evil.example" }));
    expect(res.status).toBe(404);
  });

  test("relay-subdomain Host → 404 (BFF is relay-agnostic; the gateway fronts the tunnel)", async () => {
    const res = await proxy(makeRequest({ url: "https://g31.gini-relay.lilaclabs.ai/", host: "g31.gini-relay.lilaclabs.ai" }));
    expect(res.status).toBe(404);
  });

  test("trusted Host (GINI_TRUSTED_ORIGINS) passes through without the setup gate", async () => {
    process.env.GINI_TRUSTED_ORIGINS = "https://gini.example";
    // A trusted-lane request must NOT hit the loopback-only setup probe.
    failIfFetched("setup status must not be probed on the trusted lane");
    const res = await proxy(makeRequest({ url: "https://gini.example/chat", host: "gini.example" }));
    expect(res.status).toBe(200);
  });
});

describe("proxy loopback setup gate", () => {
  test("loopback + /api/* skips the setup gate", async () => {
    failIfFetched("setup status must not be probed for /api/* paths");
    const res = await proxy(makeRequest({ url: "http://localhost/api/runtime/chat", host: "localhost" }));
    expect(res.status).toBe(200);
  });

  test("every pass-through response carries the anti-framing headers", async () => {
    failIfFetched("setup status must not be probed for /api/* paths");
    const res = await proxy(makeRequest({ url: "http://localhost/api/runtime/chat", host: "localhost" }));
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });

  test("loopback + /setup is not redirected (avoids a redirect loop)", async () => {
    stubSetupStatus(false);
    const res = await proxy(makeRequest({ url: "http://localhost/setup", host: "localhost", secFetchDest: "document" }));
    expect(res.status).toBe(200);
  });

  test("loopback + unconfigured provider → redirect to /setup (top-level navigation)", async () => {
    stubSetupStatus(false);
    const res = await proxy(makeRequest({ url: "http://localhost/chat", host: "localhost", secFetchDest: "document" }));
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    expect(res.headers.get("location")).toContain("/setup");
  });

  test("loopback + static asset is NOT redirected to /setup even when unconfigured", async () => {
    // Regression: a static image (Sec-Fetch-Dest=image) must be served, not
    // 307'd to /setup. The setup gate only redirects top-level page navigations,
    // and must not even probe the provider for an asset request.
    failIfFetched("setup status must not be probed for asset requests");
    const res = await proxy(makeRequest({ url: "http://localhost/gini-agent-logo.png", host: "localhost", secFetchDest: "image" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });

  test("loopback + configured provider → pass (no redirect)", async () => {
    stubSetupStatus(true);
    const res = await proxy(makeRequest({ url: "http://localhost/chat", host: "localhost", secFetchDest: "document" }));
    expect(res.status).toBe(200);
  });
});

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

// Stub the setup-status probe the loopback setup gate calls. `managed`
// mirrors the runtime's managed-deployment flag (ADR
// managed-deployment-mode.md); omitting it exercises the pre-managed payload
// shape, which the gate must read as self-hosted. The same payload also
// answers the follow-up /api/onboarding probe — it carries no `completed`
// field, which the gate must read as "not definitively incomplete" and keep
// the /setup bounce (the pre-onboarding behavior these tests pin).
function stubSetupStatus(providerConfigured: boolean, managed?: boolean): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(managed === undefined ? { providerConfigured } : { providerConfigured, managed }), {
      status: 200,
      headers: { "content-type": "application/json" }
    })) as unknown as typeof fetch;
}

// URL-routing stub for the gate's two probes: /api/setup/status answers
// self-hosted with the given configured flag; /api/onboarding answers the
// given completion state ("error" → 500, exercising the failed-probe
// default). Returns a counter of onboarding probes, so a test can pin that
// the second probe is never made on a path that doesn't need it.
function stubGateProbes(
  providerConfigured: boolean,
  onboardingCompleted: boolean | "error"
): { onboardingProbes: number } {
  const calls = { onboardingProbes: 0 };
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/api/setup/status")) {
      return new Response(JSON.stringify({ providerConfigured, managed: false }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (url.endsWith("/api/onboarding")) {
      calls.onboardingProbes += 1;
      if (onboardingCompleted === "error") return new Response("boom", { status: 500 });
      return new Response(JSON.stringify({ completed: onboardingCompleted }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    throw new Error(`unexpected probe: ${url}`);
  }) as unknown as typeof fetch;
  return calls;
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

  test("managed deployment: no /setup redirect even while unconfigured", async () => {
    // A managed (platform-hosted) runtime provisions its own provider, so the
    // gate must never bounce it to /setup — even if the status probe reports
    // providerConfigured false. See ADR managed-deployment-mode.md.
    stubSetupStatus(false, true);
    const res = await proxy(makeRequest({ url: "http://localhost/chat", host: "localhost", secFetchDest: "document" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });

  test("managed false in the payload keeps the unconfigured redirect", async () => {
    stubSetupStatus(false, false);
    const res = await proxy(makeRequest({ url: "http://localhost/chat", host: "localhost", secFetchDest: "document" }));
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    expect(res.headers.get("location")).toContain("/setup");
  });

  test("unconfigured + incomplete onboarding passes through — the wizard owns first-run provider setup", async () => {
    // A fresh instance must reach /onboarding (whose capability-derived
    // provider step replaces the /setup detour — ADR web-onboarding-flow.md);
    // the client-side OnboardingGate routes it there.
    stubGateProbes(false, false);
    const res = await proxy(makeRequest({ url: "http://localhost/", host: "localhost", secFetchDest: "document" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });

  test("unconfigured + completed onboarding still bounces to /setup", async () => {
    // e.g. a grandfathered or skipped-provider instance: /setup stays the
    // standing surface for an operator whose provider is missing.
    stubGateProbes(false, true);
    const res = await proxy(makeRequest({ url: "http://localhost/chat", host: "localhost", secFetchDest: "document" }));
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    expect(res.headers.get("location")).toContain("/setup");
  });

  test("a failed onboarding probe keeps the /setup bounce (pre-onboarding default)", async () => {
    stubGateProbes(false, "error");
    const res = await proxy(makeRequest({ url: "http://localhost/chat", host: "localhost", secFetchDest: "document" }));
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    expect(res.headers.get("location")).toContain("/setup");
  });

  test("configured provider never probes onboarding", async () => {
    // The onboarding probe exists only to spare an incomplete funnel from
    // the /setup bounce; the configured path must stay a single probe.
    const calls = stubGateProbes(true, false);
    const res = await proxy(makeRequest({ url: "http://localhost/chat", host: "localhost", secFetchDest: "document" }));
    expect(res.status).toBe(200);
    expect(calls.onboardingProbes).toBe(0);
  });
});

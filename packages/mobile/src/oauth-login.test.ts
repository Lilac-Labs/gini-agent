import { describe, expect, test } from "bun:test";

// EDGE_BASE_URL is read from the environment at module-load time (the app
// build inlines EXPO_PUBLIC_* via babel-preset-expo), so the fixture env is
// set BEFORE the module is imported and every expectation derives from it.
const EDGE = "https://edge.example.com";
process.env.EXPO_PUBLIC_EDGE_BASE_URL = EDGE;

const { buildMobileAuthUrl, EDGE_BASE_URL, parseOauthRedirect, revokeEdgeSession } =
  await import("./oauth-login");

describe("EDGE_BASE_URL", () => {
  test("reflects the build-time env", () => {
    expect(EDGE_BASE_URL).toBe(EDGE);
  });
});

describe("buildMobileAuthUrl", () => {
  test("appends the mobile-mode Google auth path to the edge origin", () => {
    expect(buildMobileAuthUrl(EDGE)).toBe(`${EDGE}/auth/google?mode=mobile`);
  });

  test("trims a trailing slash so the path isn't doubled", () => {
    expect(buildMobileAuthUrl(`${EDGE}/`)).toBe(`${EDGE}/auth/google?mode=mobile`);
  });
});

describe("parseOauthRedirect", () => {
  test("extracts the token from the gini:// redirect", () => {
    expect(parseOauthRedirect("gini://auth?token=abc123")).toBe("abc123");
  });

  test("extracts the token alongside other params", () => {
    expect(parseOauthRedirect("gini://auth?foo=1&token=xyz&bar=2")).toBe("xyz");
  });

  test("returns null for a foreign scheme (can't be hijacked to another app)", () => {
    expect(parseOauthRedirect("https://evil.example.com/?token=stolen")).toBeNull();
    expect(parseOauthRedirect("exp://127.0.0.1?token=x")).toBeNull();
  });

  test("returns null when there is no query string", () => {
    expect(parseOauthRedirect("gini://auth")).toBeNull();
  });

  test("returns null for a missing or blank token", () => {
    expect(parseOauthRedirect("gini://auth?state=1")).toBeNull();
    expect(parseOauthRedirect("gini://auth?token=")).toBeNull();
  });
});

describe("revokeEdgeSession", () => {
  test("POSTs the bearer to /auth/mobile/logout (trailing slash trimmed)", async () => {
    let seen: { url: string; method: string; auth: string } | null = null;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seen = {
        url: String(url),
        method: init?.method ?? "GET",
        auth: headers.get("authorization") ?? ""
      };
      return new Response(JSON.stringify({ ok: true }));
    }) as unknown as typeof fetch;
    await revokeEdgeSession({ baseUrl: `${EDGE}/`, token: "tok-1" }, fetchImpl);
    expect(seen!.url).toBe(`${EDGE}/auth/mobile/logout`);
    expect(seen!.method).toBe("POST");
    expect(seen!.auth).toBe("Bearer tok-1");
  });

  test("no-ops on null credentials", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response("{}");
    }) as unknown as typeof fetch;
    await revokeEdgeSession(null, fetchImpl);
    expect(called).toBe(false);
  });

  test("swallows a network failure so local sign-out always proceeds", async () => {
    const fetchImpl = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    await expect(
      revokeEdgeSession({ baseUrl: EDGE, token: "t" }, fetchImpl)
    ).resolves.toBeUndefined();
  });
});

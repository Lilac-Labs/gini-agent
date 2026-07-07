// Tests for the runtime-owned same-tab Google login (loopback web OAuth).
//
// The Google HTTP boundary is stubbed via setGoogleLoginWebFetchForTests so
// no test ever touches the network; HOME points at a scratch dir so the
// provisioned registry/credentials land in a throwaway ~/.gini.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RuntimeConfig } from "../../types";
import { readGoogleAccounts, readPrimaryGoogleAccountId } from "../../state/google-accounts";
import { RELAY_WORKSPACE_CLIENT } from "./relay-workspace-client";
import {
  DEFAULT_LOGIN_RETURN_TO,
  LOGIN_SCOPES,
  appendGoogleAddError,
  expireGoogleLoginWebPendingForTests,
  handleGoogleLoginWebCallback,
  parseLoopbackOrigin,
  resetGoogleLoginWebState,
  sanitizeReturnTo,
  setGoogleLoginWebFetchForTests,
  startGoogleLoginWeb
} from "./google-login-web";

const config = { instance: "google-login-web-test" } as RuntimeConfig;
const ORIGIN = "http://127.0.0.1:3059";

let scratchHome: string;
let prevHome: string | undefined;
let prevStateRoot: string | undefined;
let prevHosted: string | undefined;

beforeEach(() => {
  scratchHome = mkdtempSync(join(tmpdir(), "gini-glw-"));
  prevHome = process.env.HOME;
  process.env.HOME = scratchHome;
  prevStateRoot = process.env.GINI_STATE_ROOT;
  process.env.GINI_STATE_ROOT = join(scratchHome, ".gini");
  prevHosted = process.env.GINI_HOSTED;
  delete process.env.GINI_HOSTED;
  resetGoogleLoginWebState();
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevStateRoot === undefined) delete process.env.GINI_STATE_ROOT;
  else process.env.GINI_STATE_ROOT = prevStateRoot;
  if (prevHosted === undefined) delete process.env.GINI_HOSTED;
  else process.env.GINI_HOSTED = prevHosted;
  setGoogleLoginWebFetchForTests(undefined);
  resetGoogleLoginWebState();
  rmSync(scratchHome, { recursive: true, force: true });
});

async function startedLocation(returnTo = "/onboarding", origin = ORIGIN, intent?: string): Promise<URL> {
  const result = await startGoogleLoginWeb(config, { returnTo, origin, intent });
  if (!result.ok) throw new Error(result.error);
  return new URL(result.location);
}

// A URL-dispatching Google stub: captures the token-exchange body and serves
// userinfo, so the callback runs its full happy path hermetically.
function stubGoogle(overrides: {
  tokenStatus?: number;
  refreshToken?: string | null;
  sub?: string;
  email?: string;
}): { exchangeBodies: URLSearchParams[] } {
  const captured = { exchangeBodies: [] as URLSearchParams[] };
  setGoogleLoginWebFetchForTests((async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url);
    if (target.startsWith("https://oauth2.googleapis.com/token")) {
      captured.exchangeBodies.push(new URLSearchParams(String(init?.body ?? "")));
      if (overrides.tokenStatus && overrides.tokenStatus !== 200) {
        return new Response("denied", { status: overrides.tokenStatus });
      }
      return Response.json({
        access_token: "at-1",
        ...(overrides.refreshToken === null ? {} : { refresh_token: overrides.refreshToken ?? "rt-1" })
      });
    }
    if (target.startsWith("https://openidconnect.googleapis.com/v1/userinfo")) {
      return Response.json({ sub: overrides.sub ?? "sub-1", email: overrides.email ?? "ada@example.com" });
    }
    throw new Error(`unexpected fetch: ${target}`);
  }) as typeof fetch);
  return captured;
}

describe("sanitizeReturnTo / appendGoogleAddError", () => {
  test("accepts same-origin absolute paths, defaults everything else", () => {
    expect(sanitizeReturnTo("/onboarding")).toBe("/onboarding");
    expect(sanitizeReturnTo("/onboarding?step=accounts")).toBe("/onboarding?step=accounts");
    expect(sanitizeReturnTo(undefined)).toBe(DEFAULT_LOGIN_RETURN_TO);
    expect(sanitizeReturnTo(null)).toBe(DEFAULT_LOGIN_RETURN_TO);
    expect(sanitizeReturnTo("")).toBe(DEFAULT_LOGIN_RETURN_TO);
    expect(sanitizeReturnTo("relative")).toBe(DEFAULT_LOGIN_RETURN_TO);
    expect(sanitizeReturnTo("https://evil.example/")).toBe(DEFAULT_LOGIN_RETURN_TO);
    // Scheme-relative forms browsers treat as another origin.
    expect(sanitizeReturnTo("//evil.example")).toBe(DEFAULT_LOGIN_RETURN_TO);
    expect(sanitizeReturnTo("/\\evil.example")).toBe(DEFAULT_LOGIN_RETURN_TO);
    // Control characters would break the Location header.
    expect(sanitizeReturnTo("/a\r\nb")).toBe(DEFAULT_LOGIN_RETURN_TO);
    expect(sanitizeReturnTo("/a\tb")).toBe(DEFAULT_LOGIN_RETURN_TO);
  });

  test("appendGoogleAddError is separator-aware", () => {
    expect(appendGoogleAddError("/onboarding")).toBe("/onboarding?googleAddError=1");
    expect(appendGoogleAddError("/onboarding?step=accounts")).toBe(
      "/onboarding?step=accounts&googleAddError=1"
    );
  });
});

describe("parseLoopbackOrigin", () => {
  test("accepts loopback origins and normalizes away paths", () => {
    expect(parseLoopbackOrigin("http://127.0.0.1:3059")).toBe("http://127.0.0.1:3059");
    expect(parseLoopbackOrigin("http://localhost:3000")).toBe("http://localhost:3000");
    expect(parseLoopbackOrigin("http://[::1]:3000")).toBe("http://[::1]:3000");
    expect(parseLoopbackOrigin("http://127.0.0.1:3059/some/path")).toBe("http://127.0.0.1:3059");
  });

  test("rejects non-loopback and malformed origins", () => {
    expect(parseLoopbackOrigin(null)).toBeNull();
    expect(parseLoopbackOrigin("")).toBeNull();
    expect(parseLoopbackOrigin("not a url")).toBeNull();
    expect(parseLoopbackOrigin("https://evil.example")).toBeNull();
    expect(parseLoopbackOrigin("http://192.168.1.20:3000")).toBeNull();
    // Loopback lookalike on a non-loopback host.
    expect(parseLoopbackOrigin("http://127.0.0.1.evil.example")).toBeNull();
    expect(parseLoopbackOrigin("file:///etc/passwd")).toBeNull();
  });
});

describe("startGoogleLoginWeb", () => {
  test("rejects edge auth mode", async () => {
    process.env.GINI_HOSTED = "1";
    const result = await startGoogleLoginWeb(config, { returnTo: "/onboarding", origin: ORIGIN });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("edge sign-in flow");
  });

  test("rejects a missing or non-loopback origin with a clear error", async () => {
    for (const origin of [null, "https://evil.example", "http://10.0.0.4:3000"]) {
      const result = await startGoogleLoginWeb(config, { returnTo: "/onboarding", origin });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("loopback");
    }
  });

  test("rejects an unknown intent; absent/signin/add are accepted", async () => {
    for (const intent of ["", "primary", "SIGNIN"]) {
      const result = await startGoogleLoginWeb(config, { returnTo: "/onboarding", origin: ORIGIN, intent });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("intent");
    }
    for (const intent of [undefined, null, "signin", "add"]) {
      expect((await startGoogleLoginWeb(config, { returnTo: "/onboarding", origin: ORIGIN, intent })).ok).toBe(true);
    }
  });

  test("builds the Google consent URL: PKCE S256, state, offline+consent, the gws scope set, browser-facing redirect_uri", async () => {
    const location = await startedLocation("/onboarding");
    expect(location.origin).toBe("https://accounts.google.com");
    expect(location.pathname).toBe("/o/oauth2/v2/auth");
    const params = location.searchParams;
    // No connector in the scratch state — the baked relay Desktop client.
    expect(params.get("client_id")).toBe(RELAY_WORKSPACE_CLIENT.clientId);
    expect(params.get("redirect_uri")).toBe(`${ORIGIN}/api/runtime/google/login/callback`);
    expect(params.get("response_type")).toBe("code");
    expect(params.get("access_type")).toBe("offline");
    expect(params.get("prompt")).toBe("consent select_account");
    expect(params.get("code_challenge_method")).toBe("S256");
    // base64url SHA-256 digest: 43 chars, no padding.
    expect(params.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(params.get("state")).toMatch(/^[A-Za-z0-9_-]+$/);
    expect((params.get("scope") ?? "").split(" ").sort()).toEqual([...LOGIN_SCOPES].sort());
  });
});

describe("handleGoogleLoginWebCallback", () => {
  test("no pending login → default returnTo with googleAddError=1", async () => {
    const { location } = await handleGoogleLoginWebCallback(config, { code: "c", state: "s" });
    expect(location).toBe(appendGoogleAddError(DEFAULT_LOGIN_RETURN_TO));
  });

  test("state mismatch redirects with the error and does NOT consume the pending login", async () => {
    const consent = await startedLocation("/onboarding");
    const forged = await handleGoogleLoginWebCallback(config, { code: "c", state: "not-the-state" });
    expect(forged.location).toBe(appendGoogleAddError(DEFAULT_LOGIN_RETURN_TO));
    // The legitimate callback still completes.
    stubGoogle({});
    const real = await handleGoogleLoginWebCallback(config, {
      code: "c",
      state: consent.searchParams.get("state")
    });
    expect(real.location).toBe("/onboarding");
  });

  test("an expired pending login redirects with the error", async () => {
    const consent = await startedLocation("/onboarding");
    expireGoogleLoginWebPendingForTests();
    const { location } = await handleGoogleLoginWebCallback(config, {
      code: "c",
      state: consent.searchParams.get("state")
    });
    expect(location).toBe(appendGoogleAddError(DEFAULT_LOGIN_RETURN_TO));
  });

  test("a new start supersedes the old pending login", async () => {
    const first = await startedLocation("/onboarding");
    const second = await startedLocation("/onboarding?step=accounts");
    const stale = await handleGoogleLoginWebCallback(config, {
      code: "c",
      state: first.searchParams.get("state")
    });
    expect(stale.location).toBe(appendGoogleAddError(DEFAULT_LOGIN_RETURN_TO));
    stubGoogle({});
    const fresh = await handleGoogleLoginWebCallback(config, {
      code: "c",
      state: second.searchParams.get("state")
    });
    expect(fresh.location).toBe("/onboarding?step=accounts");
  });

  test("happy path: exchanges the code with the stored redirect_uri + verifier, provisions a 0600 credential, 302s to returnTo", async () => {
    const consent = await startedLocation("/onboarding");
    const google = stubGoogle({});
    const { location } = await handleGoogleLoginWebCallback(config, {
      code: "auth-code-1",
      state: consent.searchParams.get("state")
    });
    expect(location).toBe("/onboarding");

    // The token exchange repeated the consent request's client, redirect_uri,
    // and a verifier hashing to its code_challenge (PKCE round trip intact).
    expect(google.exchangeBodies).toHaveLength(1);
    const body = google.exchangeBodies[0]!;
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("auth-code-1");
    expect(body.get("client_id")).toBe(RELAY_WORKSPACE_CLIENT.clientId);
    expect(body.get("client_secret")).toBe(RELAY_WORKSPACE_CLIENT.clientSecret);
    expect(body.get("redirect_uri")).toBe(consent.searchParams.get("redirect_uri") ?? "");
    const digest = createHash("sha256").update(body.get("code_verifier") ?? "").digest("base64url");
    expect(digest).toBe(consent.searchParams.get("code_challenge") ?? "");

    // Registered like the edge-provisioned path: trusted, principal-keyed,
    // tag from the email local-part, 0600 authorized_user credential.
    const accounts = readGoogleAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.provisioned).toBe(true);
    expect(accounts[0]!.principal).toBe("sub-1");
    expect(accounts[0]!.tag).toBe("ada");
    const credPath = join(accounts[0]!.configDir, "credentials.json");
    expect(statSync(credPath).mode & 0o777).toBe(0o600);
    const cred = JSON.parse(readFileSync(credPath, "utf8"));
    expect(cred).toEqual({
      type: "authorized_user",
      client_id: RELAY_WORKSPACE_CLIENT.clientId,
      client_secret: RELAY_WORKSPACE_CLIENT.clientSecret,
      refresh_token: "rt-1"
    });

    // Single-use: replaying the same state after consumption fails.
    const replay = await handleGoogleLoginWebCallback(config, {
      code: "auth-code-1",
      state: consent.searchParams.get("state")
    });
    expect(replay.location).toBe(appendGoogleAddError(DEFAULT_LOGIN_RETURN_TO));
  });

  test("re-adding the same identity overwrites the credential in place (idempotent by principal)", async () => {
    const first = await startedLocation("/onboarding");
    stubGoogle({});
    await handleGoogleLoginWebCallback(config, { code: "c1", state: first.searchParams.get("state") });

    const second = await startedLocation("/onboarding");
    stubGoogle({ refreshToken: "rt-2" });
    const { location } = await handleGoogleLoginWebCallback(config, {
      code: "c2",
      state: second.searchParams.get("state")
    });
    expect(location).toBe("/onboarding");

    const accounts = readGoogleAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.tag).toBe("ada");
    const cred = JSON.parse(readFileSync(join(accounts[0]!.configDir, "credentials.json"), "utf8"));
    expect(cred.refresh_token).toBe("rt-2");
  });

  test("signin intent makes the provisioned account the persisted primary; add/default never does", async () => {
    // Default (add) intent: no primary persisted.
    const addConsent = await startedLocation("/onboarding");
    stubGoogle({});
    await handleGoogleLoginWebCallback(config, { code: "c1", state: addConsent.searchParams.get("state") });
    expect(readPrimaryGoogleAccountId()).toBeUndefined();

    // Signin intent as a second identity: that account becomes the primary.
    const signinConsent = await startedLocation("/onboarding", ORIGIN, "signin");
    stubGoogle({ sub: "sub-2", email: "bob@example.com" });
    const { location } = await handleGoogleLoginWebCallback(config, {
      code: "c2",
      state: signinConsent.searchParams.get("state")
    });
    expect(location).toBe("/onboarding");
    const accounts = readGoogleAccounts();
    expect(accounts).toHaveLength(2);
    const bob = accounts.find((a) => a.principal === "sub-2");
    expect(readPrimaryGoogleAccountId()).toBe(bob!.id);

    // A later explicit add leaves the signin-chosen primary alone.
    const laterAdd = await startedLocation("/onboarding", ORIGIN, "add");
    stubGoogle({ sub: "sub-3", email: "carol@example.com" });
    await handleGoogleLoginWebCallback(config, { code: "c3", state: laterAdd.searchParams.get("state") });
    expect(readPrimaryGoogleAccountId()).toBe(bob!.id);
  });

  test("a failed signin-intent exchange never flips the primary", async () => {
    const consent = await startedLocation("/onboarding", ORIGIN, "signin");
    stubGoogle({ tokenStatus: 500 });
    const { location } = await handleGoogleLoginWebCallback(config, {
      code: "c",
      state: consent.searchParams.get("state")
    });
    expect(location).toBe("/onboarding?googleAddError=1");
    expect(readPrimaryGoogleAccountId()).toBeUndefined();
  });

  test("a failed token exchange redirects with the error and registers nothing", async () => {
    const consent = await startedLocation("/onboarding?step=accounts");
    stubGoogle({ tokenStatus: 500 });
    const { location } = await handleGoogleLoginWebCallback(config, {
      code: "c",
      state: consent.searchParams.get("state")
    });
    expect(location).toBe("/onboarding?step=accounts&googleAddError=1");
    expect(readGoogleAccounts()).toHaveLength(0);
  });

  test("a token response without a refresh token is a failure, not a partial add", async () => {
    const consent = await startedLocation("/onboarding");
    stubGoogle({ refreshToken: null });
    const { location } = await handleGoogleLoginWebCallback(config, {
      code: "c",
      state: consent.searchParams.get("state")
    });
    expect(location).toBe("/onboarding?googleAddError=1");
    expect(readGoogleAccounts()).toHaveLength(0);
  });

  test("a missing Google sub is a failure (principal keys idempotency)", async () => {
    const consent = await startedLocation("/onboarding");
    stubGoogle({ sub: "" });
    const { location } = await handleGoogleLoginWebCallback(config, {
      code: "c",
      state: consent.searchParams.get("state")
    });
    expect(location).toBe("/onboarding?googleAddError=1");
    expect(readGoogleAccounts()).toHaveLength(0);
  });

  test("a missing code after a valid state consumes the login and redirects with the error", async () => {
    const consent = await startedLocation("/onboarding");
    const { location } = await handleGoogleLoginWebCallback(config, {
      code: null,
      state: consent.searchParams.get("state")
    });
    expect(location).toBe("/onboarding?googleAddError=1");
  });

  test("the sanitized returnTo drives both redirect legs", async () => {
    const consent = await startedLocation("//evil.example");
    stubGoogle({});
    const { location } = await handleGoogleLoginWebCallback(config, {
      code: "c",
      state: consent.searchParams.get("state")
    });
    expect(location).toBe(DEFAULT_LOGIN_RETURN_TO);
  });
});

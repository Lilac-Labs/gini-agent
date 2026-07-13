// Runtime-owned same-tab Google login for the web (loopback deployments).
//
// GET /api/google/login/start and GET /api/google/login/callback implement a
// Desktop-client ("installed app") authorization-code flow with PKCE whose
// redirect URI is the web app's own loopback origin: the browser leaves
// /onboarding for Google's consent screen IN THE SAME TAB and Google sends it
// straight back into the app (<origin>/api/runtime/google/login/callback →
// BFF, which injects the gateway bearer → this callback), mirroring the
// hosted edge's /auth/google/add UX. `gws` never runs on this path; the
// refresh token is written as a gws authorized_user credentials.json through
// the same provisionAccount internals the hosted edge uses (0600 credential,
// trusted registration, idempotent by Google sub / verified email).
//
// Why this works without pre-registration: Google Desktop clients accept ANY
// http://localhost / http://127.0.0.1 port+path as a redirect URI, and in
// loopback mode the browser, BFF, and gateway all sit on the same machine.
// The flip side is that a NON-loopback browser origin (e.g. LAN access to the
// dev server) can never complete the flow — Google would refuse the redirect
// — so /start rejects it with a clear 400 instead of a dead consent screen.
//
// There is no agent/chat add path: the guest is headless and ships with its
// Google credential host-provisioned, so account adds land through the edge's
// server-side OAuth exchange → provisionAccount, not through an in-chat
// `gws auth login` (ADR google-multi-account.md).
//
// SECRETS: the authorization code, refresh token, and client secret transit
// this module. None of them is ever logged, audited, or surfaced in an error
// — every callback failure collapses to a bare `?googleAddError=1` redirect.

import { createHash, randomBytes } from "node:crypto";

import type { RuntimeConfig } from "../../types";
import { ensureLabelProfile } from "../../runtime/label-discovery";
import { readState } from "../../state";
import { bindingsForCredentials, resolveConnectorSecret } from "./index";
import { googleAuthMode, provisionAccount } from "./google-accounts";
import { RELAY_WORKSPACE_CLIENT, type RelayWorkspaceClient } from "./relay-workspace-client";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo";

// The browser-facing callback path — the web BFF's namespace, not this
// gateway's: the redirect URI must be what the user's address bar can reach,
// and the BFF forwards /api/runtime/google/login/callback here with the
// bearer injected.
const CALLBACK_PATH = "/api/runtime/google/login/callback";

// The credential name whose connector holds a user-supplied OAuth client
// (google-oauth-desktop.ts `credentialName`).
const GOOGLE_WORKSPACE_CREDENTIAL = "google-workspace-oauth";

// The exact scope set `gws auth login -s drive,gmail,calendar,docs,sheets,
// meet,forms` requests (captured from gws's own consent URL), so a credential
// minted here carries the same grants as one minted by the account-login
// skill script: the seven service scopes (plus the narrower siblings gws
// bundles) and the openid/userinfo pair that also lets the callback identify
// the account (sub + email) for principal-keyed registration.
export const LOGIN_SCOPES = [
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/forms.body",
  "https://www.googleapis.com/auth/forms.body.readonly",
  "https://www.googleapis.com/auth/forms.responses.readonly",
  "https://www.googleapis.com/auth/meetings.space.created",
  "https://www.googleapis.com/auth/meetings.space.readonly",
  "https://www.googleapis.com/auth/meetings.space.settings",
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile"
];

// Where the browser lands after the flow. Mirrors the hosted edge's
// sanitizer semantics byte-for-byte (kept in sync by hand; the edge is a
// separate codebase and cross-package imports are
// off-limits): only a same-origin absolute path is accepted — it must start
// with "/" and not "//" or "/\" (both of which browsers treat as
// scheme-relative URLs), and control characters are rejected (the value ends
// up in a Location header, where a CR/LF makes Response construction throw).
// Anything else falls back to the default.
export const DEFAULT_LOGIN_RETURN_TO = "/onboarding?step=accounts";

export function sanitizeReturnTo(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith("/")) return DEFAULT_LOGIN_RETURN_TO;
  if (raw[1] === "/" || raw[1] === "\\") return DEFAULT_LOGIN_RETURN_TO;
  if (/[\u0000-\u001f\u007f]/.test(raw)) return DEFAULT_LOGIN_RETURN_TO;
  return raw;
}

// Failure redirects append googleAddError=1 — the same error param the edge
// flow uses, so the web's existing page-level toast covers both; returnTo may
// already carry a query string.
export function appendGoogleAddError(returnTo: string): string {
  return `${returnTo}${returnTo.includes("?") ? "&" : "?"}googleAddError=1`;
}

// What a completed login should DO with the account beyond registering it:
// "signin" (the sign-in step's Continue with Google / Use a different account
// / reconnect-primary) makes the provisioned account the persisted primary;
// "add" (the accounts step) never touches the primary. Absent defaults to
// "add" — the non-destructive intent — and anything else is rejected up
// front, the same way a bad origin is.
export type GoogleLoginIntent = "signin" | "add";

export function parseLoginIntent(raw: string | null | undefined): GoogleLoginIntent | null {
  if (raw == null) return "add";
  return raw === "signin" || raw === "add" ? raw : null;
}

// The browser-facing origin the redirect URI is built on. The gateway can't
// derive it from the request — the BFF's loopback hop rewrites Host to the
// GATEWAY's port, while the consent redirect must target the WEB app's — so
// the page passes `window.location.origin` along and this validates it is a
// loopback origin a Desktop client may redirect to. Returns the normalized
// origin (scheme://host[:port], any path/credentials dropped), or null.
export function parseLoopbackOrigin(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1" && url.hostname !== "[::1]") return null;
  return url.origin;
}

// One login in flight per gateway process, in memory: /start mints the state
// nonce + PKCE verifier and stores everything the callback needs — including
// the resolved OAuth client and the EXACT redirect_uri (the token exchange
// must repeat it byte-for-byte) — a new start supersedes the old record, and
// the TTL bounds how long an abandoned consent tab stays redeemable. Lost on
// restart by design: the registry is the durable record.
interface PendingLogin extends RelayWorkspaceClient {
  state: string;
  verifier: string;
  returnTo: string;
  redirectUri: string;
  intent: GoogleLoginIntent;
  createdAt: number;
}

const PENDING_TTL_MS = 10 * 60 * 1000;

let pending: PendingLogin | undefined;
let testFetch: typeof fetch | undefined;

export type StartGoogleLoginWebResult =
  | { ok: true; location: string }
  | { ok: false; error: string };

// Mint the pending record and build the consent URL for the 302. No network
// I/O — Google is only contacted by the browser (consent) and the callback
// (exchange).
export async function startGoogleLoginWeb(
  config: RuntimeConfig,
  input: { returnTo: string | null; origin: string | null; intent?: string | null }
): Promise<StartGoogleLoginWebResult> {
  if (googleAuthMode() === "edge") {
    return {
      ok: false,
      error: "Direct Google login is unavailable on hosted deployments — use the edge sign-in flow."
    };
  }
  const origin = parseLoopbackOrigin(input.origin);
  if (!origin) {
    return {
      ok: false,
      error:
        "Google Desktop-client OAuth can only redirect to a loopback origin " +
        "(localhost / 127.0.0.1) — pass the web app's own address as `origin`."
    };
  }
  const intent = parseLoginIntent(input.intent);
  if (!intent) {
    return { ok: false, error: 'intent must be "signin" or "add"' };
  }
  const client = await resolveOAuthClient(config);
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(16).toString("base64url");
  const redirectUri = `${origin}${CALLBACK_PATH}`;
  pending = {
    ...client,
    state,
    verifier,
    returnTo: sanitizeReturnTo(input.returnTo),
    redirectUri,
    intent,
    createdAt: Date.now()
  };
  const params = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: LOGIN_SCOPES.join(" "),
    // offline + consent guarantee a refresh token; select_account forces the
    // chooser so adding a second identity never silently re-authorizes the
    // browser's current one (same directives the edge and gws use).
    access_type: "offline",
    prompt: "consent select_account",
    state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256"
  });
  return { ok: true, location: `${AUTH_ENDPOINT}?${params.toString()}` };
}

// The callback leg: validate state against the pending record, exchange the
// code, identify the account, persist the credential. ALWAYS resolves to a
// redirect — the browser is mid-navigation, so failures land back in the app
// with `?googleAddError=1` rather than on a bare error body.
export async function handleGoogleLoginWebCallback(
  config: RuntimeConfig,
  input: { code: string | null; state: string | null }
): Promise<{ location: string }> {
  const live = pending && Date.now() - pending.createdAt <= PENDING_TTL_MS ? pending : undefined;
  if (!live || !input.state || input.state !== live.state) {
    // Unknown, expired, or mismatched state: this navigation isn't (or is no
    // longer) a flow this process minted. Don't consume the pending record —
    // a stray/forged hit must not kill a legitimate in-flight login — and
    // don't trust any returnTo but the default.
    return { location: appendGoogleAddError(DEFAULT_LOGIN_RETURN_TO) };
  }
  // Single-use from here: the state matched, so this IS our flow's callback —
  // consumed whether the exchange succeeds or not (an authorization code is
  // single-use on Google's side too).
  pending = undefined;
  if (!input.code) return { location: appendGoogleAddError(live.returnTo) };
  try {
    const tokens = await exchangeCode(live, input.code);
    // access_type=offline + prompt=consent make the refresh token expected;
    // without it there is nothing durable to register.
    if (!tokens.refreshToken) return { location: appendGoogleAddError(live.returnTo) };
    const info = await fetchUserInfo(tokens.accessToken);
    // The Google sub keys principal idempotency; a blank identity must fail
    // rather than mint an unkeyed row.
    if (!info.sub) return { location: appendGoogleAddError(live.returnTo) };
    const account = await provisionAccount({
      clientId: live.clientId,
      clientSecret: live.clientSecret,
      refreshToken: tokens.refreshToken,
      email: info.email || undefined,
      principal: info.sub,
      // A sign-in-intent login makes the account the persisted primary; the
      // flag applies only after the provision succeeds, so a failed exchange
      // can never flip it.
      makePrimary: live.intent === "signin",
      instance: config.instance
    });
    // The credential just landed — digest the account's existing Gmail
    // labels into per-account Auto-inbox defaults (fire-and-forget; see
    // src/runtime/label-discovery.ts).
    ensureLabelProfile(config, account);
    return { location: live.returnTo };
  } catch {
    // Deliberately swallowed without detail: exchange/userinfo errors can
    // quote the request, which carries the code and client secret.
    return { location: appendGoogleAddError(live.returnTo) };
  }
}

// Resolve the OAuth client for the round trip — ONCE per login, at /start;
// the pending record carries the pair to the callback's token exchange, so
// the connector secret is decrypted (and its connector.secret.use audit row
// written) a single time per login rather than once per leg. The
// google-workspace-oauth connector's client wins when BOTH vars resolve;
// otherwise the baked relay Desktop client, whose secret is by-design
// distributable (see ./relay-workspace-client.ts). The pair is atomic —
// mixing a half-resolved connector client with the relay's could never
// complete an exchange.
async function resolveOAuthClient(config: RuntimeConfig): Promise<RelayWorkspaceClient> {
  const bindings = bindingsForCredentials(readState(config.instance), [GOOGLE_WORKSPACE_CREDENTIAL]);
  const id = bindings.GOOGLE_WORKSPACE_CLI_CLIENT_ID;
  const secret = bindings.GOOGLE_WORKSPACE_CLI_CLIENT_SECRET;
  if (id && secret) {
    const clientId = await resolveConnectorSecret(config, id.credentialId, id.purpose);
    const clientSecret = await resolveConnectorSecret(config, secret.credentialId, secret.purpose);
    if (clientId && clientSecret) return { clientId, clientSecret };
  }
  return RELAY_WORKSPACE_CLIENT;
}

// Token exchange, mirroring the edge's exchangeCode plus the PKCE verifier.
// The redirect_uri must match the consent request byte-for-byte — hence the
// stored value, never a re-derived one.
async function exchangeCode(
  record: PendingLogin,
  code: string
): Promise<{ accessToken: string; refreshToken: string }> {
  const body = new URLSearchParams({
    code,
    client_id: record.clientId,
    client_secret: record.clientSecret,
    redirect_uri: record.redirectUri,
    grant_type: "authorization_code",
    code_verifier: record.verifier
  });
  const res = await (testFetch ?? globalThis.fetch)(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString()
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status}`);
  const json = (await res.json()) as { access_token?: string; refresh_token?: string };
  return { accessToken: json.access_token ?? "", refreshToken: json.refresh_token ?? "" };
}

// OIDC userinfo, mirroring the edge's fetchUserInfo (the LOGIN_SCOPES openid/
// userinfo.email grants cover it).
async function fetchUserInfo(accessToken: string): Promise<{ sub: string; email: string }> {
  const res = await (testFetch ?? globalThis.fetch)(USERINFO_ENDPOINT, {
    headers: { authorization: `Bearer ${accessToken}` }
  });
  if (!res.ok) throw new Error(`userinfo failed: ${res.status}`);
  const json = (await res.json()) as { sub?: string; email?: string };
  return { sub: json.sub ?? "", email: json.email ?? "" };
}

// Test seams: stub the Google HTTP boundary, reset the single-flight record
// between cases, and back-date it past the TTL (gws-session.ts pattern).
export function setGoogleLoginWebFetchForTests(fetchImpl: typeof fetch | undefined): void {
  testFetch = fetchImpl;
}

export function resetGoogleLoginWebState(): void {
  pending = undefined;
}

export function expireGoogleLoginWebPendingForTests(): void {
  if (pending) pending.createdAt -= PENDING_TTL_MS + 1;
}

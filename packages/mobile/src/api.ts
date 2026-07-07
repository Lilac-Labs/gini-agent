import * as FileSystem from "expo-file-system/legacy";
import {
  isLocalGatewayHost,
  PUBLIC_HTTP_REJECTION,
  readCachedCredentials,
  type AuthCredentials
} from "./auth";

// Defense-in-depth runtime gate against credentials persisted by an
// older build that didn't enforce the local-only http allowlist (or
// a future regression). Throws so the bearer never leaves the device
// in cleartext via a public http:// URL.
function assertTransportAllowed(baseUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new ApiError(0, "Stored base URL is invalid.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ApiError(0, "Stored base URL is invalid.");
  }
  if (parsed.protocol === "http:" && !isLocalGatewayHost(parsed.hostname)) {
    throw new ApiError(0, PUBLIC_HTTP_REJECTION);
  }
  return parsed;
}

// Mirrors web/src/lib/api.ts in shape (`api<T>(path, init)`), but talks
// to the runtime gateway directly with a bearer token instead of routing
// through the Next.js BFF.
//
// The path argument is the runtime-relative path WITHOUT the `/api`
// prefix — e.g. `/chat`, `/agents/abc/use` — matching how the web client
// calls api("/chat"). Keeping the call-site shape identical means
// queries.ts looks familiar and is easy to keep in sync with the web's
// queries.ts when fields are added.

// Distinguishes a locally-thrown "we have no token" 401 from a real gateway
// rejection. The credentialless throws below carry "no_credentials"; a token
// the gateway presented and rejected carries no code. Only a rejection should
// drive sign-out + redirect — see isCredentialRejected.
export type ApiErrorCode = "no_credentials";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: ApiErrorCode
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// Treat any 4xx/5xx as unauthenticated if it's a 401 from the gateway —
// the auth gate uses this to bounce the user back to the signed-out screen.
export function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

// A real gateway 401: the token was presented and rejected, as opposed to a
// local ApiError(401, …, "no_credentials") thrown before any fetch when no
// token is stored. Screens gate their sign-out+redirect on this so a rejected
// token bounces to the signed-out screen exactly once, while a *missing* token does nothing —
// we're already signed out and the root auth gate (app/index.tsx) owns routing.
// Without the distinction, every background poll that runs after sign-out throws
// "No credentials configured" and re-fires the sign-out redirect, reopening
// the signed-out screen over and over while the user sits on it doing nothing.
export function isCredentialRejected(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401 && error.code !== "no_credentials";
}

// Request timeouts. A gateway that accepts the TCP connection but never
// answers (a half-dead socket left behind by a torn-down chat SSE stream,
// a proxy hop that dropped the response, the device losing the network
// mid-flight) would otherwise leave the fetch pending forever: React
// Query's `isLoading` stays latched, the screen's spinner never resolves,
// and there's no error to retry — the user has to force-quit (issue #396).
//
// GETs are idempotent reads that should return in well under a second on
// the local/Tailscale links this app talks to, and they're what backs the
// list screens whose spinner the user stares at. A short ceiling means a
// stuck read surfaces a retryable error fast instead of after a long hang
// (with React Query's retry:1, the felt wait is two timeouts plus the
// retry backoff). Writes (POST/PUT/PATCH/DELETE) can legitimately block on
// server-side work, so they get a more forgiving ceiling. Either way the
// per-call `timeoutMs` wins — the voice send path passes a much larger
// value so first-run transcription isn't cut off.
const GET_TIMEOUT_MS = 10_000;
const WRITE_TIMEOUT_MS = 20_000;

interface ApiOptions extends Omit<RequestInit, "headers" | "credentials"> {
  headers?: Record<string, string>;
  // Override the cached gateway credentials (used by the setup screen to
  // validate a NEW baseUrl + token before persisting them). Named `auth`
  // rather than `credentials` to avoid colliding with the standard
  // RequestInit.credentials cookie/CORS field.
  auth?: AuthCredentials;
  // Per-call request timeout in milliseconds. Defaults by method
  // (GET_TIMEOUT_MS for reads, WRITE_TIMEOUT_MS for writes); pass a larger
  // value for routes that block on slow server-side work (e.g. first-run
  // voice transcription). A timeout aborts the in-flight fetch and surfaces
  // as ApiError(0, …) so the caller settles into an error state instead of
  // hanging.
  timeoutMs?: number;
}

export async function api<T = unknown>(path: string, init: ApiOptions = {}): Promise<T> {
  const creds = init.auth ?? readCachedCredentials();
  if (!creds) throw new ApiError(401, "No credentials configured", "no_credentials");

  const { auth: _auth, timeoutMs, signal: callerSignal, ...rest } = init;

  // Defensively re-derive the origin so a malformed value in storage
  // (e.g. one written by an older build that didn't normalize) can't
  // leak query strings into the request URL. Also blocks public-http
  // base URLs before the Authorization header is attached.
  const parsed = assertTransportAllowed(creds.baseUrl);

  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${creds.token}`,
    // Attach the cached APNs device token automatically when present.
    // Routes that key per-device (e.g. /chat/:id/read, /badge) need
    // it; routes that don't simply ignore the header. Resolved
    // lazily via require() so api.ts doesn't create an import cycle
    // with push.ts (which imports api).
    ...resolveDeviceTokenHeader(),
    ...(init.headers ?? {})
  };

  // Bound the request with a deadline that ALWAYS settles, independent of
  // whether the runtime's fetch honors an abort. RN polyfills AbortController
  // (abort-controller@3) but NOT the static AbortSignal.timeout()/any()
  // helpers, so the timer is wired manually.
  //
  // Why a race and not just controller.abort(): the abort path only settles
  // the request if `fetch` actually rejects in response. Under Bun and on web
  // it does, but on device the global is Expo's winter fetch, where an abort
  // is forwarded to a native request.cancel() (expo/.../fetch/fetch.ts) — and
  // on a wedged socket (a zombie relay tunnel that keeps the HTTP connection
  // open while no bytes flow back) cancel() does not unblock the in-flight
  // native read. The timer would fire, the controller would abort, yet
  // `await fetch(...)` / `await response.text()` would never settle, leaving
  // the query pending and the list screen's spinner up until a force-quit.
  // Racing the request against `deadlinePromise` makes api() settle when the
  // timer rejects the deadline, regardless of whether the fetch promise ever
  // does. controller.abort() is still fired so a cancellation-honoring
  // runtime frees the request promptly and a device runtime gets the signal
  // to release native resources.
  //
  // The deadline also covers BOTH the fetch AND the body read: winter fetch
  // resolves the Response as soon as headers arrive and streams the body
  // lazily, so a gateway that flushes headers then stalls the body would
  // otherwise hang forever on response.text(). The single deadline spans the
  // whole request, so a stall at either stage settles via the race.
  //
  // A caller that passes a `signal` (e.g. to forward React Query's
  // cancellation) chains in so an upstream cancel also aborts; current query
  // hooks don't forward one, so this is an opt-in capability, not a
  // requirement.
  const controller = new AbortController();
  // Default by method: a missing/"GET" method is an idempotent read and
  // gets the short ceiling; anything else is a write and gets the longer
  // one. An explicit timeoutMs overrides both.
  const method = (rest.method ?? "GET").toUpperCase();
  const defaultTimeout = method === "GET" ? GET_TIMEOUT_MS : WRITE_TIMEOUT_MS;
  const timeout = timeoutMs ?? defaultTimeout;
  // Track WHY the request settled via the deadline with an explicit flag
  // rather than sniffing the thrown error's name. The aborted-request error
  // shape is runtime-specific — RN's whatwg-fetch throws a DOMException named
  // "AbortError", but Expo's winter fetch (the global on device) throws its
  // own FetchError that is NOT named "AbortError" — so a name check would
  // misclassify the timeout on device and let the raw error escape instead of
  // the tagged ApiError(0). The flag is set only by our timer, so a
  // caller-initiated cancel never trips it.
  let didTimeout = false;
  // The deadline is a reject-only promise the request races against. It is
  // rejected by EITHER the timer (a timeout) OR a caller abort — both must
  // settle the race, because the race is the only thing that guarantees
  // termination when the runtime's fetch ignores the abort signal. The timer
  // rejects with the timeout ApiError; onCallerAbort rejects with a plain
  // cancellation error (below).
  //
  // Built with `new Promise`, NOT `Promise.withResolvers()`: the device JS
  // engine is Hermes (react-native ships its own Promise polyfill, not a
  // native one), which does not implement the ES2024 `Promise.withResolvers`.
  // Calling it would throw `Promise.withResolvers is not a function` on every
  // request on device — Bun (the test runtime) supports it, so a test-only
  // build would mask the failure. Capturing the rejector from the executor is
  // the portable equivalent.
  let rejectDeadline!: (reason: Error) => void;
  const deadlinePromise = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
  });
  const timer = setTimeout(() => {
    didTimeout = true;
    controller.abort();
    rejectDeadline(new ApiError(0, `Request to ${path} timed out`));
  }, timeout);
  // A caller-driven abort disarms the timer before aborting, so the timer
  // can't fire afterward and flip didTimeout — that would misclassify a
  // genuine caller cancellation as a timeout (the abort rejection reaches
  // the catch a microtask later, leaving a window for the macrotask timer
  // to run first). Both the already-aborted and the later-abort paths go
  // through here so neither can race the flag.
  //
  // Rejecting the deadline here too is what makes the caller-abort path
  // settle even when the runtime's fetch ignores the signal: controller.abort()
  // alone only rejects the in-flight request on a cancellation-honoring
  // runtime, so on the winter-fetch wedge the race would otherwise hang
  // exactly as the timeout path would without its own deadline rejection. The
  // rejection is a plain Error (not an ApiError) and didTimeout stays false,
  // so the catch rethrows it unchanged — a caller cancel surfaces as a
  // cancellation, never relabeled as a timeout.
  const onCallerAbort = () => {
    clearTimeout(timer);
    controller.abort();
    rejectDeadline(new Error("The operation was aborted."));
  };
  if (callerSignal) {
    if (callerSignal.aborted) onCallerAbort();
    else callerSignal.addEventListener("abort", onCallerAbort);
  }

  const url = `${parsed.origin}/api${path}`;
  try {
    // Race the whole request (fetch + body read) against the deadline so a
    // runtime whose fetch ignores the abort can't keep this pending forever.
    // The fetch work is wrapped in its own async thunk; whichever settles
    // first wins. `deadlinePromise` is reject-only (the timeout ApiError, or
    // the caller-abort Error), so the success branch can only come from the
    // request.
    const requestWork = (async () => {
      const response = await fetch(url, { ...rest, headers, signal: controller.signal });
      // Read the body inside the raced work — a stalled body loses to the
      // deadline too. 204 No Content (or any empty body) → null cast as T so
      // callers that don't care about the body don't choke on JSON.parse.
      const bodyText = await response.text();
      return { response, bodyText };
    })();
    // When the deadline wins the race, requestWork keeps running detached. If
    // the wedged request later settles with a rejection (the socket finally
    // errors, the abort lands), nothing would be awaiting it — an unhandled
    // promise rejection. Attach a no-op catch so the abandoned work can't
    // surface one; the deadline already produced the error we act on.
    requestWork.catch(() => {});
    const { response, bodyText } = await Promise.race([requestWork, deadlinePromise]);
    const value = bodyText ? safeParse(bodyText) : null;
    if (!response.ok) {
      // Two error-body shapes flow through the gateway: generic 4xx/5xx
      // { error: "..." }, and the fill_secret / connector runtime-action
      // routes { ok: false, message: "..." }. Read both so a non-2xx
      // fill_secret response surfaces its actionable message (e.g. "Browser
      // session expired") instead of a bare "HTTP <status>". Mirrors
      // web/src/lib/api.ts.
      const envelope =
        value && typeof value === "object"
          ? (value as { error?: unknown; message?: unknown })
          : null;
      const message =
        typeof envelope?.error === "string"
          ? envelope.error
          : typeof envelope?.message === "string"
            ? envelope.message
            : `HTTP ${response.status}`;
      throw new ApiError(response.status, message);
    }
    return value as T;
  } catch (err) {
    // Our timer fired → tagged transport error so the query settles into
    // isError instead of staying pending forever. A caller-initiated abort
    // (didTimeout false) is a real cancellation — rethrow as-is so React
    // Query treats it as a cancelled query, not a failure.
    if (didTimeout) {
      throw new ApiError(0, `Request to ${path} timed out`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (callerSignal) callerSignal.removeEventListener("abort", onCallerAbort);
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// Uploaded image ref returned by POST /api/uploads. Matches the runtime's
// ImageAttachment shape — the client only carries this descriptor and
// attaches it to the next /messages call's `images` array.
export interface UploadRef {
  id: string;
  mimeType: string;
  size: number;
}

// Multipart upload to the gateway. We can't reuse api() because it pins
// content-type: application/json, which would strip the multipart
// boundary. We also can't use fetch() with FormData here: Expo SDK 56
// installs a winter-fetch polyfill whose convertFormDataAsync rejects
// React Native's classic `{uri, name, type}` part shape (see
// node_modules/expo/src/winter/fetch/convertFormData.ts — "Unsupported
// FormDataPart implementation"). FileSystem.uploadAsync streams the
// file from disk through native URLSession, sidestepping the polyfill
// and avoiding loading the bytes into JS memory at all.
async function uploadFile(file: {
  uri: string;
  name: string;
  mimeType: string;
}): Promise<UploadRef> {
  const creds = readCachedCredentials();
  if (!creds) throw new ApiError(401, "No credentials configured", "no_credentials");
  // Same transport guard as api(): block public-http origins before the
  // bearer ever leaves the device, even on the multipart upload path.
  const parsed = assertTransportAllowed(creds.baseUrl);
  const response = await FileSystem.uploadAsync(`${parsed.origin}/api/uploads`, file.uri, {
    httpMethod: "POST",
    uploadType: FileSystem.FileSystemUploadType.MULTIPART,
    fieldName: "file",
    mimeType: file.mimeType,
    // expo-file-system's multipart has no part-filename option, so the
    // original name reaches the server as an explicit `filename` form field
    // (the upload handler prefers it over the streamed part's cache basename).
    parameters: { filename: file.name },
    headers: { Authorization: `Bearer ${creds.token}` }
  });
  const value = response.body ? safeParse(response.body) : null;
  if (response.status < 200 || response.status >= 300) {
    const message =
      value && typeof value === "object" && "error" in value && typeof value.error === "string"
        ? value.error
        : `HTTP ${response.status}`;
    throw new ApiError(response.status, message);
  }
  return value as UploadRef;
}

export function uploadImage(file: {
  uri: string;
  name: string;
  mimeType: string;
}): Promise<UploadRef> {
  return uploadFile(file);
}

// Voice-message upload. The gateway's /api/uploads gate accepts audio/*
// alongside image/*; the recorder hands us a 16 kHz mono WAV with an
// explicit `audio/wav` mimeType so it passes the prefix check.
export function uploadAudio(file: {
  uri: string;
  name: string;
  mimeType: string;
}): Promise<UploadRef> {
  return uploadFile(file);
}

// Absolute URL for a stored upload. The gateway serves the bytes with
// long-lived immutable cache headers; the request still needs the bearer
// token, so callers must pass it via an Image source's `headers` prop.
export function uploadUrl(id: string): string {
  const creds = readCachedCredentials();
  if (!creds) throw new ApiError(401, "No credentials configured", "no_credentials");
  const parsed = assertTransportAllowed(creds.baseUrl);
  return `${parsed.origin}/api/uploads/${encodeURIComponent(id)}`;
}

export function authHeader(): Record<string, string> {
  const creds = readCachedCredentials();
  if (!creds) return {};
  return { Authorization: `Bearer ${creds.token}` };
}

// Absolute gateway URL + bearer/device-token headers for a stored upload's
// raw bytes. The system browser can't attach the bearer, so a non-image
// attachment chip downloads via this (FileSystem.downloadAsync) and hands the
// file to the OS preview/Share sheet. Mirrors fileRawSource for uploads.
export function uploadRawSource(id: string): { uri: string; headers: Record<string, string> } {
  const creds = readCachedCredentials();
  if (!creds) throw new ApiError(401, "No credentials configured", "no_credentials");
  const parsed = assertTransportAllowed(creds.baseUrl);
  return {
    uri: `${parsed.origin}/api/uploads/${encodeURIComponent(id)}`,
    headers: {
      authorization: `Bearer ${creds.token}`,
      ...resolveDeviceTokenHeader()
    }
  };
}

// Mint a short-lived SIGNED preview url for an upload and return the absolute
// url. The mint POST is bearer-authed (via api()); the returned url carries
// `?inline=1&exp=&sig=` so a header-less in-app browser (SFSafariViewController
// / Custom Tabs, which can't send the bearer) can open the preview directly.
// The signing happens server-side — the secret never reaches the client. The
// gateway returns a relative `path`; we prepend the resolved origin so the url
// is absolute for the browser.
export async function signUploadUrl(id: string): Promise<string> {
  const creds = readCachedCredentials();
  if (!creds) throw new ApiError(401, "No credentials configured", "no_credentials");
  const parsed = assertTransportAllowed(creds.baseUrl);
  // api() prepends `${origin}/api`, so the path passed here omits the `/api`
  // prefix (mirrors fetchWorkspaceFile). The gateway's response `path` IS
  // already absolute-from-root (`/api/uploads/...`), so it's joined to the bare
  // origin, not the /api-prefixed base.
  const { path } = await api<{ path: string; exp: number }>(
    `/uploads/${encodeURIComponent(id)}/sign`,
    { method: "POST" }
  );
  return `${parsed.origin}${path}`;
}

// A workspace file read via GET /api/files. `content` is the utf8 text (null
// for binary files); `truncated` is set when the file exceeds the gateway's
// read cap. Mirrors web/src/lib/api.ts's WorkspaceFile.
export interface WorkspaceFile {
  path: string;
  absolutePath: string;
  name: string;
  bytes: number;
  content: string | null;
  truncated: boolean;
  binary: boolean;
}

export function fetchWorkspaceFile(path: string): Promise<WorkspaceFile> {
  return api<WorkspaceFile>(`/files?path=${encodeURIComponent(path)}`);
}

// Absolute gateway URL + bearer/device-token headers for a workspace file's
// raw bytes. `inline=1` makes the gateway serve the real content-type (so
// <Image source> can decode it); plain raw streams an octet-stream attachment
// suitable for FileSystem.downloadAsync. Reuses the same transport guard and
// credential resolution as api()/uploadUrl so a public-http base URL can't
// leak the bearer.
export function fileRawSource(
  path: string,
  opts: { inline?: boolean } = {}
): { uri: string; headers: Record<string, string> } {
  const creds = readCachedCredentials();
  if (!creds) throw new ApiError(401, "No credentials configured", "no_credentials");
  const parsed = assertTransportAllowed(creds.baseUrl);
  const inline = opts.inline ? "&inline=1" : "";
  return {
    uri: `${parsed.origin}/api/files?path=${encodeURIComponent(path)}&raw=1${inline}`,
    headers: {
      authorization: `Bearer ${creds.token}`,
      ...resolveDeviceTokenHeader()
    }
  };
}

// Resolve the absolute gateway URL + auth headers for an SSE subscription.
// react-native-sse opens its own XHR, so we can't reuse the `api()` fetcher;
// this helper centralizes origin normalization and bearer injection so the
// streaming hook doesn't reimplement either. Throws ApiError(401) when no
// credentials are configured — the caller surfaces that the same way the
// /blocks fetch does so the chat detail screen's signed-out redirect effect
// still fires.
export function resolveStreamEndpoint(path: string): {
  url: string;
  headers: Record<string, string>;
} {
  const creds = readCachedCredentials();
  if (!creds) throw new ApiError(401, "No credentials configured", "no_credentials");
  // Same transport guard as api(): if a stored URL is public-http,
  // refuse to open the stream rather than leak the bearer.
  const parsed = assertTransportAllowed(creds.baseUrl);
  return {
    url: `${parsed.origin}/api${path}`,
    headers: {
      authorization: `Bearer ${creds.token}`,
      // SSE endpoint resolver also injects X-Device-Token so the
      // gateway's per-device watch registry can credit this device's
      // open stream and suppress redundant silent pushes to it.
      ...resolveDeviceTokenHeader()
    }
  };
}

// Pull the cached APNs token from push.ts on every call. We avoid a
// static import because push.ts depends on this module (transitively
// through ApiError), and bundlers handle the cycle inconsistently
// when require()'d lazily. Returns an empty object when no token is
// cached so the header simply isn't sent.
function resolveDeviceTokenHeader(): Record<string, string> {
  try {
    const pushModule = require("./push") as { getCachedDeviceToken?: () => string | null };
    const token = pushModule.getCachedDeviceToken?.();
    if (token) return { "X-Device-Token": token };
  } catch {
    // Test envs without RN: push.ts side effects fail to load; that's
    // fine — the header is best-effort.
  }
  return {};
}

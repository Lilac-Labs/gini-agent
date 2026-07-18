import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// Unit tests for the api() fetcher, focused on the request-timeout path
// added for issue #396 (a hung gateway must surface a settled error
// instead of an indefinite pending). Only the native modules api.ts /
// auth.ts pull in are stubbed; the fetch itself is replaced per-test so
// each branch (success, non-ok, empty body, timeout, caller-cancel) is
// driven deterministically.

const store = new Map<string, string>();
mock.module("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: (k: string) => Promise.resolve(store.get(k) ?? null),
    setItem: (k: string, v: string) => {
      store.set(k, v);
      return Promise.resolve();
    },
    removeItem: (k: string) => {
      store.delete(k);
      return Promise.resolve();
    }
  }
}));

// push.ts is require()'d lazily by api.ts for the X-Device-Token header.
// A mutable token lets a test exercise both the present and absent branches.
let deviceToken: string | null = null;
mock.module("@/src/push", () => ({
  getCachedDeviceToken: () => deviceToken
}));

// expo-file-system/legacy upload result is driven per-test for uploadFile().
let uploadResult: { status: number; body: string } = { status: 200, body: "{}" };
mock.module("expo-file-system/legacy", () => ({
  uploadAsync: () => Promise.resolve(uploadResult),
  FileSystemUploadType: { MULTIPART: "multipart" }
}));

const {
  api,
  ApiError,
  isUnauthorized,
  isCredentialRejected,
  uploadImage,
  uploadAudio,
  uploadUrl,
  authHeader,
  fetchWorkspaceFile,
  fileRawSource,
  uploadRawSource,
  signUploadUrl,
  resolveStreamEndpoint
} = await import("@/src/api");
const { saveCredentials, clearCredentials } = await import("@/src/auth");

const realFetch = globalThis.fetch;

// Install a test fetch stub. globalThis.fetch's type carries extra members
// (preconnect) a bare function literal lacks, so route the assignment
// through unknown — the stub only needs the (url, init) → Response shape.
type FetchStub = (url: string, init?: RequestInit) => Promise<Response>;
function setFetch(stub: FetchStub): void {
  globalThis.fetch = stub as unknown as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

// The shape Expo's winter fetch (the global on device) throws on abort: a
// FetchError whose name is NOT "AbortError" and whose message is prefixed
// "fetch failed:". Modeled here so the abort tests reflect device behavior
// rather than the whatwg-fetch DOMException shape.
function makeFetchError(): Error {
  const err = new Error("fetch failed: The operation was aborted.");
  err.name = "FetchError";
  return err;
}

beforeEach(async () => {
  deviceToken = null;
  uploadResult = { status: 200, body: "{}" };
  await saveCredentials({ baseUrl: "http://127.0.0.1:7421", token: "tok" });
});

afterEach(async () => {
  // Drop any device token a test left set BEFORE clearing credentials, and
  // clear credentials while the stub fetch is still installed. Otherwise
  // clearCredentials() → tryDeregisterCachedDevice() would issue a real
  // DELETE /api/push/devices/<token> against the live test origin once the
  // real fetch is restored — a network call in teardown that depends on a
  // running gateway and leaks across tests.
  deviceToken = null;
  await clearCredentials();
  globalThis.fetch = realFetch;
});

describe("api() request timeout (issue #396)", () => {
  test("returns the parsed JSON body on a successful response and clears the timer", async () => {
    setFetch(async () => jsonResponse({ ok: true }));
    const result = await api<{ ok: boolean }>("/agents");
    expect(result).toEqual({ ok: true });
  });

  test("a request that never resolves is aborted by the timeout and surfaces ApiError(0)", async () => {
    // On abort, reject with an Expo-winter-fetch-shaped error: a FetchError
    // whose name is NOT "AbortError" (that's exactly what the device throws).
    // Classification keys off our own didTimeout flag, not the error name, so
    // this must still surface ApiError(0) rather than the raw FetchError.
    setFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(makeFetchError()));
        })
    );

    const err = await api("/agents", { timeoutMs: 50 }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as InstanceType<typeof ApiError>).status).toBe(0);
    expect((err as Error).message).toContain("timed out");
  });

  test("a response whose body stalls after headers is still aborted by the timeout", async () => {
    // Expo's winter fetch resolves the Response as soon as headers arrive
    // and streams the body lazily, so a gateway that flushes headers then
    // stalls the body would hang on response.text() forever if the timeout
    // were cleared right after fetch(). Model that: fetch() resolves a
    // Response whose text() only settles (with a FetchError, like the device)
    // when the abort signal fires.
    setFetch((_url, init) => {
      const body = new Promise<string>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(makeFetchError()));
      });
      const response = {
        ok: true,
        status: 200,
        text: () => body
      } as unknown as Response;
      return Promise.resolve(response);
    });

    const err = await api("/agents", { timeoutMs: 50 }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as InstanceType<typeof ApiError>).status).toBe(0);
    expect((err as Error).message).toContain("timed out");
  });

  test("a caller-initiated cancel is rethrown as-is, not wrapped as a timeout", async () => {
    const controller = new AbortController();
    setFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(makeFetchError()));
        })
    );

    const pending = api("/agents", { signal: controller.signal, timeoutMs: 10_000 }).catch(
      (e) => e
    );
    controller.abort();
    const err = await pending;
    // Our timer never fired (didTimeout false) — the caller cancelled — so
    // the original error propagates unchanged, NOT wrapped as ApiError(0).
    expect(err).not.toBeInstanceOf(ApiError);
    expect((err as Error).message).toContain("aborted");
  });

  test("a caller cancel near the deadline is not misclassified as a timeout (timer disarmed)", async () => {
    // Race guard: the caller aborts, but the abort rejection only reaches
    // the catch a few macrotasks later — long enough that an un-disarmed
    // timer (short timeoutMs) would fire in between and flip didTimeout,
    // mislabeling the cancellation as a timeout. onCallerAbort clears the
    // timer, so didTimeout stays false and the raw cancellation survives.
    const controller = new AbortController();
    setFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            // Delay the rejection well past the timeoutMs so a still-armed
            // timer would have fired by the time the catch runs.
            setTimeout(() => reject(makeFetchError()), 60);
          });
        })
    );

    const pending = api("/agents", { signal: controller.signal, timeoutMs: 10 }).catch((e) => e);
    controller.abort();
    const err = await pending;
    expect(err).not.toBeInstanceOf(ApiError); // not relabeled as ApiError(0) "timed out"
    expect((err as Error).message).toContain("aborted");
  });

  test("an already-aborted caller signal aborts the request immediately", async () => {
    const controller = new AbortController();
    controller.abort();
    let sawAbortedSignal = false;
    setFetch((_url, init) => {
      sawAbortedSignal = init?.signal?.aborted === true;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(makeFetchError()));
        if (init?.signal?.aborted) reject(makeFetchError());
      });
    });

    const err = await api("/agents", { signal: controller.signal }).catch((e) => e);
    expect(sawAbortedSignal).toBe(true);
    // Caller already cancelled before the timer → rethrown raw, not ApiError(0).
    expect(err).not.toBeInstanceOf(ApiError);
  });

  test("a non-timeout fetch rejection (network failure) propagates unchanged", async () => {
    setFetch(async () => {
      throw new TypeError("Network request failed");
    });
    const err = await api("/agents").catch((e) => e);
    expect(err).toBeInstanceOf(TypeError);
    expect(err).not.toBeInstanceOf(ApiError);
  });

  test("a non-ok response throws ApiError carrying the server error message", async () => {
    setFetch(async () => jsonResponse({ error: "nope" }, 403));
    const err = await api("/agents").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as InstanceType<typeof ApiError>).status).toBe(403);
    expect((err as Error).message).toBe("nope");
  });

  test("a non-ok response with no error field falls back to the HTTP status", async () => {
    setFetch(async () => new Response("", { status: 500 }));
    const err = await api("/agents").catch((e) => e);
    expect((err as Error).message).toBe("HTTP 500");
  });

  test("a non-ok runtime-action body surfaces its `message` when there is no `error`", async () => {
    // fill_secret / connector routes reject with { ok: false, message: "..." }
    // rather than { error: "..." }; the actionable text must reach the card
    // instead of a bare "HTTP <status>".
    setFetch(async () => jsonResponse({ ok: false, message: "Browser session expired" }, 409));
    const err = await api("/setup-requests/x/complete", { method: "POST" }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as InstanceType<typeof ApiError>).status).toBe(409);
    expect((err as Error).message).toBe("Browser session expired");
  });

  test("an empty 204 body resolves to null", async () => {
    setFetch(async () => new Response("", { status: 204 }));
    const result = await api("/chat/x/read", { method: "DELETE" });
    expect(result).toBeNull();
  });

  test("missing credentials throws ApiError(401) before any fetch", async () => {
    await clearCredentials();
    let fetched = false;
    setFetch(async () => {
      fetched = true;
      return jsonResponse({});
    });
    const err = await api("/agents").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as InstanceType<typeof ApiError>).status).toBe(401);
    expect(fetched).toBe(false);
  });

  test("a fast response under a large timeoutMs is not aborted", async () => {
    setFetch(async (_url, init) => {
      // The signal should still be live (timer not yet fired) when we answer.
      expect(init?.signal?.aborted).toBe(false);
      return jsonResponse({ ok: true });
    });
    const result = await api<{ ok: boolean }>("/chat/x/messages", {
      method: "POST",
      timeoutMs: 120_000
    });
    expect(result).toEqual({ ok: true });
  });

  test("the default timeout is method-aware: 10s for GET, 20s for writes, explicit wins", async () => {
    // Capture the delay api() arms its abort timer with, without waiting it
    // out. The fetch resolves immediately so the timer is cleared in finally.
    const realSetTimeout = globalThis.setTimeout;
    const armed: number[] = [];
    globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
      // Only record the abort timer api() arms (called with a numeric delay);
      // pass everything through to the real implementation.
      if (typeof ms === "number") armed.push(ms);
      return realSetTimeout(fn, ms, ...rest);
    }) as typeof setTimeout;
    setFetch(async () => jsonResponse({ ok: true }));
    try {
      armed.length = 0;
      await api("/agents"); // no method → GET
      expect(armed).toContain(10_000);

      armed.length = 0;
      await api("/agents/x/use", { method: "POST" });
      expect(armed).toContain(20_000);

      armed.length = 0;
      await api("/chat/x", { method: "DELETE" });
      expect(armed).toContain(20_000);

      armed.length = 0;
      await api("/agents", { timeoutMs: 333 }); // explicit override wins
      expect(armed).toContain(333);
      expect(armed).not.toContain(10_000);

      armed.length = 0;
      await api("/agents", { method: "get" }); // lowercase method still GET
      expect(armed).toContain(10_000);
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });

  test("attaches X-Device-Token when push has a cached token, omits it otherwise", async () => {
    const seen: Array<Record<string, string>> = [];
    setFetch(async (_url, init) => {
      seen.push((init?.headers ?? {}) as Record<string, string>);
      return jsonResponse({});
    });

    deviceToken = null;
    await api("/agents");
    expect(seen[0]?.["X-Device-Token"]).toBeUndefined();

    deviceToken = "apns-123";
    await api("/agents");
    expect(seen[1]?.["X-Device-Token"]).toBe("apns-123");
  });
});

describe("api() helpers", () => {
  test("isUnauthorized is true only for an ApiError with status 401", () => {
    expect(isUnauthorized(new ApiError(401, "x"))).toBe(true);
    expect(isUnauthorized(new ApiError(500, "x"))).toBe(false);
    expect(isUnauthorized(new Error("x"))).toBe(false);
  });

  test("isCredentialRejected distinguishes a rejected token from a missing one", () => {
    // A gateway 401 with no code = the token was presented and refused → drives
    // sign-out + redirect.
    expect(isCredentialRejected(new ApiError(401, "Unauthorized"))).toBe(true);
    // A locally-thrown "no_credentials" 401 = already signed out → ignored so
    // background polls can't re-fire the signed-out redirect in a loop.
    expect(
      isCredentialRejected(new ApiError(401, "No credentials configured", "no_credentials"))
    ).toBe(false);
    // Non-401s and non-ApiErrors are never credential rejections.
    expect(isCredentialRejected(new ApiError(500, "x"))).toBe(false);
    expect(isCredentialRejected(new Error("x"))).toBe(false);
  });

  test("credentialless api() call throws a 401 tagged no_credentials", async () => {
    await clearCredentials();
    const err = await api("/agents").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as InstanceType<typeof ApiError>).code).toBe("no_credentials");
    // The predicate must NOT treat it as a rejection.
    expect(isCredentialRejected(err)).toBe(false);
  });

  test("uploadImage/uploadAudio stream through the native uploader and return the ref", async () => {
    uploadResult = { status: 200, body: JSON.stringify({ id: "u1", mimeType: "image/png", size: 9 }) };
    const img = await uploadImage({ uri: "file:///a.png", name: "a.png", mimeType: "image/png" });
    expect(img).toEqual({ id: "u1", mimeType: "image/png", size: 9 });

    uploadResult = { status: 200, body: JSON.stringify({ id: "u2", mimeType: "audio/wav", size: 4 }) };
    const aud = await uploadAudio({ uri: "file:///a.wav", name: "a.wav", mimeType: "audio/wav" });
    expect(aud.id).toBe("u2");
  });

  test("uploadFile throws ApiError on a non-2xx upload, carrying the server message", async () => {
    uploadResult = { status: 413, body: JSON.stringify({ error: "too big" }) };
    const err = await uploadImage({ uri: "file:///a.png", name: "a.png", mimeType: "image/png" }).catch(
      (e) => e
    );
    expect(err).toBeInstanceOf(ApiError);
    expect((err as InstanceType<typeof ApiError>).status).toBe(413);
    expect((err as Error).message).toBe("too big");
  });

  test("uploadFile falls back to HTTP status when the error body has no error field", async () => {
    uploadResult = { status: 500, body: "" };
    const err = await uploadImage({ uri: "file:///a.png", name: "a.png", mimeType: "image/png" }).catch(
      (e) => e
    );
    expect((err as Error).message).toBe("HTTP 500");
  });

  test("uploadUrl builds an encoded absolute upload URL", () => {
    expect(uploadUrl("a b/c")).toBe("http://127.0.0.1:7421/api/uploads/a%20b%2Fc");
  });

  test("authHeader returns the bearer header when credentials exist", () => {
    expect(authHeader()).toEqual({ Authorization: "Bearer tok" });
  });

  test("authHeader returns an empty object with no credentials", async () => {
    await clearCredentials();
    expect(authHeader()).toEqual({});
  });

  test("fetchWorkspaceFile GETs the encoded files path", async () => {
    let calledUrl = "";
    setFetch(async (url) => {
      calledUrl = url;
      return jsonResponse({ path: "x", name: "x", bytes: 0, content: "", truncated: false, binary: false });
    });
    await fetchWorkspaceFile("dir/x.txt");
    expect(calledUrl).toBe("http://127.0.0.1:7421/api/files?path=dir%2Fx.txt");
  });

  test("fileRawSource builds raw + inline URLs with auth and device-token headers", () => {
    deviceToken = "apns-9";
    const raw = fileRawSource("dir/x.png");
    expect(raw.uri).toBe("http://127.0.0.1:7421/api/files?path=dir%2Fx.png&raw=1");
    expect(raw.headers.authorization).toBe("Bearer tok");
    expect(raw.headers["X-Device-Token"]).toBe("apns-9");

    const inline = fileRawSource("dir/x.png", { inline: true });
    expect(inline.uri).toBe("http://127.0.0.1:7421/api/files?path=dir%2Fx.png&raw=1&inline=1");
  });

  test("fileRawSource throws ApiError(401) with no credentials", async () => {
    await clearCredentials();
    const err = (() => {
      try {
        return fileRawSource("x");
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(ApiError);
    expect((err as InstanceType<typeof ApiError>).status).toBe(401);
  });

  test("uploadRawSource builds the encoded upload URL with auth + device-token headers", () => {
    deviceToken = "apns-7";
    const src = uploadRawSource("up id/01");
    expect(src.uri).toBe("http://127.0.0.1:7421/api/uploads/up%20id%2F01");
    expect(src.headers.authorization).toBe("Bearer tok");
    expect(src.headers["X-Device-Token"]).toBe("apns-7");
  });

  test("uploadRawSource throws ApiError(401) with no credentials", async () => {
    await clearCredentials();
    const err = (() => {
      try {
        return uploadRawSource("up_x");
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(ApiError);
    expect((err as InstanceType<typeof ApiError>).status).toBe(401);
  });

  test("signUploadUrl POSTs to the sign endpoint and returns the absolute signed url", async () => {
    let calledUrl = "";
    let calledMethod = "";
    setFetch(async (url, init) => {
      calledUrl = url;
      calledMethod = (init?.method ?? "GET").toUpperCase();
      return jsonResponse({ path: "/api/uploads/up_1?inline=1&exp=123&sig=abc", exp: 123 });
    });
    const signed = await signUploadUrl("up_1");
    expect(calledMethod).toBe("POST");
    expect(calledUrl).toBe("http://127.0.0.1:7421/api/uploads/up_1/sign");
    // The relative path from the gateway is prefixed with the resolved origin.
    expect(signed).toBe("http://127.0.0.1:7421/api/uploads/up_1?inline=1&exp=123&sig=abc");
  });

  test("signUploadUrl throws ApiError(401) with no credentials", async () => {
    await clearCredentials();
    const err = await signUploadUrl("up_x").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as InstanceType<typeof ApiError>).status).toBe(401);
  });

  test("resolveStreamEndpoint returns the SSE url with auth headers", () => {
    const ep = resolveStreamEndpoint("/chat/s1/stream");
    expect(ep.url).toBe("http://127.0.0.1:7421/api/chat/s1/stream");
    expect(ep.headers.authorization).toBe("Bearer tok");
  });

  test("resolveStreamEndpoint throws ApiError(401) with no credentials", async () => {
    await clearCredentials();
    const err = (() => {
      try {
        return resolveStreamEndpoint("/chat/s1/stream");
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(ApiError);
    expect((err as InstanceType<typeof ApiError>).status).toBe(401);
  });

  test("a public-http base URL is rejected before the bearer is sent", async () => {
    // The `auth` override bypasses the cache and feeds the runtime
    // transport guard directly. A non-local http origin must throw before
    // any fetch so the bearer never leaves the device in cleartext.
    let fetched = false;
    setFetch(async () => {
      fetched = true;
      return jsonResponse({});
    });
    const err = await api("/agents", {
      auth: { baseUrl: "http://evil.example.com", token: "tok" }
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(fetched).toBe(false);
  });

  test("a non-http(s) base URL is rejected as invalid", async () => {
    const err = await api("/agents", {
      auth: { baseUrl: "ftp://127.0.0.1", token: "tok" }
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as Error).message).toContain("invalid");
  });
});

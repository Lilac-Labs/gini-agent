// Tests for the BFF CSRF guard and header forwarding behavior. The guard
// runs on every proxied request and is the trust-boundary check between
// the browser-facing BFF and the bearer-gated gateway.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GATEWAY_UNREACHABLE_CODE } from "./gateway-codes";
import {
  __fileCacheTestHooks,
  __unreachableLogTestHooks,
  canonicalizeSegments,
  guardCsrf,
  pickForwardHeaders,
  proxyRequest,
  runtimeInstance,
  runtimeToken,
  runtimeUrl
} from "./runtime";

const originalTrusted = process.env.GINI_TRUSTED_ORIGINS;

beforeEach(() => {
  delete process.env.GINI_TRUSTED_ORIGINS;
});

afterEach(() => {
  if (originalTrusted === undefined) delete process.env.GINI_TRUSTED_ORIGINS;
  else process.env.GINI_TRUSTED_ORIGINS = originalTrusted;
});

function makeReq(opts: {
  method?: string;
  origin?: string;
  host?: string;
  secFetchSite?: string;
  url?: string;
}): Request {
  const headers = new Headers();
  if (opts.origin !== undefined) headers.set("origin", opts.origin);
  if (opts.host !== undefined) headers.set("host", opts.host);
  if (opts.secFetchSite) headers.set("sec-fetch-site", opts.secFetchSite);
  return new Request(opts.url ?? "http://127.0.0.1:7777/api/runtime/chat", {
    method: opts.method ?? "GET",
    headers
  });
}

describe("guardCsrf — no Origin", () => {
  test("POST + no Origin → 403 (unsafe methods require Origin)", async () => {
    const res = guardCsrf(makeReq({ method: "POST", host: "127.0.0.1:7777" }), []);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });
});

describe("guardCsrf — Origin allowlist", () => {
  test("POST + Origin matching allowlist → pass", () => {
    process.env.GINI_TRUSTED_ORIGINS = "https://allowed.example";
    const res = guardCsrf(
      makeReq({
        method: "POST",
        origin: "https://allowed.example",
        host: "allowed.example",
        url: "https://allowed.example/api/runtime/chat"
      }),
      []
    );
    expect(res).toBeNull();
  });

  test("POST + Origin not in allowlist → 403", () => {
    process.env.GINI_TRUSTED_ORIGINS = "https://allowed.example";
    const res = guardCsrf(
      makeReq({
        method: "POST",
        origin: "https://evil.example",
        host: "evil.example",
        url: "https://evil.example/api/runtime/chat"
      }),
      []
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });
});

describe("guardCsrf — safe methods", () => {
  test("GET with no Origin on loopback Host → pass", () => {
    const res = guardCsrf(makeReq({ method: "GET", host: "127.0.0.1:7777" }), []);
    expect(res).toBeNull();
  });

  test("HEAD with no Origin on loopback Host → pass", () => {
    const res = guardCsrf(makeReq({ method: "HEAD", host: "127.0.0.1:7777" }), []);
    expect(res).toBeNull();
  });
});

describe("guardCsrf — loopback short-circuit (gateway is the single front)", () => {
  // The gateway validates the real Host/Origin and rewrites BOTH to loopback
  // before proxying here, so a loopback Host is trusted even when the operator
  // set GINI_TRUSTED_ORIGINS for the gateway's external origin.
  test("POST + loopback Host + loopback Origin passes even with an allowlist set", () => {
    process.env.GINI_TRUSTED_ORIGINS = "https://allowed.example";
    const res = guardCsrf(
      makeReq({ method: "POST", host: "127.0.0.1:7777", origin: "http://127.0.0.1:7777", url: "http://127.0.0.1:7777/api/runtime/chat" }),
      []
    );
    expect(res).toBeNull();
  });

  test("POST + loopback Host + loopback Origin passes with no allowlist", () => {
    const res = guardCsrf(
      makeReq({ method: "POST", host: "127.0.0.1:7777", origin: "http://127.0.0.1:7777", url: "http://127.0.0.1:7777/api/runtime/chat" }),
      []
    );
    expect(res).toBeNull();
  });

  test("loopback Host + non-loopback Origin (no allowlist) → 403", () => {
    const res = guardCsrf(
      makeReq({ method: "POST", host: "127.0.0.1:7777", origin: "https://evil.example", url: "http://127.0.0.1:7777/api/runtime/chat" }),
      []
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });

  test("loopback Host + malformed Origin → 403", () => {
    const res = guardCsrf(makeReq({ method: "POST", host: "127.0.0.1:7777", origin: "not a url" }), []);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });

  test("non-loopback Host + malformed Origin → 403", () => {
    const res = guardCsrf(
      makeReq({ method: "POST", host: "evil.example", origin: "not a url", url: "https://evil.example/api/runtime/chat" }),
      []
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });
});

describe("guardCsrf — relay-agnostic BFF", () => {
  // The BFF no longer carries a relay lane: the gateway owns relay trust and
  // only ever proxies a loopback Host/Origin to the BFF. A relay Host reaching
  // the BFF directly is therefore refused.
  const SUB = "g3100.gini-relay.lilaclabs.ai";

  test("relay-subdomain Origin POST is refused at the BFF", () => {
    const res = guardCsrf(
      makeReq({ method: "POST", origin: `https://${SUB}`, host: SUB, url: `https://${SUB}/api/runtime/status` }),
      []
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });

  test("relay-subdomain Host no-Origin GET is refused at the BFF", () => {
    const res = guardCsrf(makeReq({ method: "GET", host: SUB, url: `https://${SUB}/api/runtime/status` }), []);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });
});

describe("guardCsrf — Sec-Fetch-Site", () => {
  test("GET on loopback with sec-fetch-site=cross-site → 403", () => {
    const res = guardCsrf(
      makeReq({
        method: "GET",
        host: "127.0.0.1:7777",
        secFetchSite: "cross-site"
      }),
      []
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });

  // The OAuth callback lands as a top-level navigation 302'd from
  // accounts.google.com, which Fetch Metadata stamps cross-site; the
  // gateway's single-use state nonce carries the CSRF defense there.
  test("GET google/login/callback with sec-fetch-site=cross-site → pass (OAuth redirect landing)", () => {
    const res = guardCsrf(
      makeReq({
        method: "GET",
        host: "127.0.0.1:7777",
        secFetchSite: "cross-site",
        url: "http://127.0.0.1:7777/api/runtime/google/login/callback?code=c&state=s"
      }),
      ["google", "login", "callback"]
    );
    expect(res).toBeNull();
  });

  test("the callback exemption is GET-only and exact-path", () => {
    const post = guardCsrf(
      makeReq({
        method: "POST",
        host: "127.0.0.1:7777",
        origin: "http://127.0.0.1:7777",
        secFetchSite: "cross-site",
        url: "http://127.0.0.1:7777/api/runtime/google/login/callback"
      }),
      ["google", "login", "callback"]
    );
    expect(post).not.toBeNull();
    expect(post!.status).toBe(403);
    const otherPath = guardCsrf(
      makeReq({ method: "GET", host: "127.0.0.1:7777", secFetchSite: "cross-site" }),
      ["google", "login", "start"]
    );
    expect(otherPath).not.toBeNull();
    expect(otherPath!.status).toBe(403);
  });
});

describe("proxyRequest — gateway redirects", () => {
  test("a gateway 302 passes through un-followed with only Location forwarded", async () => {
    let seenRedirectMode: RequestRedirect | undefined;
    const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
      seenRedirectMode = init?.redirect;
      return new Response(null, {
        status: 302,
        headers: {
          location: "https://accounts.google.com/o/oauth2/v2/auth?x=1",
          "set-cookie": "hop-local=1"
        }
      });
    }) as unknown as typeof fetch;
    const req = new Request("http://127.0.0.1:7777/api/runtime/google/login/start", {
      method: "GET",
      headers: { host: "127.0.0.1:7777" }
    });
    const res = await proxyRequest(req, ["google", "login", "start"], {
      runtimeUrl: "http://127.0.0.1:9999",
      token: "t",
      fetcher
    });
    expect(seenRedirectMode).toBe("manual");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://accounts.google.com/o/oauth2/v2/auth?x=1");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await res.text()).toBe("");
  });

  test("a 3xx from a non-login route never forwards Location", async () => {
    const fetcher = (async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://evil.example/phish" }
      })) as unknown as typeof fetch;
    const req = new Request("http://127.0.0.1:7777/api/runtime/state", {
      method: "GET",
      headers: { host: "127.0.0.1:7777" }
    });
    const res = await proxyRequest(req, ["state"], {
      runtimeUrl: "http://127.0.0.1:9999",
      token: "t",
      fetcher
    });
    expect(res.headers.get("location")).toBeNull();
  });

  test("a 3xx without a Location still passes the status through", async () => {
    const fetcher = (async () => new Response(null, { status: 304 })) as unknown as typeof fetch;
    const req = new Request("http://127.0.0.1:7777/api/runtime/state", {
      method: "GET",
      headers: { host: "127.0.0.1:7777" }
    });
    const res = await proxyRequest(req, ["state"], {
      runtimeUrl: "http://127.0.0.1:9999",
      token: "t",
      fetcher
    });
    expect(res.status).toBe(304);
    expect(res.headers.get("location")).toBeNull();
  });
});

describe("proxyRequest — served downloads", () => {
  test("attachment text/csv passes through byte-identical (no UTF-8 re-encode)", async () => {
    // Raw bytes including a lone 0xff that a text() decode would mangle into
    // U+FFFD. A served upload carries Content-Disposition: attachment, so the
    // proxy must stream it opaquely.
    const raw = new Uint8Array([0x68, 0x69, 0xff, 0x0a]);
    const fetcher = (async () =>
      new Response(raw, {
        status: 200,
        headers: {
          "content-type": "text/csv",
          "content-disposition": "attachment"
        }
      })) as unknown as typeof fetch;
    const req = new Request("http://127.0.0.1:7777/api/runtime/uploads/abc", {
      method: "GET",
      headers: { host: "127.0.0.1:7777" }
    });
    const res = await proxyRequest(req, ["uploads", "abc"], {
      runtimeUrl: "http://127.0.0.1:9999",
      token: "t",
      fetcher
    });
    expect(res.status).toBe(200);
    const out = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(out)).toEqual(Array.from(raw));
  });
});

describe("proxyRequest — upload size cap", () => {
  test("content-length over the cap returns 413 before forwarding", async () => {
    process.env.GINI_MAX_UPLOAD_BYTES = "10";
    try {
      let forwarded = false;
      const fetcher = (async () => {
        forwarded = true;
        return new Response("{}", { status: 201 });
      }) as unknown as typeof fetch;
      const req = new Request("http://127.0.0.1:7777/api/runtime/uploads", {
        method: "POST",
        headers: {
          host: "127.0.0.1:7777",
          origin: "http://127.0.0.1:7777",
          "content-length": "11",
          "content-type": "multipart/form-data; boundary=x"
        },
        body: "this is more than ten bytes"
      });
      const res = await proxyRequest(req, ["uploads"], {
        runtimeUrl: "http://127.0.0.1:9999",
        token: "t",
        fetcher
      });
      expect(res.status).toBe(413);
      expect(forwarded).toBe(false);
    } finally {
      delete process.env.GINI_MAX_UPLOAD_BYTES;
    }
  });

  test("non-upload POST is not capped (forwards even over the cap)", async () => {
    process.env.GINI_MAX_UPLOAD_BYTES = "10";
    try {
      let forwarded = false;
      const fetcher = (async () => {
        forwarded = true;
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch;
      const req = new Request("http://127.0.0.1:7777/api/runtime/chat/abc/messages", {
        method: "POST",
        headers: {
          host: "127.0.0.1:7777",
          origin: "http://127.0.0.1:7777",
          "content-length": "11",
          "content-type": "application/json"
        },
        body: "this is more than ten bytes"
      });
      const res = await proxyRequest(req, ["chat", "abc", "messages"], {
        runtimeUrl: "http://127.0.0.1:9999",
        token: "t",
        fetcher
      });
      expect(forwarded).toBe(true);
      expect(res.status).toBe(200);
    } finally {
      delete process.env.GINI_MAX_UPLOAD_BYTES;
    }
  });

  test("header-less over-cap upload returns 413 after buffering", async () => {
    process.env.GINI_MAX_UPLOAD_BYTES = "10";
    try {
      let forwarded = false;
      const fetcher = (async () => {
        forwarded = true;
        return new Response("{}", { status: 201 });
      }) as unknown as typeof fetch;
      // A streamed body has no content-length, so the early-reject can't catch
      // it — the post-read buffered-length check must enforce the cap.
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(20).fill(0x41));
          controller.close();
        }
      });
      const req = new Request("http://127.0.0.1:7777/api/runtime/uploads", {
        method: "POST",
        headers: {
          host: "127.0.0.1:7777",
          origin: "http://127.0.0.1:7777",
          "content-type": "application/octet-stream"
        },
        body: stream,
        // @ts-expect-error duplex is required for a stream request body
        duplex: "half"
      });
      expect(req.headers.get("content-length")).toBeNull();
      const res = await proxyRequest(req, ["uploads"], {
        runtimeUrl: "http://127.0.0.1:9999",
        token: "t",
        fetcher
      });
      expect(res.status).toBe(413);
      expect(forwarded).toBe(false);
    } finally {
      delete process.env.GINI_MAX_UPLOAD_BYTES;
    }
  });
});

describe("proxyRequest — gateway unreachable", () => {
  test("a rejecting upstream fetch returns a retryable 503 JSON envelope, not a bare 500", async () => {
    const fetcher = (async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:7778");
    }) as unknown as typeof fetch;
    const req = new Request("http://127.0.0.1:7777/api/runtime/status", {
      method: "GET",
      headers: { host: "127.0.0.1:7777" }
    });
    const res = await proxyRequest(req, ["status"], {
      runtimeUrl: "http://127.0.0.1:9999",
      token: "t",
      fetcher
    });
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("2");
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe(GATEWAY_UNREACHABLE_CODE);
    expect(body.error.length).toBeGreaterThan(0);
  });

  test("the unreachable path logs target + cause once, deduplicating repeats inside the window", async () => {
    __unreachableLogTestHooks.reset();
    const logged: string[] = [];
    const realConsoleError = console.error;
    console.error = ((...args: unknown[]) => {
      logged.push(String(args[0]));
    }) as typeof console.error;
    try {
      const refusedFetcher = (async () => {
        throw new Error("fetch failed", { cause: new Error("connect ECONNREFUSED 127.0.0.1:9999") });
      }) as unknown as typeof fetch;
      const send = () =>
        proxyRequest(
          new Request("http://127.0.0.1:7777/api/runtime/status", { method: "GET", headers: { host: "127.0.0.1:7777" } }),
          ["status"],
          { runtimeUrl: "http://127.0.0.1:9999", token: "t", fetcher: refusedFetcher }
        );
      // A restart window's polling burst: same target, same cause — one line.
      await send();
      await send();
      await send();
      expect(logged.length).toBe(1);
      // The single line carries the load-bearing data: dialed target + errno.
      expect(logged[0]).toContain("http://127.0.0.1:9999/api/status");
      expect(logged[0]).toContain("ECONNREFUSED");

      // A DIFFERENT failure (new cause) logs immediately despite the window.
      const timeoutFetcher = (async () => {
        throw new Error("fetch failed", { cause: new Error("connect ETIMEDOUT 127.0.0.1:9999") });
      }) as unknown as typeof fetch;
      await proxyRequest(
        new Request("http://127.0.0.1:7777/api/runtime/status", { method: "GET", headers: { host: "127.0.0.1:7777" } }),
        ["status"],
        { runtimeUrl: "http://127.0.0.1:9999", token: "t", fetcher: timeoutFetcher }
      );
      expect(logged.length).toBe(2);
      expect(logged[1]).toContain("ETIMEDOUT");
    } finally {
      console.error = realConsoleError;
      __unreachableLogTestHooks.reset();
    }
  });

  test("a client-aborted request rethrows instead of fabricating a 503 for nobody", async () => {
    const fetcher = (async () => {
      throw new Error("aborted");
    }) as unknown as typeof fetch;
    const controller = new AbortController();
    controller.abort();
    const req = new Request("http://127.0.0.1:7777/api/runtime/status", {
      method: "GET",
      headers: { host: "127.0.0.1:7777" }
    });
    await expect(
      proxyRequest(req, ["status"], {
        runtimeUrl: "http://127.0.0.1:9999",
        token: "t",
        fetcher,
        signal: controller.signal
      })
    ).rejects.toThrow("aborted");
  });
});

describe("proxyRequest — SSE passthrough", () => {
  test("a text/event-stream upstream streams through with SSE headers", async () => {
    const fetcher = (async () =>
      new Response("data: hi\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream; charset=utf-8" }
      })) as unknown as typeof fetch;
    const req = new Request("http://127.0.0.1:7777/api/runtime/events/stream", {
      method: "GET",
      headers: { host: "127.0.0.1:7777" }
    });
    const res = await proxyRequest(req, ["events", "stream"], {
      runtimeUrl: "http://127.0.0.1:9999",
      token: "t",
      fetcher
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    expect(await res.text()).toBe("data: hi\n\n");
  });
});

describe("proxyRequest — never forwards a stale content-encoding", () => {
  // The underlying fetch (undici) auto-negotiates Accept-Encoding and
  // transparently decompresses the upstream body before proxyRequest reads it.
  // Forwarding the upstream's content-encoding would label an
  // already-decompressed body as gzip/br, which the browser then fails to
  // decode (ERR_CONTENT_DECODING_FAILED). These pin that the header is dropped
  // on both the JSON/text path and the binary-passthrough path.
  test("JSON path: upstream content-encoding is NOT forwarded to the client", async () => {
    const fetcher = (async () =>
      // Simulates the body undici hands back AFTER decompression: plain JSON
      // text, but the upstream response still advertises content-encoding.
      new Response('{"ok":true}', {
        status: 200,
        headers: { "content-type": "application/json;charset=utf-8", "content-encoding": "br" }
      })) as unknown as typeof fetch;
    const req = new Request("http://127.0.0.1:7777/api/runtime/status", {
      method: "GET",
      headers: { host: "127.0.0.1:7777" }
    });
    const res = await proxyRequest(req, ["status"], {
      runtimeUrl: "http://127.0.0.1:9999",
      token: "t",
      fetcher
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBeNull();
    // Body is intact, decodable plain JSON.
    expect(await res.json()).toEqual({ ok: true });
  });

  test("binary path: upstream content-encoding and content-length are NOT forwarded", async () => {
    const raw = new Uint8Array([0x68, 0x69, 0xff, 0x0a]);
    const fetcher = (async () =>
      new Response(raw, {
        status: 200,
        headers: {
          "content-type": "image/png",
          "content-encoding": "gzip",
          "content-length": "999"
        }
      })) as unknown as typeof fetch;
    const req = new Request("http://127.0.0.1:7777/api/runtime/uploads/x.png", {
      method: "GET",
      headers: { host: "127.0.0.1:7777" }
    });
    const res = await proxyRequest(req, ["uploads", "x.png"], {
      runtimeUrl: "http://127.0.0.1:9999",
      token: "t",
      fetcher
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBeNull();
    // The stale compressed content-length must not be forwarded onto the
    // decompressed stream.
    expect(res.headers.get("content-length")).toBeNull();
    const out = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(out)).toEqual(Array.from(raw));
  });

  test("binary path: a valid content-length IS forwarded when upstream was not encoded", async () => {
    // No upstream content-encoding (the norm, since the BFF sends
    // Accept-Encoding: identity), so the upstream content-length matches the
    // bytes and must be preserved for download/progress metadata.
    const raw = new Uint8Array([0x68, 0x69, 0xff, 0x0a]);
    const fetcher = (async () =>
      new Response(raw, {
        status: 200,
        headers: {
          "content-type": "image/png",
          "content-length": String(raw.byteLength)
        }
      })) as unknown as typeof fetch;
    const req = new Request("http://127.0.0.1:7777/api/runtime/uploads/y.png", {
      method: "GET",
      headers: { host: "127.0.0.1:7777" }
    });
    const res = await proxyRequest(req, ["uploads", "y.png"], {
      runtimeUrl: "http://127.0.0.1:9999",
      token: "t",
      fetcher
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("content-length")).toBe(String(raw.byteLength));
    const out = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(out)).toEqual(Array.from(raw));
  });

  test("sends Accept-Encoding: identity on the loopback hop so the gateway skips compression", async () => {
    // Without this, undici auto-injects gzip/br and the gateway wastes CPU
    // compressing a loopback response the BFF immediately decompresses.
    let seenAcceptEncoding: string | null = "UNSET";
    const fetcher = (async (_url: string, init: RequestInit) => {
      seenAcceptEncoding = new Headers(init.headers).get("accept-encoding");
      return new Response('{"ok":true}', {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as unknown as typeof fetch;
    const req = new Request("http://127.0.0.1:7777/api/runtime/status", {
      method: "GET",
      headers: { host: "127.0.0.1:7777" }
    });
    await proxyRequest(req, ["status"], {
      runtimeUrl: "http://127.0.0.1:9999",
      token: "t",
      fetcher
    });
    expect(seenAcceptEncoding).toBe("identity");
  });
});

describe("canonicalizeSegments", () => {
  test("decodes nested encodings until stable", () => {
    // %2561 → %61 → a (two decode passes).
    expect(canonicalizeSegments(["%2561", "chat"])).toEqual(["a", "chat"]);
  });

  test("rejects traversal, separators, empties, control bytes, and undecodable segments", () => {
    expect(canonicalizeSegments(["%2e%2e"])).toBeNull();
    expect(canonicalizeSegments(["a%2fb"])).toBeNull();
    expect(canonicalizeSegments([""])).toBeNull();
    expect(canonicalizeSegments(["a%00b"])).toBeNull();
    // A lone % cannot decode — refuse rather than guess.
    expect(canonicalizeSegments(["%zz"])).toBeNull();
  });

  test("rejects a segment still decoding at the depth cap", () => {
    // Five nested encodings of "." — still unstable after MAX_DECODE_DEPTH.
    let segment = ".";
    for (let i = 0; i < 6; i += 1) segment = encodeURIComponent(segment).replace(/\./g, "%2e");
    expect(canonicalizeSegments([segment])).toBeNull();
  });
});

describe("runtimeUrl / runtimeToken / runtimeInstance (state-root resolution)", () => {
  let stateRoot: string;
  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = ["GINI_RUNTIME_URL", "GINI_TOKEN", "GINI_STATE_ROOT", "GINI_INSTANCE"] as const;

  beforeEach(() => {
    stateRoot = mkdtempSync(join(tmpdir(), "gini-runtime-test-"));
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.GINI_STATE_ROOT = stateRoot;
    process.env.GINI_INSTANCE = "bff-test";
    __fileCacheTestHooks.clear();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    rmSync(stateRoot, { recursive: true, force: true });
    __fileCacheTestHooks.clear();
  });

  function instanceDir(): string {
    const dir = join(stateRoot, "instances", "bff-test");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  test("runtimeInstance: env override wins, default otherwise", () => {
    expect(runtimeInstance()).toBe("bff-test");
    delete process.env.GINI_INSTANCE;
    expect(runtimeInstance()).toBe("default");
  });

  test("runtimeUrl: GINI_RUNTIME_URL override wins outright", () => {
    process.env.GINI_RUNTIME_URL = "http://127.0.0.1:4242";
    expect(runtimeUrl()).toBe("http://127.0.0.1:4242");
  });

  test("runtimeUrl: reads the recorded port file, falls back to 7778 when absent", () => {
    expect(runtimeUrl()).toBe("http://127.0.0.1:7778");
    writeFileSync(join(instanceDir(), "runtime.port"), "7413\n");
    // The miss above negative-cached the port file; expire it like the TTL would.
    __fileCacheTestHooks.entry(join(instanceDir(), "runtime.port"))!.readAt = 0;
    expect(runtimeUrl()).toBe("http://127.0.0.1:7413");
  });

  test("runtimeUrl: within the cache TTL the port file is not re-read", () => {
    const portPath = join(instanceDir(), "runtime.port");
    writeFileSync(portPath, "7413\n");
    expect(runtimeUrl()).toBe("http://127.0.0.1:7413");
    // A rewrite inside the TTL window is intentionally not observed yet.
    writeFileSync(portPath, "7500\n");
    expect(runtimeUrl()).toBe("http://127.0.0.1:7413");
  });

  test("runtimeUrl: an expired entry with an UNCHANGED mtime refreshes without re-reading", () => {
    const portPath = join(instanceDir(), "runtime.port");
    writeFileSync(portPath, "7413\n");
    expect(runtimeUrl()).toBe("http://127.0.0.1:7413");
    const entry = __fileCacheTestHooks.entry(portPath)!;
    entry.readAt = 0;
    expect(runtimeUrl()).toBe("http://127.0.0.1:7413");
    // The readAt was refreshed in place (cache hit, not a fresh stat+read).
    expect(__fileCacheTestHooks.entry(portPath)!.readAt).toBeGreaterThan(0);
  });

  test("runtimeUrl: an expired entry with a CHANGED mtime re-reads (gateway respawned on a new port)", () => {
    const portPath = join(instanceDir(), "runtime.port");
    writeFileSync(portPath, "7413\n");
    expect(runtimeUrl()).toBe("http://127.0.0.1:7413");
    writeFileSync(portPath, "7500\n");
    const entry = __fileCacheTestHooks.entry(portPath)!;
    entry.readAt = 0;
    entry.mtime = -1;
    expect(runtimeUrl()).toBe("http://127.0.0.1:7500");
  });

  test("runtimeUrl: a whitespace-only port file is treated as absent", () => {
    writeFileSync(join(instanceDir(), "runtime.port"), "   \n");
    expect(runtimeUrl()).toBe("http://127.0.0.1:7778");
  });

  test("runtimeUrl: an unreadable path (directory) is treated as absent", () => {
    mkdirSync(join(instanceDir(), "runtime.port"), { recursive: true });
    expect(runtimeUrl()).toBe("http://127.0.0.1:7778");
  });

  test("runtimeToken: GINI_TOKEN override wins; config token read otherwise", () => {
    process.env.GINI_TOKEN = "env-token";
    expect(runtimeToken()).toBe("env-token");
    delete process.env.GINI_TOKEN;
    writeFileSync(join(instanceDir(), "config.json"), JSON.stringify({ token: "disk-token" }));
    expect(runtimeToken()).toBe("disk-token");
  });

  test("runtimeToken: missing config, non-string token, and invalid JSON all yield empty string", () => {
    expect(runtimeToken()).toBe("");
    writeFileSync(join(instanceDir(), "config.json"), JSON.stringify({ token: 42 }));
    __fileCacheTestHooks.entry(join(instanceDir(), "config.json"))!.readAt = 0;
    expect(runtimeToken()).toBe("");
    writeFileSync(join(instanceDir(), "config.json"), "{not json");
    __fileCacheTestHooks.entry(join(instanceDir(), "config.json"))!.readAt = 0;
    __fileCacheTestHooks.entry(join(instanceDir(), "config.json"))!.mtime = -1;
    expect(runtimeToken()).toBe("");
  });

  test("state root falls back to $HOME/.gini when GINI_STATE_ROOT is unset", () => {
    delete process.env.GINI_STATE_ROOT;
    const savedHome = process.env.HOME;
    process.env.HOME = stateRoot;
    try {
      mkdirSync(join(stateRoot, ".gini", "instances", "bff-test"), { recursive: true });
      writeFileSync(join(stateRoot, ".gini", "instances", "bff-test", "runtime.port"), "7901\n");
      expect(runtimeUrl()).toBe("http://127.0.0.1:7901");
    } finally {
      process.env.HOME = savedHome;
    }
  });
});

describe("pickForwardHeaders", () => {
  test("forwards X-Device-Token so the gateway sees it on /badge + /read", () => {
    const incoming = new Headers({
      "content-type": "application/json",
      "x-device-token": "abc123"
    });
    const forwarded = pickForwardHeaders(incoming);
    expect(forwarded.get("x-device-token")).toBe("abc123");
  });

  test("forwards last-event-id (SSE reconnect dedup)", () => {
    const incoming = new Headers({ "last-event-id": "block_42:170" });
    const forwarded = pickForwardHeaders(incoming);
    expect(forwarded.get("last-event-id")).toBe("block_42:170");
  });

  test("drops headers not in the allowlist (e.g. cookie)", () => {
    const incoming = new Headers({ cookie: "session=secret" });
    const forwarded = pickForwardHeaders(incoming);
    expect(forwarded.get("cookie")).toBeNull();
  });
});

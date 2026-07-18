// Gmail + fixture mail sources, fully offline: HTTP via an injected
// FetchImpl, the gws-export fallback via an injected command (never the real
// gws — that would read real keyring credentials).
import { afterEach, beforeAll, afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  fixtureCrmMailSource,
  gmailCrmMailSource,
  gmailMessageToCrmMail,
  parseAddressList,
  parseGwsExportOutput,
  type FetchImpl,
} from "./crm-mail";

const ROOT = "/tmp/gini-crm-mail-test";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
  process.env.GINI_GMAIL_BACKOFF_MS = "1"; // instant retry ladder in tests
});
afterAll(() => {
  delete process.env.GINI_GMAIL_BACKOFF_MS;
  rmSync(ROOT, { recursive: true, force: true });
});
afterEach(() => {
  delete process.env.GINI_GWS_EXPORT_COMMAND;
  delete process.env.GINI_GWS_EXPORT_TIMEOUT_MS;
});

function b64url(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}

function jsonResponse(doc: unknown, status = 200): Response {
  return new Response(JSON.stringify(doc), { status, headers: { "content-type": "application/json" } });
}

function credsDir(name: string): string {
  const dir = join(ROOT, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "credentials.json"),
    JSON.stringify({ client_id: "cid", client_secret: "cs", refresh_token: "rt" }),
  );
  return dir;
}

describe("parseAddressList", () => {
  test("bracketed, bare, mailto, and display names", () => {
    expect(parseAddressList("Ada Lovelace <ADA@X.io>, bob@y.io")).toEqual([
      { name: "Ada Lovelace", address: "ada@x.io" },
      { address: "bob@y.io" },
    ]);
    expect(parseAddressList("<mailto:c@z.io>")).toEqual([{ address: "c@z.io" }]);
    expect(parseAddressList(undefined)).toEqual([]);
    // A comma inside a quoted display name splits the part; the address is
    // still extracted (only the name half is lost) and the address-less
    // fragment is dropped.
    expect(parseAddressList('"Doe, Jane" <j@x.io>')).toEqual([{ name: "Jane", address: "j@x.io" }]);
  });
});

describe("gmailMessageToCrmMail", () => {
  test("maps headers, nested multipart plain-text body, and dates", () => {
    const mail = gmailMessageToCrmMail({
      id: "m1",
      threadId: "t1",
      internalDate: "5000",
      payload: {
        mimeType: "multipart/alternative",
        headers: [
          { name: "From", value: "Ada <ada@x.io>" },
          { name: "to", value: "b@y.io, Carol <c@z.io>" },
          { name: "Cc", value: "d@w.io" },
          { name: "SUBJECT", value: "Hi" },
        ],
        parts: [
          { mimeType: "text/html", body: { data: b64url("<p>ignored when plain exists</p>") } },
          { mimeType: "multipart/related", parts: [{ mimeType: "text/plain", body: { data: b64url("hello body") } }] },
        ],
      },
    });
    expect(mail).toEqual({
      id: "m1",
      threadId: "t1",
      date: 5000,
      from: { name: "Ada", address: "ada@x.io" },
      to: [{ address: "b@y.io" }, { name: "Carol", address: "c@z.io" }],
      cc: [{ address: "d@w.io" }],
      subject: "Hi",
      body: "hello body",
    });
  });

  test("falls back to stripped HTML, then to the snippet; defaults for a bare doc", () => {
    const htmlOnly = gmailMessageToCrmMail({
      id: "m2",
      payload: {
        mimeType: "text/html",
        body: { data: b64url("<style>x{}</style><script>evil()</script><p>Hi&nbsp;<b>there</b> &amp; &lt;all&gt; &quot;you&#39;</p>") },
      },
    });
    expect(htmlOnly.threadId).toBe("m2"); // threadId defaults to id
    expect(htmlOnly.body).toBe("Hi there & <all> \"you'");
    const snippetOnly = gmailMessageToCrmMail({ id: "m3", snippet: "  snip  " });
    expect(snippetOnly.body).toBe("snip");
    // Parts that exhaust without a text match (attachment-only) fall back too.
    const attachmentsOnly = gmailMessageToCrmMail({
      id: "m3b",
      snippet: "from snippet",
      payload: { mimeType: "multipart/mixed", parts: [{ mimeType: "image/png", body: {} }, { mimeType: "application/pdf", body: {} }] },
    });
    expect(attachmentsOnly.body).toBe("from snippet");
    const bare = gmailMessageToCrmMail({});
    expect(bare).toEqual({ id: "", threadId: "", date: 0, to: [], cc: [], subject: "", body: "" });
  });

  test("caps pathological single-message bodies", () => {
    const mail = gmailMessageToCrmMail({
      id: "m4",
      payload: { mimeType: "text/plain", body: { data: b64url("x".repeat(25_000)) } },
    });
    expect(mail.body.length).toBeLessThan(25_000);
    expect(mail.body.endsWith("…[truncated]")).toBe(true);
  });
});

describe("gmailCrmMailSource", () => {
  test("mints once, pages the list, retries a flaky date fetch, maps threads", async () => {
    let tokenMints = 0;
    let m2DateFailures = 1; // fails once, succeeds on the in-flight retry
    const urls: string[] = [];
    const fetchImpl: FetchImpl = async (url, init) => {
      urls.push(url);
      if (url === TOKEN_URL) {
        tokenMints += 1;
        expect(init?.method).toBe("POST");
        return jsonResponse({ access_token: "tok" });
      }
      expect(init?.headers).toEqual({ Authorization: "Bearer tok" });
      if (url.includes("/messages?") && !url.includes("pageToken")) {
        return jsonResponse({ messages: [{ id: "m1", threadId: "t1" }, { id: "m2" }], nextPageToken: "p2" });
      }
      if (url.includes("pageToken=p2")) {
        return jsonResponse({ messages: [{ id: "m3", threadId: "t1" }, { id: 7 }] });
      }
      if (url.includes("/messages/m1?")) return jsonResponse({ internalDate: "1000" });
      if (url.includes("/messages/m2?")) {
        if (m2DateFailures > 0) {
          m2DateFailures -= 1;
          return jsonResponse(null, 500);
        }
        return jsonResponse({ internalDate: "2000" });
      }
      if (url.includes("/messages/m3?")) return jsonResponse({ internalDate: "3000" });
      if (url.includes("/threads/t1?")) {
        return jsonResponse({
          messages: [{ id: "m1", threadId: "t1", internalDate: "1000", payload: { headers: [{ name: "From", value: "a@x.io" }] } }],
        });
      }
      throw new Error(`unexpected url: ${url}`);
    };
    const source = gmailCrmMailSource({ configDir: credsDir("gmail-ok"), fetchImpl });
    expect(source.kind).toBe("gmail");
    const refs = await source.listMessages();
    expect(refs).toEqual([
      { id: "m1", threadId: "t1", internalDate: 1000 },
      { id: "m2", threadId: "m2", internalDate: 2000 }, // real date via retry — never 0
      { id: "m3", threadId: "t1", internalDate: 3000 },
    ]);
    const thread = await source.fetchThread("t1");
    expect(thread.length).toBe(1);
    expect(thread[0]!.from).toEqual({ address: "a@x.io" });
    // Incremental list carries the after: query; the cached token is reused.
    await source.listMessages(2_000);
    expect(urls.some((u) => u.includes(`q=${encodeURIComponent("after:2")}`))).toBe(true);
    expect(tokenMints).toBe(1);
  });

  test("a persistently failing date fetch fails the poll instead of degrading to date 0", async () => {
    // internalDate 0 can never satisfy the reopen predicate and lets the
    // cursor advance past the real message — the poll must fail (and be
    // retried next interval) rather than silently drop mail.
    const fetchImpl: FetchImpl = async (url) => {
      if (url === TOKEN_URL) return jsonResponse({ access_token: "tok" });
      if (url.includes("/messages?")) return jsonResponse({ messages: [{ id: "m1", threadId: "t1" }] });
      return jsonResponse(null, 503); // every date fetch fails
    };
    const source = gmailCrmMailSource({ configDir: credsDir("gmail-date-dead"), fetchImpl });
    expect(source.listMessages()).rejects.toThrow(/HTTP 503/);
  });

  test("a persistently throttled Gmail call retries the ladder, then surfaces the error", async () => {
    let calls = 0;
    const fetchImpl: FetchImpl = async (url) => {
      if (url === TOKEN_URL) return jsonResponse({ access_token: "tok" });
      calls += 1;
      return jsonResponse({}, 403);
    };
    const source = gmailCrmMailSource({ configDir: credsDir("gmail-403"), fetchImpl });
    await expect(source.listMessages()).rejects.toThrow(/HTTP 403/);
    expect(calls).toBe(6); // full backoff ladder before giving up
  });

  test("rate-limit bursts and transport blips recover mid-ladder", async () => {
    let threadFailures = 2; // two 403s, then success
    let listNetworkFailures = 1; // one rejected fetch, then success
    const fetchImpl: FetchImpl = async (url) => {
      if (url === TOKEN_URL) return jsonResponse({ access_token: "tok" });
      if (url.includes("/messages?")) {
        if (listNetworkFailures > 0) {
          listNetworkFailures -= 1;
          throw new Error("socket hang up");
        }
        return jsonResponse({ messages: [] });
      }
      if (url.includes("/threads/")) {
        if (threadFailures > 0) {
          threadFailures -= 1;
          return jsonResponse({}, 403);
        }
        return jsonResponse({ messages: [{ id: "m1", threadId: "t1", internalDate: "1000" }] });
      }
      throw new Error(`unexpected url: ${url}`);
    };
    const source = gmailCrmMailSource({ configDir: credsDir("gmail-burst"), fetchImpl });
    expect(await source.listMessages()).toEqual([]); // transport blip absorbed
    const thread = await source.fetchThread("t1"); // two 403s absorbed
    expect(thread.length).toBe(1);
    expect(threadFailures).toBe(0);
  });

  test("a persistently dead transport exhausts the ladder and surfaces the original error", async () => {
    let calls = 0;
    const fetchImpl: FetchImpl = async (url) => {
      if (url === TOKEN_URL) return jsonResponse({ access_token: "tok" });
      calls += 1;
      throw new Error("connection refused");
    };
    const source = gmailCrmMailSource({ configDir: credsDir("gmail-dead"), fetchImpl });
    await expect(source.fetchThread("t1")).rejects.toThrow(/connection refused/);
    expect(calls).toBe(6);
  });

  test("a definitive Gmail status fails immediately without retries", async () => {
    let calls = 0;
    const fetchImpl: FetchImpl = async (url) => {
      if (url === TOKEN_URL) return jsonResponse({ access_token: "tok" });
      calls += 1;
      return jsonResponse({}, 404);
    };
    const source = gmailCrmMailSource({ configDir: credsDir("gmail-404"), fetchImpl });
    await expect(source.fetchThread("gone")).rejects.toThrow(/HTTP 404/);
    expect(calls).toBe(1);
  });

  test("token mint failures: HTTP error, missing token, transport error", async () => {
    const cases: FetchImpl[] = [
      async () => jsonResponse({}, 500),
      async () => jsonResponse({}),
      async () => {
        throw new Error("network down");
      },
    ];
    for (const [i, fetchImpl] of cases.entries()) {
      const source = gmailCrmMailSource({ configDir: credsDir(`gmail-mint-${i}`), fetchImpl });
      expect(source.listMessages()).rejects.toThrow(/Could not mint/);
    }
  });

  test("no credentials anywhere → the connect-account error", async () => {
    process.env.GINI_GWS_EXPORT_COMMAND = "echo no-json-here";
    const dir = join(ROOT, "gmail-empty");
    mkdirSync(dir, { recursive: true });
    const source = gmailCrmMailSource({ configDir: dir, fetchImpl: async () => jsonResponse({}) });
    expect(source.listMessages()).rejects.toThrow(/No Google credentials/);
  });

  test("parseGwsExportOutput: preamble skip, shape rejection, broken JSON, no JSON", () => {
    // The parse rules are pure so they hold regardless of how the export ran.
    expect(
      parseGwsExportOutput('Exporting credentials...\n{"client_id":"gc","client_secret":"gs","refresh_token":"gr"}\n'),
    ).toEqual({ clientId: "gc", clientSecret: "gs", refreshToken: "gr" });
    expect(parseGwsExportOutput('{"client_id":5,"client_secret":"s","refresh_token":"r"}')).toBeUndefined();
    expect(parseGwsExportOutput('{"client_id":"c","client_secret":"","refresh_token":"r"}')).toBeUndefined();
    expect(parseGwsExportOutput('{"client_id":"c","client_secret":"s"}')).toBeUndefined();
    expect(parseGwsExportOutput("{broken")).toBeUndefined();
    expect(parseGwsExportOutput("no json here")).toBeUndefined();
    expect(parseGwsExportOutput("")).toBeUndefined();
  });

  test("gws export spawn: unusable output and timeouts degrade to the connect-account error", async () => {
    const dir = join(ROOT, "gmail-gws-bad");
    mkdirSync(dir, { recursive: true });
    const fetchImpl: FetchImpl = async () => jsonResponse({ access_token: "tok" });
    // An export that prints no JSON (also what a missing gws binary looks
    // like) → no credentials.
    process.env.GINI_GWS_EXPORT_COMMAND = "echo no-json-here";
    expect(gmailCrmMailSource({ configDir: dir, fetchImpl }).listMessages()).rejects.toThrow(/No Google credentials/);
    // A hanging export is killed at the timeout (configDir undefined also
    // covers the no-config-dir env branch).
    process.env.GINI_GWS_EXPORT_COMMAND = "sleep 5";
    process.env.GINI_GWS_EXPORT_TIMEOUT_MS = "50";
    expect(gmailCrmMailSource({ configDir: undefined, fetchImpl }).listMessages()).rejects.toThrow(/No Google credentials/);
  });

  test("credentials.json with a missing field or malformed JSON falls through cleanly", async () => {
    const dir = join(ROOT, "gmail-partial");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "credentials.json"), JSON.stringify({ client_id: "cid", client_secret: "cs" }));
    process.env.GINI_GWS_EXPORT_COMMAND = "echo nope";
    const source = gmailCrmMailSource({ configDir: dir, fetchImpl: async () => jsonResponse({}) });
    expect(source.listMessages()).rejects.toThrow(/No Google credentials/);
    const badDir = join(ROOT, "gmail-malformed");
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, "credentials.json"), "not json at all");
    const badSource = gmailCrmMailSource({ configDir: badDir, fetchImpl: async () => jsonResponse({}) });
    expect(badSource.listMessages()).rejects.toThrow(/No Google credentials/);
  });

  test("a spawn failure in the gws fallback degrades to the connect-account error", async () => {
    // A NUL byte in the config dir makes the spawn env invalid → spawn
    // throws → the fallback swallows it and reports no credentials.
    const source = gmailCrmMailSource({ configDir: "bad\0dir", fetchImpl: async () => jsonResponse({}) });
    expect(source.listMessages()).rejects.toThrow(/No Google credentials/);
  });
});

describe("fixtureCrmMailSource", () => {
  test("lists with an afterMs filter, fetches threads, reloads the file per call", async () => {
    const dir = join(ROOT, "fixture");
    mkdirSync(dir, { recursive: true });
    const m1 = { id: "f1", threadId: "ft1", date: 1_000, to: [], cc: [], subject: "s1", body: "b1" };
    const m2 = { id: "f2", threadId: "ft2", date: 3_000, to: [], cc: [], subject: "s2", body: "b2" };
    writeFileSync(join(dir, "messages.json"), JSON.stringify([m1, m2]));
    const source = fixtureCrmMailSource(dir);
    expect(source.kind).toBe("fixture");
    expect(await source.listMessages()).toEqual([
      { id: "f1", threadId: "ft1", internalDate: 1_000 },
      { id: "f2", threadId: "ft2", internalDate: 3_000 },
    ]);
    expect(await source.listMessages(2_000)).toEqual([{ id: "f2", threadId: "ft2", internalDate: 3_000 }]);
    expect(await source.fetchThread("ft1")).toEqual([m1]);
    // New mail lands in the file → the next call sees it (the watcher's view).
    const m3 = { id: "f3", threadId: "ft1", date: 4_000, to: [], cc: [], subject: "s3", body: "b3" };
    writeFileSync(join(dir, "messages.json"), JSON.stringify([m1, m2, m3]));
    expect((await source.fetchThread("ft1")).length).toBe(2);
  });
});

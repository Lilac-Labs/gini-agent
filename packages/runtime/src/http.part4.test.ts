import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import "./hooks/builtins"; // the email-watch routes provision a backing job, which validates isKnownHook("skill-script")
import { createHandler, resolveInlineUpload } from "./http";
import { logDir, uploadsDir, webPortPath } from "./paths";
import { clearWebTargetCache } from "./web-target";
import { dirname, join } from "node:path";
import { addAudit, appendEvent, insertChatBlock, isPlausibleMime, mutateState, readState, readTrace, recordProviderAuthFailure, sanitizeFilename, storeUpload, uploadStat } from "./state";
import { getOrCreateAgentChat } from "./execution/chat";
import { createScheduledJob } from "./jobs";
import { removeMemoryDb } from "./state/memory-db";
import { listProviders } from "./integrations/connectors/registry";
import { resetGoogleLoginWebState } from "./integrations/connectors/google-login-web";
import { awaitTunnelSettled, setTunnelDeps, type TunnelChild } from "./integrations/tunnel";
import type { RuntimeConfig } from "./types";
import type { LoginHandle, RelayDefaults, Session, Store, TunnelOptions } from "gini-relay";

// Stub a provider's host-environment `detect()` so the connector-detection
// endpoint test stays deterministic AND fast regardless of what's installed
// on the developer's PATH. The production `detect()` for claude-code / codex
// shells out via spawnSync (`which`, `claude auth status`), which on a machine
// with those CLIs installed dominates this test's wall time (the unstubbed
// detect endpoint test measured 1.524641s). Mirrors the same in-place
// swap-and-restore helper used by src/jobs/connector-detection.test.ts. The
// registry is a process-wide singleton, so the returned restore fn MUST run in
// a finally to avoid leaking the stub into sibling tests.
function stubProviderDetect(
  providerId: string,
  value: { detected: boolean; suggestedName?: string; message?: string }
): () => void {
  const provider = listProviders().find((p) => p.id === providerId);
  if (!provider) throw new Error(`Provider not registered: ${providerId}`);
  const previous = provider.detect;
  provider.detect = async () => value;
  return () => {
    provider.detect = previous;
  };
}

// Companion to stubProviderDetect. After connector auto-detection creates a
// record for a provider that exposes a `probe()`, runConnectorDetection runs
// an initial checkConnector → provider.probe, which for claude-code shells out
// to `claude auth status` again. Stub the probe so the detection endpoint
// test never touches a real subprocess. Same swap-and-restore discipline.
function stubProviderProbe(providerId: string, value: { ok: boolean; message: string }): () => void {
  const provider = listProviders().find((p) => p.id === providerId);
  if (!provider) throw new Error(`Provider not registered: ${providerId}`);
  const previous = provider.probe;
  provider.probe = async () => value;
  return () => {
    provider.probe = previous;
  };
}

describe("GET /api/files", () => {
  test("returns content, absolute path, and name for an existing text file", async () => {
    const config = testConfig("files-read-ok");
    const workspace = `/tmp/gini-files-test-${Date.now()}`;
    mkdirSync(workspace, { recursive: true });
    config.workspaceRoot = workspace;
    writeFileSync(`${workspace}/note.md`, "# Hello\n");
    const handler = createHandler(config);

    const file = await call(handler, config, "/api/files?path=note.md");
    expect(file.name).toBe("note.md");
    expect(file.absolutePath).toBe(`${workspace}/note.md`);
    expect(file.content).toBe("# Hello\n");
    expect(file.binary).toBe(false);
    expect(file.truncated).toBe(false);

    rmSync(workspace, { recursive: true, force: true });
  });

  test("rejects a path that escapes the workspace with 400", async () => {
    const config = testConfig("files-escape-400");
    const workspace = `/tmp/gini-files-test-${Date.now()}-escape`;
    mkdirSync(workspace, { recursive: true });
    config.workspaceRoot = workspace;
    const handler = createHandler(config);

    const response = await rawCall(handler, config, "/api/files?path=../outside.txt", {}, config.token);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("outside workspace");

    rmSync(workspace, { recursive: true, force: true });
  });

  test("returns 404 for a non-existent file", async () => {
    const config = testConfig("files-missing-404");
    const workspace = `/tmp/gini-files-test-${Date.now()}-missing`;
    mkdirSync(workspace, { recursive: true });
    config.workspaceRoot = workspace;
    const handler = createHandler(config);

    const response = await rawCall(handler, config, "/api/files?path=nope.txt", {}, config.token);
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe("File not found");

    rmSync(workspace, { recursive: true, force: true });
  });

  test("reports a binary file without returning its content", async () => {
    const config = testConfig("files-binary");
    const workspace = `/tmp/gini-files-test-${Date.now()}-binary`;
    mkdirSync(workspace, { recursive: true });
    config.workspaceRoot = workspace;
    writeFileSync(`${workspace}/blob.bin`, Buffer.from([0x89, 0x50, 0x00, 0x01]));
    const handler = createHandler(config);

    const file = await call(handler, config, "/api/files?path=blob.bin");
    expect(file.binary).toBe(true);
    expect(file.content).toBe(null);
    expect(file.bytes).toBe(4);

    rmSync(workspace, { recursive: true, force: true });
  });

  test("returns 400 for a directory", async () => {
    const config = testConfig("files-directory");
    const workspace = `/tmp/gini-files-test-${Date.now()}-directory`;
    mkdirSync(workspace, { recursive: true });
    config.workspaceRoot = workspace;
    mkdirSync(`${workspace}/sub`);
    const handler = createHandler(config);

    const response = await rawCall(handler, config, "/api/files?path=sub", {}, config.token);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("Not a file");

    rmSync(workspace, { recursive: true, force: true });
  });

  test("truncates a file larger than the read cap", async () => {
    const config = testConfig("files-truncate");
    const workspace = `/tmp/gini-files-test-${Date.now()}-truncate`;
    mkdirSync(workspace, { recursive: true });
    config.workspaceRoot = workspace;
    writeFileSync(`${workspace}/big.txt`, "a".repeat(600 * 1024));
    const handler = createHandler(config);

    const file = await call(handler, config, "/api/files?path=big.txt");
    expect(file.truncated).toBe(true);
    expect(file.content.length).toBe(512 * 1024);
    expect(file.bytes).toBe(600 * 1024);

    rmSync(workspace, { recursive: true, force: true });
  });

  test("raw=1 streams the file as a download attachment", async () => {
    const config = testConfig("files-raw");
    const workspace = `/tmp/gini-files-test-${Date.now()}-raw`;
    mkdirSync(workspace, { recursive: true });
    config.workspaceRoot = workspace;
    writeFileSync(`${workspace}/note.md`, "# Hello\nworld\n");
    const handler = createHandler(config);

    const response = await rawCall(handler, config, "/api/files?path=note.md&raw=1", {}, config.token);
    expect(response.status).toBe(200);
    const disposition = response.headers.get("content-disposition") ?? "";
    expect(disposition).toContain("attachment");
    expect(disposition).toContain("note.md");
    expect(await response.text()).toBe("# Hello\nworld\n");

    rmSync(workspace, { recursive: true, force: true });
  });

  test("raw=1 download for a non-ASCII filename returns 200 with both header forms", async () => {
    const config = testConfig("files-raw-unicode");
    const workspace = `/tmp/gini-files-test-${Date.now()}-raw-unicode`;
    mkdirSync(workspace, { recursive: true });
    config.workspaceRoot = workspace;
    writeFileSync(`${workspace}/café.md`, "# Hello\n");
    const handler = createHandler(config);

    const response = await rawCall(handler, config, `/api/files?path=${encodeURIComponent("café.md")}&raw=1`, {}, config.token);
    expect(response.status).toBe(200);
    const disposition = response.headers.get("content-disposition") ?? "";
    expect(disposition).toContain(`filename="caf_.md"`);
    expect(disposition).toContain("filename*=UTF-8''");

    rmSync(workspace, { recursive: true, force: true });
  });

  test("inline=1 serves a PDF inline with the application/pdf content-type", async () => {
    const config = testConfig("files-inline-pdf");
    const workspace = `/tmp/gini-files-test-${Date.now()}-inline-pdf`;
    mkdirSync(workspace, { recursive: true });
    config.workspaceRoot = workspace;
    writeFileSync(`${workspace}/doc.pdf`, Buffer.from("%PDF-1.4\n"));
    const handler = createHandler(config);

    const response = await rawCall(handler, config, "/api/files?path=doc.pdf&raw=1&inline=1", {}, config.token);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-disposition")).toBe("inline");

    rmSync(workspace, { recursive: true, force: true });
  });

  test("inline=1 serves a PNG inline with the image/png content-type", async () => {
    const config = testConfig("files-inline-png");
    const workspace = `/tmp/gini-files-test-${Date.now()}-inline-png`;
    mkdirSync(workspace, { recursive: true });
    config.workspaceRoot = workspace;
    writeFileSync(`${workspace}/pic.png`, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const handler = createHandler(config);

    const response = await rawCall(handler, config, "/api/files?path=pic.png&raw=1&inline=1", {}, config.token);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-disposition")).toBe("inline");

    rmSync(workspace, { recursive: true, force: true });
  });

  test("inline=1 never serves an SVG inline — falls back to attachment download", async () => {
    const config = testConfig("files-inline-svg");
    const workspace = `/tmp/gini-files-test-${Date.now()}-inline-svg`;
    mkdirSync(workspace, { recursive: true });
    config.workspaceRoot = workspace;
    writeFileSync(`${workspace}/evil.svg`, "<svg onload=\"alert(1)\"></svg>");
    const handler = createHandler(config);

    const response = await rawCall(handler, config, "/api/files?path=evil.svg&raw=1&inline=1", {}, config.token);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("content-disposition") ?? "").toContain("attachment");

    rmSync(workspace, { recursive: true, force: true });
  });

  test("inline=1 never serves HTML inline — falls back to attachment download", async () => {
    const config = testConfig("files-inline-html");
    const workspace = `/tmp/gini-files-test-${Date.now()}-inline-html`;
    mkdirSync(workspace, { recursive: true });
    config.workspaceRoot = workspace;
    writeFileSync(`${workspace}/evil.html`, "<script>alert(1)</script>");
    const handler = createHandler(config);

    const response = await rawCall(handler, config, "/api/files?path=evil.html&raw=1&inline=1", {}, config.token);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("content-disposition") ?? "").toContain("attachment");

    rmSync(workspace, { recursive: true, force: true });
  });

  // The upload gate accepts any plausible MIME, not just images/audio. These
  // build the multipart request directly (not via call/rawCall, which pin
  // content-type: application/json) so FormData sets its own multipart
  // boundary header.
  test("POST /api/uploads accepts an application/pdf file and serves it back", async () => {
    const config = testConfig("uploads-pdf");
    const handler = createHandler(config);
    const form = new FormData();
    form.set("file", new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], "report.pdf", { type: "application/pdf" }));
    const response = await handler(new Request(`http://127.0.0.1:${config.port}/api/uploads`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.token}` },
      body: form
    }));
    expect(response.status).toBe(201);
    const ref = await response.json();
    expect(ref.mimeType).toBe("application/pdf");

    const fetched = await rawCall(handler, config, `/api/uploads/${ref.id}`, {}, config.token);
    expect(fetched.status).toBe(200);
    expect(fetched.headers.get("content-type")).toBe("application/pdf");
    // Arbitrary MIME is accepted, so served uploads are forced to download and
    // never sniffed — a text/html or SVG upload can't execute on the app origin.
    expect(fetched.headers.get("content-disposition")).toBe("attachment");
    expect(fetched.headers.get("x-content-type-options")).toBe("nosniff");
    // The full-body response advertises range support so a media client knows
    // it may stream via byte ranges (iOS AVPlayer requires this to play remote
    // audio at all).
    expect(fetched.headers.get("accept-ranges")).toBe("bytes");
  });

  // `?inline=1` opts a safe-allowlisted upload into content-disposition: inline
  // so a file/PDF chip can open it as a preview in a browser tab instead of
  // forcing a download. These pin the per-mime allowlist decisions (the SSRF /
  // top-level-script surface lives in the unsafe branches).
  test("GET /api/uploads?inline=1 serves a PDF inline with its real type", async () => {
    const config = testConfig("uploads-inline-pdf");
    const handler = createHandler(config);
    const ref = storeUpload(config.instance, new Uint8Array([0x25, 0x50, 0x44, 0x46]), "application/pdf", "report.pdf");
    const res = await rawCall(handler, config, `/api/uploads/${ref.id}?inline=1`, {}, config.token);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe("inline");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("GET /api/uploads?inline=1 serves a PNG inline with its real type", async () => {
    const config = testConfig("uploads-inline-png");
    const handler = createHandler(config);
    const ref = storeUpload(config.instance, new Uint8Array([0x89, 0x50, 0x4e, 0x47]), "image/png", "shot.png");
    const res = await rawCall(handler, config, `/api/uploads/${ref.id}?inline=1`, {}, config.token);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-disposition")).toBe("inline");
  });

  test("GET /api/uploads?inline=1 coerces a markdown upload to text/plain inline", async () => {
    const config = testConfig("uploads-inline-md");
    const handler = createHandler(config);
    const ref = storeUpload(config.instance, new TextEncoder().encode("# Title\n"), "text/markdown", "notes.md");
    const res = await rawCall(handler, config, `/api/uploads/${ref.id}?inline=1`, {}, config.token);
    expect(res.status).toBe(200);
    // Coerced to text/plain so the browser shows raw text rather than
    // interpreting/executing the payload as a document.
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe("inline");
  });

  test("GET /api/uploads?inline=1 never serves an SVG inline — keeps attachment", async () => {
    const config = testConfig("uploads-inline-svg");
    const handler = createHandler(config);
    const ref = storeUpload(config.instance, new TextEncoder().encode("<svg/>"), "image/svg+xml", "x.svg");
    const res = await rawCall(handler, config, `/api/uploads/${ref.id}?inline=1`, {}, config.token);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    expect(res.headers.get("content-disposition")).toBe("attachment");
  });

  test("GET /api/uploads?inline=1 never serves HTML inline — keeps attachment", async () => {
    const config = testConfig("uploads-inline-html");
    const handler = createHandler(config);
    const ref = storeUpload(config.instance, new TextEncoder().encode("<h1>x</h1>"), "text/html", "x.html");
    const res = await rawCall(handler, config, `/api/uploads/${ref.id}?inline=1`, {}, config.token);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe("attachment");
  });

  test("resolveInlineUpload returns null without the inline param and gates by mime", () => {
    // No inline param → always download, regardless of a safe mime.
    expect(resolveInlineUpload(null, "application/pdf")).toBeNull();
    expect(resolveInlineUpload("", "application/pdf")).toBeNull();
    // Safe direct image/pdf → its own type.
    expect(resolveInlineUpload("1", "application/pdf")).toEqual({ contentType: "application/pdf" });
    expect(resolveInlineUpload("1", "image/jpeg")).toEqual({ contentType: "image/jpeg" });
    // Text-like → coerced to text/plain.
    expect(resolveInlineUpload("1", "text/csv")).toEqual({ contentType: "text/plain; charset=utf-8" });
    expect(resolveInlineUpload("1", "application/json")).toEqual({ contentType: "text/plain; charset=utf-8" });
    // Unsafe / unknown → null (download).
    expect(resolveInlineUpload("1", "image/svg+xml")).toBeNull();
    expect(resolveInlineUpload("1", "text/html")).toBeNull();
    expect(resolveInlineUpload("1", "application/octet-stream")).toBeNull();
  });

  // A mobile in-app browser can't send the bearer header or the gateway cookie,
  // so the app mints a short-lived SIGNED url (POST /api/uploads/:id/sign) and
  // opens that. These pin: the mint is bearer-gated, the signed url authorizes a
  // header-less GET, and the signature is scoped + expiring.
  test("POST /api/uploads/:id/sign mints a signed path that authorizes a header-less GET", async () => {
    const config = testConfig("uploads-sign-ok");
    const handler = createHandler(config);
    const ref = storeUpload(config.instance, new Uint8Array([0x25, 0x50, 0x44, 0x46]), "application/pdf", "report.pdf");

    const minted = await rawCall(handler, config, `/api/uploads/${ref.id}/sign`, { method: "POST" }, config.token);
    expect(minted.status).toBe(200);
    const body = await minted.json();
    expect(body.path).toContain(`/api/uploads/${ref.id}?inline=1`);
    expect(body.path).toMatch(/[?&]exp=\d+/);
    expect(body.path).toMatch(/[?&]sig=[0-9a-f]{64}/);
    expect(typeof body.exp).toBe("number");

    // The signed path authorizes a GET with NO Authorization header.
    const got = await rawCall(handler, config, body.path, {});
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toBe("application/pdf");
    expect(got.headers.get("content-disposition")).toBe("inline");
  });

  test("the mint endpoint itself still requires a bearer", async () => {
    const config = testConfig("uploads-sign-gated");
    const handler = createHandler(config);
    const ref = storeUpload(config.instance, new Uint8Array([1, 2, 3]), "application/pdf", "x.pdf");
    const res = await rawCall(handler, config, `/api/uploads/${ref.id}/sign`, { method: "POST" }); // no token
    expect(res.status).toBe(401);
  });

  test("signing an unknown upload id returns 404 (no signature for absent bytes)", async () => {
    const config = testConfig("uploads-sign-404");
    const handler = createHandler(config);
    const res = await rawCall(handler, config, `/api/uploads/does-not-exist/sign`, { method: "POST" }, config.token);
    expect(res.status).toBe(404);
  });

  test("an unsigned, unauthenticated upload GET is rejected 401", async () => {
    const config = testConfig("uploads-sign-unsigned");
    const handler = createHandler(config);
    const ref = storeUpload(config.instance, new Uint8Array([1, 2, 3]), "application/pdf", "x.pdf");
    const res = await rawCall(handler, config, `/api/uploads/${ref.id}?inline=1`, {}); // no token, no sig
    expect(res.status).toBe(401);
  });

  test("a tampered upload id on a signed url fails (signature is scoped to one id)", async () => {
    const config = testConfig("uploads-sign-scope");
    const handler = createHandler(config);
    const a = storeUpload(config.instance, new Uint8Array([1, 2, 3]), "application/pdf", "a.pdf");
    const b = storeUpload(config.instance, new Uint8Array([4, 5, 6]), "application/pdf", "b.pdf");
    const minted = await rawCall(handler, config, `/api/uploads/${a.id}/sign`, { method: "POST" }, config.token);
    const { path } = await minted.json();
    // Swap a's id for b's id but keep a's signature → must fail.
    const sig = new URL(`http://x${path}`).searchParams.get("sig");
    const exp = new URL(`http://x${path}`).searchParams.get("exp");
    const forged = `/api/uploads/${b.id}?inline=1&exp=${exp}&sig=${sig}`;
    const res = await rawCall(handler, config, forged, {});
    expect(res.status).toBe(401);
  });

  test("an expired signature is rejected 401", async () => {
    const config = testConfig("uploads-sign-expired");
    const handler = createHandler(config);
    const ref = storeUpload(config.instance, new Uint8Array([1, 2, 3]), "application/pdf", "x.pdf");
    // Mint with the minimum TTL clamp (30s), then forge an already-past exp by
    // re-signing with a past timestamp using the same module the gateway uses.
    const pastExp = Math.floor(Date.now() / 1000) - 10;
    const { signUploadParams } = await import("./lib/upload-signing");
    const { sig } = signUploadParams(config.token, ref.id, pastExp);
    const res = await rawCall(handler, config, `/api/uploads/${ref.id}?inline=1&exp=${pastExp}&sig=${sig}`, {});
    expect(res.status).toBe(401);
  });

  test("a caller-supplied ?ttl= is honored and clamped to the [30,600]s ceiling", async () => {
    const config = testConfig("uploads-sign-ttl");
    const handler = createHandler(config);
    const ref = storeUpload(config.instance, new Uint8Array([0x25, 0x50, 0x44, 0x46]), "application/pdf", "x.pdf");

    // An in-range ttl rides through unchanged; an over-max one clamps to 600.
    // The exp the mint returns is now + clampedTtl, so assert exp lands within a
    // small window of that target (a couple seconds for clock drift across the call).
    const now = Math.floor(Date.now() / 1000);
    const inRange = await rawCall(handler, config, `/api/uploads/${ref.id}/sign?ttl=120`, { method: "POST" }, config.token);
    expect(inRange.status).toBe(200);
    expect((await inRange.json()).exp - now).toBeLessThanOrEqual(122);

    const clamped = await rawCall(handler, config, `/api/uploads/${ref.id}/sign?ttl=99999`, { method: "POST" }, config.token);
    expect(clamped.status).toBe(200);
    const clampedExp = (await clamped.json()).exp - Math.floor(Date.now() / 1000);
    expect(clampedExp).toBeGreaterThan(595);
    expect(clampedExp).toBeLessThanOrEqual(600);
  });

  test("a signed HEAD is also authorized (in-app browser preflight)", async () => {
    const config = testConfig("uploads-sign-head");
    const handler = createHandler(config);
    const ref = storeUpload(config.instance, new Uint8Array([0x25, 0x50, 0x44, 0x46]), "application/pdf", "x.pdf");
    const minted = await rawCall(handler, config, `/api/uploads/${ref.id}/sign`, { method: "POST" }, config.token);
    const { path } = await minted.json();
    const res = await rawCall(handler, config, path, { method: "HEAD" });
    expect(res.status).toBe(200);
  });

  // iOS AVPlayer won't start a remote audio AVURLAsset unless the server honors
  // Range requests (206 + Content-Range). These pin the range semantics of the
  // upload GET so a regression can't silently break voice-message playback.
  test("GET /api/uploads honors a bounded Range with 206 + Content-Range", async () => {
    const config = testConfig("uploads-range-bounded");
    const handler = createHandler(config);
    const bytes = new Uint8Array(Array.from({ length: 100 }, (_, i) => i));
    const ref = storeUpload(config.instance, bytes, "audio/wav");

    const res = await rawCall(handler, config, `/api/uploads/${ref.id}`, {
      headers: { range: "bytes=0-9" }
    }, config.token);
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 0-9/100");
    expect(res.headers.get("content-length")).toBe("10");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    const body = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(body)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  test("GET /api/uploads serves a mid-file Range slice with exact bytes", async () => {
    const config = testConfig("uploads-range-mid");
    const handler = createHandler(config);
    const bytes = new Uint8Array(Array.from({ length: 100 }, (_, i) => i));
    const ref = storeUpload(config.instance, bytes, "audio/wav");

    const res = await rawCall(handler, config, `/api/uploads/${ref.id}`, {
      headers: { range: "bytes=10-19" }
    }, config.token);
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 10-19/100");
    const body = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(body)).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  });

  test("GET /api/uploads clamps an over-long Range end to the last byte", async () => {
    const config = testConfig("uploads-range-clamp");
    const handler = createHandler(config);
    const bytes = new Uint8Array(Array.from({ length: 50 }, (_, i) => i));
    const ref = storeUpload(config.instance, bytes, "audio/wav");

    const res = await rawCall(handler, config, `/api/uploads/${ref.id}`, {
      headers: { range: "bytes=40-999" }
    }, config.token);
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 40-49/50");
    expect(res.headers.get("content-length")).toBe("10");
  });

  test("GET /api/uploads serves an open-ended Range to EOF", async () => {
    const config = testConfig("uploads-range-open");
    const handler = createHandler(config);
    const bytes = new Uint8Array(Array.from({ length: 50 }, (_, i) => i));
    const ref = storeUpload(config.instance, bytes, "audio/wav");

    const res = await rawCall(handler, config, `/api/uploads/${ref.id}`, {
      headers: { range: "bytes=48-" }
    }, config.token);
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 48-49/50");
    const body = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(body)).toEqual([48, 49]);
  });

  test("GET /api/uploads serves a suffix Range (last N bytes)", async () => {
    const config = testConfig("uploads-range-suffix");
    const handler = createHandler(config);
    const bytes = new Uint8Array(Array.from({ length: 50 }, (_, i) => i));
    const ref = storeUpload(config.instance, bytes, "audio/wav");

    const res = await rawCall(handler, config, `/api/uploads/${ref.id}`, {
      headers: { range: "bytes=-5" }
    }, config.token);
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 45-49/50");
    const body = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(body)).toEqual([45, 46, 47, 48, 49]);
  });

  test("GET /api/uploads returns 416 for a Range starting past EOF", async () => {
    const config = testConfig("uploads-range-416");
    const handler = createHandler(config);
    const bytes = new Uint8Array(Array.from({ length: 50 }, (_, i) => i));
    const ref = storeUpload(config.instance, bytes, "audio/wav");

    const res = await rawCall(handler, config, `/api/uploads/${ref.id}`, {
      headers: { range: "bytes=999-" }
    }, config.token);
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe("bytes */50");
  });

  test("GET /api/uploads ignores a malformed Range and serves the full 200 body", async () => {
    const config = testConfig("uploads-range-malformed");
    const handler = createHandler(config);
    const bytes = new Uint8Array(Array.from({ length: 50 }, (_, i) => i));
    const ref = storeUpload(config.instance, bytes, "audio/wav");

    const res = await rawCall(handler, config, `/api/uploads/${ref.id}`, {
      headers: { range: "lines=1-2" }
    }, config.token);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("50");
    expect(res.headers.get("content-range")).toBeNull();
    expect(res.headers.get("accept-ranges")).toBe("bytes");
  });

  test("GET /api/uploads treats a reversed Range (start>end) as malformed → full 200", async () => {
    const config = testConfig("uploads-range-reversed");
    const handler = createHandler(config);
    const bytes = new Uint8Array(Array.from({ length: 50 }, (_, i) => i));
    const ref = storeUpload(config.instance, bytes, "audio/wav");

    const res = await rawCall(handler, config, `/api/uploads/${ref.id}`, {
      headers: { range: "bytes=20-10" }
    }, config.token);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("50");
  });

  test("GET /api/uploads treats an empty suffix Range (bytes=-) as malformed → full 200", async () => {
    const config = testConfig("uploads-range-emptysuffix");
    const handler = createHandler(config);
    const bytes = new Uint8Array(Array.from({ length: 50 }, (_, i) => i));
    const ref = storeUpload(config.instance, bytes, "audio/wav");

    const res = await rawCall(handler, config, `/api/uploads/${ref.id}`, {
      headers: { range: "bytes=-" }
    }, config.token);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("50");
  });

  test("GET /api/uploads returns 416 for a zero-length suffix Range (bytes=-0)", async () => {
    const config = testConfig("uploads-range-zerosuffix");
    const handler = createHandler(config);
    const bytes = new Uint8Array(Array.from({ length: 50 }, (_, i) => i));
    const ref = storeUpload(config.instance, bytes, "audio/wav");

    const res = await rawCall(handler, config, `/api/uploads/${ref.id}`, {
      headers: { range: "bytes=-0" }
    }, config.token);
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe("bytes */50");
  });

  test("GET /api/uploads returns 416 for any Range against a zero-byte upload", async () => {
    const config = testConfig("uploads-range-empty-file");
    const handler = createHandler(config);
    // storeUpload rejects an empty body, so write the manifest+bytes directly to
    // exercise the total===0 branch (a 0-byte stored file can't satisfy a range).
    const ref = storeUpload(config.instance, new Uint8Array([1]), "audio/wav");
    writeFileSync(join(uploadsDir(config.instance), `${ref.id}.wav`), new Uint8Array([]));

    const res = await rawCall(handler, config, `/api/uploads/${ref.id}`, {
      headers: { range: "bytes=0-10" }
    }, config.token);
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe("bytes */0");
  });

  test("HEAD /api/uploads advertises accept-ranges and the content length", async () => {
    const config = testConfig("uploads-head-range");
    const handler = createHandler(config);
    const bytes = new Uint8Array(Array.from({ length: 42 }, (_, i) => i));
    const ref = storeUpload(config.instance, bytes, "audio/wav");

    const res = await rawCall(handler, config, `/api/uploads/${ref.id}`, {
      method: "HEAD"
    }, config.token);
    expect(res.status).toBe(200);
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("content-length")).toBe("42");
  });

  test("POST /api/uploads accepts a text/csv file", async () => {
    const config = testConfig("uploads-csv");
    const handler = createHandler(config);
    const form = new FormData();
    form.set("file", new File(["a,b\n1,2\n"], "data.csv", { type: "text/csv" }));
    const response = await handler(new Request(`http://127.0.0.1:${config.port}/api/uploads`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.token}` },
      body: form
    }));
    expect(response.status).toBe(201);
    const ref = await response.json();
    expect(ref.mimeType).toBe("text/csv");
  });

  // The 415 gate fires on a structurally-invalid mime (no slash / whitespace).
  // It can't be reached through a real request: Bun's server-side
  // request.formData() normalizes an invalid part Content-Type (e.g.
  // "notamime") to application/octet-stream, and its File/FormData encoder
  // sniffs the part mime from the filename extension — either way the part
  // arrives plausible, so the predicate is exercised directly to pin the
  // 415-triggering condition.
  test("isPlausibleMime rejects structurally-invalid mimes (the 415 gate)", () => {
    expect(isPlausibleMime("notamime")).toBe(false);
    expect(isPlausibleMime("text/csv")).toBe(true);
    expect(isPlausibleMime("application/pdf")).toBe(true);
  });

  test("POST /api/uploads rejects an empty file with 400", async () => {
    const config = testConfig("uploads-empty");
    const handler = createHandler(config);
    const form = new FormData();
    form.set("file", new File([], "empty.csv", { type: "text/csv" }));
    const response = await handler(new Request(`http://127.0.0.1:${config.port}/api/uploads`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.token}` },
      body: form
    }));
    expect(response.status).toBe(400);
  });

  test("POST /api/uploads rejects a file over the size cap with 413", async () => {
    process.env.GINI_MAX_UPLOAD_BYTES = "10";
    try {
      const config = testConfig("uploads-toolarge");
      const handler = createHandler(config);
      const form = new FormData();
      form.set("file", new File(["this body is well over ten bytes"], "big.csv", { type: "text/csv" }));
      const response = await handler(new Request(`http://127.0.0.1:${config.port}/api/uploads`, {
        method: "POST",
        headers: { authorization: `Bearer ${config.token}` },
        body: form
      }));
      expect(response.status).toBe(413);
    } finally {
      delete process.env.GINI_MAX_UPLOAD_BYTES;
    }
  });

  test("storeUpload sanitizes a filename with embedded newline/control chars to a single line", () => {
    const config = testConfig("uploads-filename");
    const ref = storeUpload(config.instance, new Uint8Array([1, 2, 3]), "text/csv", "a\nb\t\rc.csv");
    const stat = uploadStat(config.instance, ref.id);
    expect(stat?.filename).toBe("a b c.csv");
    expect(stat?.filename).not.toContain("\n");
  });

  // The exported sanitizeFilename is also applied at the model-facing render
  // in buildAttachmentContent, covering manifests written outside storeUpload.
  test("sanitizeFilename strips control chars, collapses whitespace, and caps length", () => {
    expect(sanitizeFilename("a\nb\tc.csv")).toBe("a b c.csv");
    expect(sanitizeFilename("x".repeat(300)).length).toBe(255);
  });
});

describe("email watcher routes", () => {
  test("GET /api/email/watchers is scoped to the active agent", async () => {
    const config = testConfig("http-email-list-scope");
    const handler = createHandler(config);
    const initial = await call(handler, config, "/api/agents");
    const defaultAgentId = initial.activeAgentId as string;
    const second = await call(handler, config, "/api/agents", {
      method: "POST",
      body: JSON.stringify({ name: "scout" })
    });

    // A watcher created under the default agent.
    const underDefault = await call(handler, config, "/api/email/watchers", {
      method: "POST",
      body: JSON.stringify({ sender: "alice@example.com" })
    });
    // Switch to scout and create another watcher under it.
    await call(handler, config, `/api/agents/${second.id}/use`, { method: "POST" });
    const underScout = await call(handler, config, "/api/email/watchers", {
      method: "POST",
      body: JSON.stringify({ sender: "bob@example.com" })
    });

    // GET now reflects the active agent (scout) — only its watcher.
    const scoutList = await call(handler, config, "/api/email/watchers");
    expect(scoutList.map((w: { id: string }) => w.id)).toEqual([(underScout as { id: string }).id]);

    // Switch back: GET returns only the default agent's watcher.
    await call(handler, config, `/api/agents/${defaultAgentId}/use`, { method: "POST" });
    const defaultList = await call(handler, config, "/api/email/watchers");
    expect(defaultList.map((w: { id: string }) => w.id)).toEqual([(underDefault as { id: string }).id]);
  });

  test("PATCH /api/email/watchers/:id toggles enabled and tears down / recreates the shared job", async () => {
    const config = testConfig("http-email-patch");
    const handler = createHandler(config);
    const created = await call(handler, config, "/api/email/watchers", {
      method: "POST",
      body: JSON.stringify({ sender: "alice@example.com" })
    });
    const id = (created as { id: string }).id;
    const jobId = (created as { jobId: string }).jobId;
    expect(jobId).toBeString();
    // The shared email-watch job is active and watches this sole watcher.
    const sharedJob = () =>
      readState(config.instance).jobs.find(
        (j) => (j.preRunHook?.config as { skill?: string })?.skill === "gmail-watch"
      );
    expect(sharedJob()?.id).toBe(jobId);
    expect(sharedJob()?.status).toBe("active");

    // Disabling the sole watcher tears the shared job down (nothing to poll).
    const disabled = await call(handler, config, `/api/email/watchers/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: false })
    });
    expect((disabled as { enabled: boolean }).enabled).toBe(false);
    expect(sharedJob()).toBeUndefined();

    // Re-enabling recreates the shared job and re-stamps the watcher's jobId.
    const enabled = await call(handler, config, `/api/email/watchers/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: true })
    });
    expect((enabled as { enabled: boolean }).enabled).toBe(true);
    expect(sharedJob()).toBeDefined();
    expect((enabled as { jobId: string }).jobId).toBe(sharedJob()!.id);
  });

  test("PATCH /api/email/watchers/:id rejects a non-boolean enabled with 400", async () => {
    const config = testConfig("http-email-patch-bad");
    const handler = createHandler(config);
    const created = await call(handler, config, "/api/email/watchers", {
      method: "POST",
      body: JSON.stringify({ sender: "bob@example.com" })
    });
    const id = (created as { id: string }).id;
    const response = await rawCall(
      handler,
      config,
      `/api/email/watchers/${id}`,
      { method: "PATCH", body: JSON.stringify({ enabled: "yes" }) },
      config.token
    );
    expect(response.status).toBe(400);
  });

  test("PATCH /api/email/watchers/:id returns 404 for an unknown watcher", async () => {
    const config = testConfig("http-email-patch-404");
    const handler = createHandler(config);
    const response = await rawCall(
      handler,
      config,
      "/api/email/watchers/nope",
      { method: "PATCH", body: JSON.stringify({ enabled: false }) },
      config.token
    );
    expect(response.status).toBe(404);
  });

  test("PATCH /api/email/watchers/:id clears the objective with an explicit null", async () => {
    const config = testConfig("http-email-patch-clear");
    const handler = createHandler(config);
    const created = await call(handler, config, "/api/email/watchers", {
      method: "POST",
      body: JSON.stringify({ sender: "bob@example.com", objective: "Get a refund" })
    });
    const id = (created as { id: string }).id;
    expect((created as { objective?: string }).objective).toBe("Get a refund");
    // Explicit null clears (distinct from omitted = unchanged, "" = 400).
    const cleared = await call(handler, config, `/api/email/watchers/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ objective: null })
    });
    expect((cleared as { objective?: string }).objective).toBeUndefined();
    // An empty-string objective is still rejected.
    const empty = await rawCall(
      handler,
      config,
      `/api/email/watchers/${id}`,
      { method: "PATCH", body: JSON.stringify({ objective: "" }) },
      config.token
    );
    expect(empty.status).toBe(400);
  });

  test("POST /api/google/accounts rejects a configDir outside the allowed roots", async () => {
    const config = testConfig("http-google-accounts-configdir");
    const handler = createHandler(config);
    // A relative path is rejected.
    const relative = await rawCall(
      handler,
      config,
      "/api/google/accounts",
      { method: "POST", body: JSON.stringify({ tag: "x", configDir: "relative/gws" }) },
      config.token
    );
    expect(relative.status).toBe(400);
    expect((await relative.json()).error).toContain("configDir must be");
    // An absolute but unrelated path is rejected (defense-in-depth — never
    // reaches registerAccount / a real gws spawn).
    const arbitrary = await rawCall(
      handler,
      config,
      "/api/google/accounts",
      { method: "POST", body: JSON.stringify({ tag: "x", configDir: "/etc/passwd" }) },
      config.token
    );
    expect(arbitrary.status).toBe(400);
    expect((await arbitrary.json()).error).toContain("configDir must be");
  });

  test("POST /api/google/accounts no longer requires a tag (configDir validation still applies)", async () => {
    const config = testConfig("http-google-accounts-no-tag");
    const handler = createHandler(config);
    // A tag-less body reaches the configDir gate (previously a missing tag was
    // its own 400) — the register path derives the tag from the live session.
    const response = await rawCall(
      handler,
      config,
      "/api/google/accounts",
      { method: "POST", body: JSON.stringify({ configDir: "relative/gws" }) },
      config.token
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("configDir must be");
  });

  test("DELETE /api/google/accounts/:id/instance disconnects only a secondary account", async () => {
    const config = testConfig("http-google-disconnect-instance");
    const handler = createHandler(config);
    const prevHome = process.env.HOME;
    const scratchHome = join(`/tmp/gini-http-tests-${import.meta.file}`, `disconnect-home-${process.pid}-${Date.now()}`);
    mkdirSync(scratchHome, { recursive: true });
    process.env.HOME = scratchHome;
    try {
      const { registerAccountForInstance } = await import("./integrations/connectors/google-accounts");
      const { getGoogleAccountBindings } = await import("./state/google-account-bindings");
      const { readGoogleAccounts } = await import("./state/google-accounts");
      const primary = await registerAccountForInstance(config.instance, {
        tag: "primary",
        configDir: join(scratchHome, "primary"),
        trusted: true,
        email: "primary@example.com"
      });
      const secondary = await registerAccountForInstance(config.instance, {
        tag: "secondary",
        configDir: join(scratchHome, "secondary"),
        trusted: true,
        email: "secondary@example.com"
      });

      const protectedResponse = await rawCall(
        handler,
        config,
        `/api/google/accounts/${primary.id}/instance`,
        { method: "DELETE" },
        config.token
      );
      expect(protectedResponse.status).toBe(409);
      expect((await protectedResponse.json()).error).toContain("Primary Google account cannot be disconnected");

      const disconnected = await rawCall(
        handler,
        config,
        `/api/google/accounts/${secondary.id}/instance`,
        { method: "DELETE" },
        config.token
      );
      expect(disconnected.status).toBe(200);
      expect(await disconnected.json()).toEqual({ id: secondary.id });
      expect(getGoogleAccountBindings(config.instance).attachedAccountIds).toEqual([primary.id]);
      expect(readGoogleAccounts()).toHaveLength(2);
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      rmSync(scratchHome, { recursive: true, force: true });
    }
  });

  test("GET /api/google/login/start 302s to Google consent with PKCE and the browser-facing redirect_uri", async () => {
    const config = testConfig("http-google-login-start");
    const handler = createHandler(config);
    resetGoogleLoginWebState();
    try {
      const origin = encodeURIComponent("http://127.0.0.1:3059");
      const response = await rawCall(
        handler,
        config,
        `/api/google/login/start?returnTo=%2Fonboarding&origin=${origin}`,
        {},
        config.token
      );
      expect(response.status).toBe(302);
      const location = new URL(response.headers.get("location") ?? "");
      expect(location.host).toBe("accounts.google.com");
      expect(location.searchParams.get("redirect_uri")).toBe(
        "http://127.0.0.1:3059/api/runtime/google/login/callback"
      );
      expect(location.searchParams.get("code_challenge_method")).toBe("S256");
      expect(location.searchParams.get("state")).toBeTruthy();
    } finally {
      resetGoogleLoginWebState();
    }
  });

  test("GET /api/google/login/start 400s on a non-loopback origin", async () => {
    const config = testConfig("http-google-login-start-400");
    const handler = createHandler(config);
    resetGoogleLoginWebState();
    try {
      const lan = await rawCall(
        handler,
        config,
        `/api/google/login/start?origin=${encodeURIComponent("http://192.168.1.20:3000")}`,
        {},
        config.token
      );
      expect(lan.status).toBe(400);
      expect((await lan.json()).error).toContain("loopback");
    } finally {
      resetGoogleLoginWebState();
    }
  });

  test("GET /api/google/login/callback with an unknown state 302s back with googleAddError=1 (never an error page)", async () => {
    const config = testConfig("http-google-login-callback");
    const handler = createHandler(config);
    resetGoogleLoginWebState();
    const response = await rawCall(
      handler,
      config,
      "/api/google/login/callback?code=bogus&state=bogus",
      {},
      config.token
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/onboarding?step=accounts&googleAddError=1");
  });
});

describe("response compression", () => {
  // Seed enough audit rows that /api/state's JSON body clears the 1 KB
  // threshold, so the compressible-path assertions exercise real compression
  // rather than the too-small skip.
  async function seedBulkyState(config: RuntimeConfig): Promise<void> {
    // Awaited by every caller: mutateState is async (it chains on the
    // per-instance write lock), so without awaiting it the subsequent
    // readState in the request under test can race the write and read state
    // before the bulky audit rows land — intermittently dropping the body
    // under the 1 KB threshold and skipping compression.
    await mutateState(config.instance, (state) => {
      for (let i = 0; i < 200; i += 1) {
        addAudit(state, {
          actor: "runtime",
          action: "test.bulk",
          target: `row-${i}`,
          risk: "low",
          evidence: { note: "padding to push the state payload past the gzip threshold" }
        }, { system: true });
      }
    });
  }

  test("gzips a large JSON response when the client accepts only gzip", async () => {
    const config = testConfig("gzip-json");
    const handler = createHandler(config);
    await seedBulkyState(config);
    const response = await rawCall(
      handler,
      config,
      "/api/state",
      { headers: { "accept-encoding": "gzip" } },
      config.token
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBe("gzip");
    expect(response.headers.get("vary") ?? "").toContain("Accept-Encoding");
    // The body is real gzip and decodes back to valid JSON state.
    const compressed = new Uint8Array(await response.arrayBuffer());
    const decoded = JSON.parse(new TextDecoder().decode(Bun.gunzipSync(compressed)));
    expect(decoded.instance).toBe(config.instance);
    // The compressed transfer is materially smaller than the raw JSON.
    const rawLen = new TextEncoder().encode(JSON.stringify(decoded)).length;
    expect(compressed.byteLength).toBeLessThan(rawLen);
  });

  test("prefers brotli when the client accepts both br and gzip", async () => {
    const config = testConfig("br-json");
    const handler = createHandler(config);
    await seedBulkyState(config);
    const response = await rawCall(
      handler,
      config,
      "/api/state",
      { headers: { "accept-encoding": "gzip, br" } },
      config.token
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBe("br");
    expect(response.headers.get("vary") ?? "").toContain("Accept-Encoding");
    // The body is real brotli and decodes back to valid JSON state.
    const { brotliDecompressSync } = await import("node:zlib");
    const compressed = new Uint8Array(await response.arrayBuffer());
    const decoded = JSON.parse(new TextDecoder().decode(brotliDecompressSync(compressed)));
    expect(decoded.instance).toBe(config.instance);
    const rawLen = new TextEncoder().encode(JSON.stringify(decoded)).length;
    expect(compressed.byteLength).toBeLessThan(rawLen);
  });

  test("falls back to gzip when br is explicitly opted out (br;q=0)", async () => {
    const config = testConfig("br-optout");
    const handler = createHandler(config);
    await seedBulkyState(config);
    const response = await rawCall(
      handler,
      config,
      "/api/state",
      { headers: { "accept-encoding": "br;q=0, gzip" } },
      config.token
    );
    expect(response.headers.get("content-encoding")).toBe("gzip");
  });

  test("does not compress when the client omits Accept-Encoding", async () => {
    const config = testConfig("gzip-absent");
    const handler = createHandler(config);
    await seedBulkyState(config);
    const response = await rawCall(handler, config, "/api/state", {}, config.token);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBeNull();
    const body = await response.json();
    expect(body.instance).toBe(config.instance);
  });

  test("honors gzip;q=0 as an explicit opt-out", async () => {
    const config = testConfig("gzip-q0");
    const handler = createHandler(config);
    await seedBulkyState(config);
    const response = await rawCall(
      handler,
      config,
      "/api/state",
      { headers: { "accept-encoding": "gzip;q=0" } },
      config.token
    );
    expect(response.headers.get("content-encoding")).toBeNull();
  });

  test("leaves a small JSON response uncompressed (below threshold)", async () => {
    const config = testConfig("gzip-small");
    const handler = createHandler(config);
    const response = await rawCall(
      handler,
      config,
      "/api/tasks?agentId=does_not_exist",
      { headers: { "accept-encoding": "gzip" } },
      config.token
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBeNull();
    // Body is still the intact (empty) JSON array.
    expect(await response.json()).toEqual([]);
  });

  test("never compresses an SSE event stream", async () => {
    const config = testConfig("gzip-sse");
    const handler = createHandler(config);
    const response = await rawCall(
      handler,
      config,
      "/api/events/stream",
      { headers: { "accept-encoding": "gzip" } },
      config.token
    );
    try {
      expect(response.headers.get("content-type") ?? "").toContain("text/event-stream");
      expect(response.headers.get("content-encoding")).toBeNull();
    } finally {
      await response.body?.cancel();
    }
  });

  test("never compresses a web-proxy path (only the native /api surface is compressed)", async () => {
    // /api/runtime/* is a web-proxy path (isWebProxyPath). Those responses are
    // reachable unauthenticated via the pairing bootstrap and are gzip'd by the
    // web child itself, so the gateway must NOT brotli/gzip them — that would
    // let an unauthenticated client burn CPU on compression before any session
    // check. Unauthenticated relay-less loopback returns 401 here, but the
    // point is the absence of a gateway-applied Content-Encoding regardless.
    const config = testConfig("gzip-webproxy");
    const handler = createHandler(config);
    const response = await rawCall(
      handler,
      config,
      "/api/runtime/status",
      { headers: { "accept-encoding": "gzip, br" } }
    );
    expect(response.headers.get("content-encoding")).toBeNull();
  });

  test("never compresses a 206 byte-range response (preserves Content-Range semantics)", async () => {
    // A compressible upload (text/csv) over the 1 KB threshold, fetched with a
    // Range. The 206 carries Content-Range computed on the UNENCODED bytes, so
    // adding Content-Encoding would corrupt the range contract (RFC 7233).
    const config = testConfig("gzip-range");
    const handler = createHandler(config);
    const bytes = new TextEncoder().encode("col_a,col_b,col_c\n" + "1,2,3\n".repeat(500));
    const ref = storeUpload(config.instance, bytes, "text/csv");
    const res = await rawCall(
      handler,
      config,
      `/api/uploads/${ref.id}`,
      { headers: { range: "bytes=0-1999", "accept-encoding": "br, gzip" } },
      config.token
    );
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toContain("bytes 0-1999/");
    expect(res.headers.get("content-encoding")).toBeNull();
  });
});

async function call(handler: ReturnType<typeof createHandler>, config: RuntimeConfig, path: string, init: RequestInit = {}) {
  return callWithToken(handler, config, config.token, path, init);
}

async function callWithToken(handler: ReturnType<typeof createHandler>, config: RuntimeConfig, token: string, path: string, init: RequestInit = {}) {
  const response = await rawCall(handler, config, path, init, token);
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
  return value;
}

async function rawCall(handler: ReturnType<typeof createHandler>, config: RuntimeConfig, path: string, init: RequestInit = {}, token?: string) {
  const response = await handler(new Request(`http://127.0.0.1:${config.port}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) }
  }));
  return response;
}

// Opens a chat SSE stream, pumps frames until the initial `chat_session`
// frame lands (which only happens inside the stream's start() — i.e. AFTER
// presence registration), runs the caller's `whileOpen` assertions, then
// ALWAYS cancels the reader in a finally so a thrown assertion can't leak
// the stream (its keepalive interval and presence entry would otherwise
// survive the test). Returns after the reader is cancelled.
async function withChatStream(
  handler: ReturnType<typeof createHandler>,
  config: RuntimeConfig,
  sessionId: string,
  init: RequestInit,
  whileOpen: () => void
): Promise<void> {
  const response = await rawCall(handler, config, `/api/chat/${sessionId}/stream`, init, config.token);
  expect(response.status).toBe(200);
  const reader = response.body?.getReader();
  expect(reader).toBeDefined();
  if (!reader) return;
  try {
    const decoder = new TextDecoder();
    let buffer = "";
    const deadline = Date.now() + 500;
    while (Date.now() < deadline) {
      const { done, value } = await Promise.race([
        reader.read(),
        new Promise<{ done: boolean; value: undefined }>((resolve) =>
          setTimeout(() => resolve({ done: false, value: undefined }), 50)
        )
      ]);
      if (done) break;
      if (value) buffer += decoder.decode(value);
      if (buffer.includes("event: chat_session")) break;
    }
    expect(buffer).toContain("event: chat_session");
    whileOpen();
  } finally {
    await reader.cancel();
  }
  // cancel() runs the stream's cleanup synchronously in-process; give the
  // microtask queue one turn to settle before the caller asserts the
  // post-close registry state.
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function testConfig(instance: string): RuntimeConfig {
  const root = `/tmp/gini-http-tests-${import.meta.file}`;
  process.env.GINI_STATE_ROOT = root;
  process.env.GINI_LOG_ROOT = `${root}-logs`;
  // Drop the cached SQLite handle for this instance before nuking the
  // directory. Without this, a prior test that opened the per-instance
  // memory DB leaves an open `bun:sqlite` handle pointing at the now-
  // unlinked file. The next call to getMemoryDb returns that cached
  // handle (the cache key is the instance name) and any write fails
  // because the inode is gone. removeMemoryDb closes the cached handle
  // AND unlinks the file + WAL/SHM siblings in one shot.
  removeMemoryDb(instance);
  // resumeChatTask polls for the loop's flip to waiting_approval before
  // staging a tool result. In-process the flip lands within a couple of
  // mutateState boundaries, and several fill_secret / approval tests seed a
  // task that never reaches waiting_approval at all — so the production
  // 1000ms/100ms budget is pure dead wall here (the fill_secret leak test
  // measured 1079.00ms in isolation, nearly all of it this poll). Shrink the
  // budget via the server-side env knob the production code reads (default
  // preserved at 1000/100); the race still resolves well within 40ms over 5ms
  // ticks in-process.
  process.env.GINI_RESUME_WAIT_BUDGET_MS = "40";
  process.env.GINI_RESUME_WAIT_TICK_MS = "5";
  rmSync(`${root}/instances/${instance}`, { recursive: true, force: true });
  return {
    instance,
    port: 7337,
    token: "test-token",
    provider: { name: "echo", model: "gini-echo-v0" },
    workspaceRoot: "/tmp",
    stateRoot: `${root}/instances/${instance}`,
    logRoot: `${root}-logs/${instance}`,
    // These tests predate the approval-mode flip and rely on the
    // gated path. Force "strict" to keep them honest; new defaults
    // are exercised in approval-mode.test.ts.
    approvalMode: "strict"
  };
}

// Write a log file under the test config's instance log dir so the /api/logs
// route reads it. testConfig nukes the instance state dir and points
// GINI_LOG_ROOT at a sibling tree, so this lands in a clean per-instance dir.
function seedLogFile(config: RuntimeConfig, filename: string, body: string): void {
  const dir = logDir(config.instance);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), body);
}

// Seed a typed api-key credential so the per-(skill, credential) consent gate
// (firstUngrantedCredential) treats it as carrying a secret that needs consent.
async function seedTypedCredential(config: RuntimeConfig, name: string, provider: string) {
  const at = new Date().toISOString();
  await mutateState(config.instance, (state) => {
    state.connectors.push({
      id: `id_${name}`,
      instance: state.instance,
      name,
      provider,
      type: "api-key",
      status: "configured",
      scopes: [],
      secretRefs: [{ purpose: name, path: `/tmp/${name}.json` }],
      createdAt: at,
      updatedAt: at,
      health: "healthy",
      source: "user"
    });
  });
}

async function waitForTask(
  handler: ReturnType<typeof createHandler>,
  config: RuntimeConfig,
  taskId: string,
  // The approve endpoint returns at decision durability while the side
  // effect + resume run detached, so a post-approve wait must exclude
  // the still-parked waiting_approval status or it returns the
  // pre-approve park immediately.
  statuses: string[] = ["completed", "failed", "waiting_approval"]
) {
  // Phase 5 added auto-recall + auto-retain to runTask. The retain side is
  // fire-and-forget so it can't block, but the inline recall + a few extra
  // mutateState audits push runTask completion past the original 500ms
  // budget on slower hosts. A 200-iteration / 10ms loop = 2s ceiling is
  // still well under any reasonable test timeout.
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const detail = await call(handler, config, `/api/tasks/${taskId}`);
    if (statuses.includes(detail.task.status)) return detail;
    await Bun.sleep(10);
  }
  throw new Error(`Task did not settle: ${taskId}`);
}

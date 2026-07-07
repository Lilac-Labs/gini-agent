// Pins the BFF path canonicalizer used by the /api/runtime/[...path] proxy
// route — rejecting traversal, duplicate slashes, embedded delimiters, and
// over-long input before a request path is forwarded to the gateway.
import { describe, expect, test } from "bun:test";
import { canonicalizePath, noTrailingSlash } from "./canonicalize";

function pass(input: string): string {
  const r = canonicalizePath(input);
  if (!r.ok) throw new Error(`expected ok for ${input}, got reason=${r.reason}`);
  return r.path;
}

function reason(input: string): string {
  const r = canonicalizePath(input);
  if (r.ok) throw new Error(`expected reject for ${input}, got ok path=${r.path}`);
  return r.reason;
}

describe("web canonicalizePath", () => {
  test("simple path", () => {
    expect(pass("/api/runtime/status")).toBe("/api/runtime/status");
  });
  test("decodes percent-encoded characters", () => {
    expect(pass("/api/runtime/%73tatus")).toBe("/api/runtime/status");
  });
  test("decodes doubly-encoded", () => {
    expect(pass("/api/runtime/%2573tatus")).toBe("/api/runtime/status");
  });
  test("rejects traversal", () => {
    expect(reason("/api/runtime/../status")).toBe("traversal");
  });
  test("rejects doubly-encoded traversal", () => {
    expect(reason("/api/runtime/%252e%252e/status")).toBe("traversal");
  });
  test("rejects single-dot segment", () => {
    expect(reason("/api/runtime/./status")).toBe("dot-segment");
  });
  test("rejects duplicate interior slash", () => {
    expect(reason("/api/runtime//status")).toBe("duplicate-slash");
  });
  test("rejects backslash", () => {
    expect(reason("/api/runtime\\status")).toBe("backslash-or-nul");
  });
  test("rejects embedded question mark", () => {
    expect(reason("/api/runtime/status%3Fqr")).toBe("embedded-delimiter");
  });
  test("rejects embedded hash", () => {
    expect(reason("/api/runtime/status%23foo")).toBe("embedded-delimiter");
  });
  test("rejects malformed percent", () => {
    expect(reason("/api/runtime/%ZZ")).toBe("malformed-percent-encoding");
  });
  test("preserves bare slash", () => {
    expect(pass("/")).toBe("/");
  });
  test("preserves single trailing slash", () => {
    const r = canonicalizePath("/api/runtime/status/");
    expect(r.ok).toBe(true);
    expect(r.ok && r.hadTrailingSlash).toBe(true);
  });
  test("collapses multiple trailing slashes to one", () => {
    const r = canonicalizePath("/api/runtime/status///");
    expect(r.ok).toBe(true);
    expect(r.ok && r.path).toBe("/api/runtime/status/");
  });
  test("rejects over-length input", () => {
    expect(reason("/" + "a".repeat(5000))).toBe("too-long");
  });
});

describe("web noTrailingSlash", () => {
  test("strips trailing slash", () => {
    expect(noTrailingSlash("/api/runtime/status/")).toBe("/api/runtime/status");
  });
  test("leaves bare slash alone", () => {
    expect(noTrailingSlash("/")).toBe("/");
  });
});

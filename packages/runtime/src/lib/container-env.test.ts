import { describe, expect, test } from "bun:test";
import {
  containerChromeArgs,
  isTruthyEnv,
  resolveBindHost,
  resolveBrowserHeadless,
  resolveEdgeSecret
} from "./container-env";

describe("isTruthyEnv", () => {
  test("accepts 1/true/yes/on case- and whitespace-insensitively", () => {
    for (const value of ["1", "true", "TRUE", "Yes", " on ", "On"]) {
      expect(isTruthyEnv(value)).toBe(true);
    }
  });
  test("rejects undefined, empty, and any other string", () => {
    for (const value of [undefined, "", "  ", "0", "false", "no", "off", "2", "enabled"]) {
      expect(isTruthyEnv(value)).toBe(false);
    }
  });
});

describe("resolveBindHost", () => {
  test("defaults to 127.0.0.1 when unset", () => {
    expect(resolveBindHost({})).toBe("127.0.0.1");
  });
  test("returns an explicit host (0.0.0.0 for containers), trimmed", () => {
    expect(resolveBindHost({ GINI_BIND_HOST: "0.0.0.0" })).toBe("0.0.0.0");
    expect(resolveBindHost({ GINI_BIND_HOST: "  ::  " })).toBe("::");
  });
  test("falls back to loopback when the value is empty or whitespace-only", () => {
    expect(resolveBindHost({ GINI_BIND_HOST: "" })).toBe("127.0.0.1");
    expect(resolveBindHost({ GINI_BIND_HOST: "   " })).toBe("127.0.0.1");
  });
});

describe("resolveBrowserHeadless", () => {
  test("defaults to true (historical behavior) when unset", () => {
    expect(resolveBrowserHeadless({})).toBe(true);
  });
  test("only an explicit falsy value flips it to headed", () => {
    for (const value of ["0", "false", "FALSE", "no", " off "]) {
      expect(resolveBrowserHeadless({ GINI_BROWSER_HEADLESS: value })).toBe(false);
    }
  });
  test("any non-falsy value (incl. truthy and garbage) stays headless", () => {
    for (const value of ["1", "true", "yes", "", "  ", "headed", "maybe"]) {
      expect(resolveBrowserHeadless({ GINI_BROWSER_HEADLESS: value })).toBe(true);
    }
  });
});

describe("containerChromeArgs", () => {
  test("returns no extra args off a normal host (knob unset/falsy)", () => {
    expect(containerChromeArgs({})).toEqual([]);
    expect(containerChromeArgs({ GINI_CHROME_NO_SANDBOX: "0" })).toEqual([]);
    expect(containerChromeArgs({ GINI_CHROME_NO_SANDBOX: "false" })).toEqual([]);
  });
  test("adds --no-sandbox and --disable-dev-shm-usage when the knob is truthy", () => {
    expect(containerChromeArgs({ GINI_CHROME_NO_SANDBOX: "1" })).toEqual([
      "--no-sandbox",
      "--disable-dev-shm-usage"
    ]);
    expect(containerChromeArgs({ GINI_CHROME_NO_SANDBOX: "true" })).toEqual([
      "--no-sandbox",
      "--disable-dev-shm-usage"
    ]);
  });
});

describe("resolveEdgeSecret", () => {
  test("returns \"\" when unset (default off — the header is never honored)", () => {
    expect(resolveEdgeSecret({})).toBe("");
  });
  test("returns \"\" verbatim when explicitly empty (empty is never a valid secret)", () => {
    expect(resolveEdgeSecret({ GINI_EDGE_SECRET: "" })).toBe("");
  });
  test("returns the configured secret verbatim (no trim/normalize) when set", () => {
    expect(resolveEdgeSecret({ GINI_EDGE_SECRET: "s3cr3t-edge-token" })).toBe("s3cr3t-edge-token");
    // Preserved exactly so the full-string compare stays byte-for-byte.
    expect(resolveEdgeSecret({ GINI_EDGE_SECRET: "  padded  " })).toBe("  padded  ");
  });
});

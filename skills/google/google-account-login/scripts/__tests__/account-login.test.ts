// Unit tests for the pure helpers of the per-account Google login script.
//
// Only the side-effect-free exports are covered here: URL scraping out of a
// realistic gws log blob and the `gws auth login` arg builder. No subprocess, no
// network, no gws — the imperative login/register orchestration is exercised
// end-to-end through a real chat turn, not here.

import { describe, expect, test } from "bun:test";
import { buildLoginArgs, expandHome, extractConsentUrl, forceAccountChooser } from "../account-login";

describe("extractConsentUrl", () => {
  test("finds the consent URL in a realistic gws auth login log blob", () => {
    const log = [
      "Using keyring backend: keyring",
      "Starting local server on http://localhost:54321",
      "Open this URL in your browser to authenticate:",
      "",
      "  https://accounts.google.com/o/oauth2/auth?response_type=code&client_id=abc.apps.googleusercontent.com&redirect_uri=http://localhost:54321&scope=foo",
      "",
      "Waiting for authentication..."
    ].join("\n");
    expect(extractConsentUrl(log)).toBe(
      "https://accounts.google.com/o/oauth2/auth?response_type=code&client_id=abc.apps.googleusercontent.com&redirect_uri=http://localhost:54321&scope=foo"
    );
  });

  test("returns null when no consent URL is present", () => {
    expect(extractConsentUrl("Using keyring backend: keyring\nStarting local server...")).toBeNull();
    expect(extractConsentUrl("")).toBeNull();
  });
});

describe("buildLoginArgs", () => {
  test("defaults to the seven-service -s list", () => {
    expect(buildLoginArgs({})).toEqual([
      "auth",
      "login",
      "-s",
      "drive,gmail,calendar,docs,sheets,meet,forms"
    ]);
  });

  test("uses the caller's services with -s when provided", () => {
    expect(buildLoginArgs({ services: ["gmail", "drive"] })).toEqual([
      "auth",
      "login",
      "-s",
      "gmail,drive"
    ]);
  });

  test("prefers --scopes (full scope URLs) over -s when supplied", () => {
    const scopes = [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/drive"
    ];
    expect(buildLoginArgs({ services: ["gmail"], scopes })).toEqual([
      "auth",
      "login",
      "--scopes",
      scopes.join(",")
    ]);
  });

  test("inserts --readonly before the scope flag", () => {
    expect(buildLoginArgs({ readonly: true, services: ["gmail"] })).toEqual([
      "auth",
      "login",
      "--readonly",
      "-s",
      "gmail"
    ]);
  });
});

describe("expandHome", () => {
  test("expands a leading ~/ to the home dir", () => {
    expect(expandHome("~/.config/gws", "/Users/me")).toBe("/Users/me/.config/gws");
  });

  test("expands a bare ~ to the home dir", () => {
    expect(expandHome("~", "/Users/me")).toBe("/Users/me");
  });

  test("passes an absolute path through unchanged", () => {
    expect(expandHome("/Users/me/.gini/google-accounts/gacct_ab12", "/Users/me"))
      .toBe("/Users/me/.gini/google-accounts/gacct_ab12");
  });
});

describe("forceAccountChooser", () => {
  test("adds prompt=select_account to a URL with no prompt", () => {
    const out = new URL(forceAccountChooser(
      "https://accounts.google.com/o/oauth2/auth?response_type=code&client_id=abc"
    ));
    expect(out.searchParams.get("prompt")?.split(/\s+/)).toContain("select_account");
  });

  test("merges select_account with an existing prompt=consent", () => {
    const out = new URL(forceAccountChooser(
      "https://accounts.google.com/o/oauth2/auth?prompt=consent&client_id=abc"
    ));
    const prompts = out.searchParams.get("prompt")?.split(/\s+/) ?? [];
    expect(prompts).toContain("consent");
    expect(prompts).toContain("select_account");
  });

  test("adds login_hint when provided", () => {
    const out = new URL(forceAccountChooser(
      "https://accounts.google.com/o/oauth2/auth?client_id=abc",
      "me@example.com"
    ));
    expect(out.searchParams.get("login_hint")).toBe("me@example.com");
  });

  test("omits login_hint when not provided", () => {
    const out = new URL(forceAccountChooser(
      "https://accounts.google.com/o/oauth2/auth?client_id=abc"
    ));
    expect(out.searchParams.has("login_hint")).toBe(false);
  });

  test("preserves existing params", () => {
    const out = new URL(forceAccountChooser(
      "https://accounts.google.com/o/oauth2/auth?client_id=abc&redirect_uri=http://localhost:54321&scope=foo"
    ));
    expect(out.searchParams.get("client_id")).toBe("abc");
    expect(out.searchParams.get("redirect_uri")).toBe("http://localhost:54321");
    expect(out.searchParams.get("scope")).toBe("foo");
  });

  test("returns the input unchanged for an unparseable URL", () => {
    expect(forceAccountChooser("not a url")).toBe("not a url");
  });
});

import { describe, expect, test } from "bun:test";
import { parseGwsAuthStatus } from "./gws-session";

// parseGwsAuthStatus is the pure half of gwsSessionStatus (the subprocess
// boundary is isolated in the cached async wrapper). These tests pin the
// liveness derivation: signedIn := token_valid===true, clientConfigured :=
// client_config_exists===true, and the human message for each state.

describe("parseGwsAuthStatus", () => {
  test("signed in when token_valid is true; scopes map to per-service grants", () => {
    const scopes = [
      "https://www.googleapis.com/auth/calendar",
      "https://www.googleapis.com/auth/gmail.modify"
    ];
    const status = parseGwsAuthStatus(
      JSON.stringify({
        client_config_exists: true,
        token_valid: true,
        has_refresh_token: true,
        user: "me@example.com",
        scopes
      })
    );
    expect(status).toEqual({
      installed: true,
      clientConfigured: true,
      signedIn: true,
      tokenRevoked: false,
      services: { calendar: true, gmail: true, drive: false, docs: false, sheets: false, forms: false, meet: false },
      scopes,
      email: "me@example.com",
      message: "Signed in to Google"
    });
  });

  test("docs/sheets/meet resolve from their Google scope names", () => {
    const status = parseGwsAuthStatus(
      JSON.stringify({
        client_config_exists: true,
        token_valid: true,
        scopes: [
          "https://www.googleapis.com/auth/documents",
          "https://www.googleapis.com/auth/spreadsheets",
          "https://www.googleapis.com/auth/meetings.space.created"
        ]
      })
    );
    expect(status.services).toEqual({
      calendar: false, gmail: false, drive: false, docs: true, sheets: true, forms: false, meet: true
    });
  });

  test("provisioned but expired session → needs re-auth", () => {
    // The live fixture: client creds present, user token expired.
    const status = parseGwsAuthStatus(
      JSON.stringify({
        client_config_exists: true,
        token_valid: false,
        token_error: "reauth related error (invalid_rapt)",
        has_refresh_token: true
      })
    );
    expect(status.installed).toBe(true);
    expect(status.clientConfigured).toBe(true);
    expect(status.signedIn).toBe(false);
    expect(status.message).toBe("Google sign-in expired — re-auth needed");
  });

  test("no client config and no valid token → sign-in needed", () => {
    const status = parseGwsAuthStatus(
      JSON.stringify({ client_config_exists: false, token_valid: false })
    );
    expect(status).toEqual({
      installed: true,
      clientConfigured: false,
      signedIn: false,
      tokenRevoked: false,
      services: { calendar: false, gmail: false, drive: false, docs: false, sheets: false, forms: false, meet: false },
      scopes: [],
      message: "Google sign-in needed"
    });
  });

  test("surfaces the signed-in email from `user` and the raw scopes", () => {
    const scopes = ["https://www.googleapis.com/auth/drive"];
    const status = parseGwsAuthStatus(
      JSON.stringify({ client_config_exists: true, token_valid: true, user: "work@corp.com", scopes })
    );
    expect(status.email).toBe("work@corp.com");
    expect(status.scopes).toEqual(scopes);
  });

  test("absent `user` → email omitted; absent `scopes` → []", () => {
    const status = parseGwsAuthStatus(
      JSON.stringify({ client_config_exists: true, token_valid: true })
    );
    expect(status.email).toBeUndefined();
    expect(status.scopes).toEqual([]);
  });

  test("tolerates a non-JSON stdout preamble before the JSON", () => {
    const stdout =
      "Using keyring backend: keyring\n" +
      JSON.stringify({ client_config_exists: true, token_valid: true, user: "me@example.com", scopes: [] });
    const status = parseGwsAuthStatus(stdout);
    expect(status.signedIn).toBe(true);
    expect(status.email).toBe("me@example.com");
  });

  test("non-JSON output (gws missing / errored) → not installed", () => {
    const status = parseGwsAuthStatus("zsh: command not found: gws\n");
    expect(status).toEqual({
      installed: false,
      clientConfigured: false,
      signedIn: false,
      tokenRevoked: false,
      services: { calendar: false, gmail: false, drive: false, docs: false, sheets: false, forms: false, meet: false },
      scopes: [],
      message: "gws not installed"
    });
  });

  test("empty output → not installed", () => {
    expect(parseGwsAuthStatus("").signedIn).toBe(false);
    expect(parseGwsAuthStatus("").installed).toBe(false);
  });

  test("JSON that is not an object (e.g. a bare number) → not installed", () => {
    expect(parseGwsAuthStatus("42").installed).toBe(false);
  });

  test("missing token_valid key defaults to signed out (not crash)", () => {
    const status = parseGwsAuthStatus(JSON.stringify({ client_config_exists: true }));
    expect(status.installed).toBe(true);
    expect(status.clientConfigured).toBe(true);
    expect(status.signedIn).toBe(false);
  });
});

// tokenRevoked distinguishes a revoked/expired grant (a stored refresh token
// that no longer yields a session — the user must re-authenticate) from a
// never-signed-in account (no refresh token yet). It is true when signedIn is
// false AND either gws still holds a refresh token it explained with a
// token_error, or token_error matches a known revoke/reauth signal.
describe("parseGwsAuthStatus tokenRevoked", () => {
  test("the real Google revoke output (has_refresh_token + expired-or-revoked) → tokenRevoked true", () => {
    // Verbatim shape `gws auth status` prints after a myaccount.google.com
    // revoke: token_error is Google's human message, NOT an invalid_grant code,
    // and client_config_exists can be false for a plain credentials.json login.
    const status = parseGwsAuthStatus(
      JSON.stringify({
        client_config_exists: false,
        token_valid: false,
        token_error: "Token has been expired or revoked.",
        has_refresh_token: true,
        plain_credentials_exists: true
      })
    );
    expect(status.signedIn).toBe(false);
    expect(status.tokenRevoked).toBe(true);
    expect(status.message).toBe("Google sign-in expired — re-auth needed");
  });

  test("a dead refresh token gws explained with any token_error → tokenRevoked true", () => {
    // Structural detection: not signed in, a refresh token is present, and gws
    // gave a reason — independent of Google's exact wording.
    const status = parseGwsAuthStatus(
      JSON.stringify({
        client_config_exists: true,
        token_valid: false,
        token_error: "unexpected auth failure",
        has_refresh_token: true
      })
    );
    expect(status.tokenRevoked).toBe(true);
  });

  test("has_refresh_token true but no token_error → tokenRevoked false (no explained failure)", () => {
    const status = parseGwsAuthStatus(
      JSON.stringify({ client_config_exists: true, token_valid: false, has_refresh_token: true })
    );
    expect(status.tokenRevoked).toBe(false);
  });

  test("no refresh token and an unrecognized token_error → tokenRevoked false", () => {
    const status = parseGwsAuthStatus(
      JSON.stringify({ client_config_exists: false, token_valid: false, token_error: "network unreachable" })
    );
    expect(status.tokenRevoked).toBe(false);
  });

  test("a reauth (invalid_rapt) token_error while signed out → tokenRevoked true", () => {
    const status = parseGwsAuthStatus(
      JSON.stringify({
        client_config_exists: true,
        token_valid: false,
        token_error: "reauth related error (invalid_rapt)"
      })
    );
    expect(status.signedIn).toBe(false);
    expect(status.tokenRevoked).toBe(true);
  });

  test("an invalid_grant token_error while signed out → tokenRevoked true", () => {
    const status = parseGwsAuthStatus(
      JSON.stringify({ client_config_exists: true, token_valid: false, token_error: "invalid_grant" })
    );
    expect(status.tokenRevoked).toBe(true);
  });

  test("signed out with no token_error → tokenRevoked false (expired, not revoked)", () => {
    const status = parseGwsAuthStatus(
      JSON.stringify({ client_config_exists: true, token_valid: false })
    );
    expect(status.signedIn).toBe(false);
    expect(status.tokenRevoked).toBe(false);
  });

  test("a valid token with a stale revoke-shaped token_error → tokenRevoked false", () => {
    // signedIn wins: a live token is never treated as revoked, even if the CLI
    // still carries a leftover error string.
    const status = parseGwsAuthStatus(
      JSON.stringify({ client_config_exists: true, token_valid: true, token_error: "invalid_grant" })
    );
    expect(status.signedIn).toBe(true);
    expect(status.tokenRevoked).toBe(false);
  });

  test("non-JSON output → notInstalled with tokenRevoked false", () => {
    const status = parseGwsAuthStatus("zsh: command not found: gws\n");
    expect(status.installed).toBe(false);
    expect(status.tokenRevoked).toBe(false);
  });

  test("the token_error match is case-insensitive", () => {
    const status = parseGwsAuthStatus(
      JSON.stringify({ client_config_exists: true, token_valid: false, token_error: "Fatal: Invalid_Grant returned" })
    );
    expect(status.tokenRevoked).toBe(true);
  });
});

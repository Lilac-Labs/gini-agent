import { describe, expect, test } from "bun:test";
import {
  GOOGLE_DESKTOP_OAUTH_CLIENT,
  buildAuthorizedUserCredential
} from "./google-oauth-client";

describe("GOOGLE_DESKTOP_OAUTH_CLIENT", () => {
  test("carries the Desktop client id and secret", () => {
    expect(GOOGLE_DESKTOP_OAUTH_CLIENT.clientId).toMatch(/\.apps\.googleusercontent\.com$/);
    expect(GOOGLE_DESKTOP_OAUTH_CLIENT.clientSecret).toMatch(/^GOCSPX-/);
  });
});

describe("buildAuthorizedUserCredential", () => {
  test("produces the standard gws authorized_user shape with the default client", () => {
    const parsed = JSON.parse(buildAuthorizedUserCredential("rt-123")) as Record<string, string>;
    expect(parsed).toEqual({
      type: "authorized_user",
      client_id: GOOGLE_DESKTOP_OAUTH_CLIENT.clientId,
      client_secret: GOOGLE_DESKTOP_OAUTH_CLIENT.clientSecret,
      refresh_token: "rt-123"
    });
  });

  test("uses an injected client when provided", () => {
    const parsed = JSON.parse(
      buildAuthorizedUserCredential("rt-xyz", { clientId: "cid", clientSecret: "csec" })
    ) as Record<string, string>;
    expect(parsed).toEqual({
      type: "authorized_user",
      client_id: "cid",
      client_secret: "csec",
      refresh_token: "rt-xyz"
    });
  });
});

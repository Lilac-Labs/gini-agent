import { describe, expect, test } from "bun:test";
import { buildAuthorizedUserCredential } from "./google-oauth-client";

const TEST_CLIENT = { clientId: "test-client-id", clientSecret: "test-client-secret" };

describe("buildAuthorizedUserCredential", () => {
  test("produces the standard gws authorized_user shape with the supplied client", () => {
    const parsed = JSON.parse(buildAuthorizedUserCredential("rt-123", TEST_CLIENT)) as Record<string, string>;
    expect(parsed).toEqual({
      type: "authorized_user",
      client_id: TEST_CLIENT.clientId,
      client_secret: TEST_CLIENT.clientSecret,
      refresh_token: "rt-123"
    });
  });
});

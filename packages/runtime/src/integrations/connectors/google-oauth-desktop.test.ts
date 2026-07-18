import { describe, expect, test } from "bun:test";
import { googleOauthDesktopProvider } from "./google-oauth-desktop";
import { getProvider } from "./registry";

describe("googleOauthDesktopProvider", () => {
  test("declares the expected id, label, and description", () => {
    expect(googleOauthDesktopProvider.id).toBe("google-oauth-desktop");
    expect(googleOauthDesktopProvider.label).toBe("Google Workspace OAuth");
    expect(googleOauthDesktopProvider.description).toMatch(/Google Workspace/);
    expect(googleOauthDesktopProvider.description.length).toBeGreaterThan(0);
  });

  test("declares client_id as a required secret field", () => {
    // client_id is a credential component (resolved into the gws CLI env), so
    // it is marked secret to route through the request dialog's `secrets` map
    // and persist under purpose "client_id" rather than being dropped as
    // non-secret metadata.
    const field = googleOauthDesktopProvider.fields.find((f) => f.name === "client_id");
    expect(field).toBeDefined();
    expect(field!.label).toBe("Client ID");
    expect(field!.secret).toBe(true);
    expect(field!.required).toBe(true);
    expect(field!.placeholder).toMatch(/apps\.googleusercontent\.com/);
  });

  test("declares client_secret as a required secret field", () => {
    const field = googleOauthDesktopProvider.fields.find((f) => f.name === "client_secret");
    expect(field).toBeDefined();
    expect(field!.label).toBe("Client secret");
    expect(field!.secret).toBe(true);
    expect(field!.required).toBe(true);
    expect(field!.placeholder).toMatch(/GOCSPX-/);
  });

  test("maps env bindings to the gws CLI's expected variable names", () => {
    expect(googleOauthDesktopProvider.secrets).toBeDefined();
    expect(googleOauthDesktopProvider.secrets!.purposes).toEqual([
      "client_id",
      "client_secret"
    ]);
    expect(googleOauthDesktopProvider.secrets!.envBindings).toEqual({
      GOOGLE_WORKSPACE_CLI_CLIENT_ID: "client_id",
      GOOGLE_WORKSPACE_CLI_CLIENT_SECRET: "client_secret"
    });
  });

  test("defines no probe — OAuth client validation happens in `gws auth login`", () => {
    // Health falls back to the presence-only branch in `checkConnector`,
    // which marks the connector healthy when `status === "configured"`.
    // The downstream `gws auth login` is the real validation step.
    expect(googleOauthDesktopProvider.probe).toBeUndefined();
  });

  test("registers under its declared id in the provider registry", () => {
    const found = getProvider("google-oauth-desktop");
    expect(found).toBeDefined();
    expect(found!.id).toBe("google-oauth-desktop");
    expect(found!.label).toBe(googleOauthDesktopProvider.label);
  });

  test("declares no provider-owned setup skill", () => {
    // Account connection is owned by the local browser OAuth flow. The provider
    // therefore does not gate request_connector behind a read_skill prerequisite.
    expect(googleOauthDesktopProvider.setupSkill).toBeUndefined();
  });

  test("activates Workspace skills for an attached account", () => {
    // The presence of any registered Google account satisfies the workspace
    // credential — this is the gate that flips the Workspace API skills ACTIVE
    // once the local flow attaches the account to the instance.
    expect(typeof googleOauthDesktopProvider.credentialExternallySatisfied).toBe("function");
    expect(googleOauthDesktopProvider.credentialName).toBe("google-workspace-oauth");
  });

  test("declares no provider-owned request instructions or params", () => {
    // Skill-specific instruction text (Cloud Console URLs, multi-step
    // walkthroughs) belongs in the skill body, not the provider module.
    // The provider is a generic OAuth Desktop client descriptor; the
    // dispatcher substitutes `${var}` from the model's `reason` field at
    // call time when the skill passes `params`.
    expect(googleOauthDesktopProvider.requestInstructions).toBeUndefined();
    expect(googleOauthDesktopProvider.requestParams).toBeUndefined();
  });
});

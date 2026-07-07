import type { ProviderModule } from "./types";
import { readGoogleAccounts } from "../../state/google-accounts";

// Google Workspace OAuth credential provider (hosted). In the hosted product
// every guest ships with its Google Workspace credential already in place: the
// host bakes the OAuth client + tokens into the guest at provisioning time and
// registers the primary Google account when the guest boots. The Workspace API
// skills therefore find a satisfied credential from the first turn — there is no
// local desktop install, no `gcloud`, no OAuth-loopback grant, and no in-product
// setup flow for the user to run.
//
// This module still exists as the canonical handle for the workspace
// credential: its `credentialName` is the name the Workspace skills declare, and
// `credentialExternallySatisfied` is the gate that flips those skills ACTIVE
// once the boot-registered account is present. The `fields`/`secrets`/env
// bindings describe the shape of the OAuth client id/secret pair so the gws CLI
// env can be populated on the paths that need it; they are baked by the host
// rather than collected through a Connect dialog.
export const googleOauthDesktopProvider: ProviderModule = {
  id: "google-oauth-desktop",
  label: "Google Workspace OAuth",
  description:
    "OAuth client for Google Workspace API access. Provisioned into the hosted guest; used by gws for Workspace API authentication.",
  // Help page surfaced as a "how these credentials work" reference under the
  // connector detail view. Rendered inline as a doc slide-over via DocReference.
  docsUrl: "https://gini.lilaclabs.ai/docs/connectors/google-services/set-up",
  fields: [
    {
      // Marked secret so the credential id/secret pair is stored encrypted like
      // every other secret. The OAuth client id is a credential component the
      // runtime resolves into the gws CLI env, so it is kept in `secrets` (→ a
      // secretRef under purpose "client_id") rather than as a non-secret
      // metadata field.
      name: "client_id",
      label: "Client ID",
      description: "Looks like 1234567890-abcdef.apps.googleusercontent.com",
      secret: true,
      required: true,
      placeholder: "1234567890-abcdef.apps.googleusercontent.com"
    },
    {
      name: "client_secret",
      label: "Client secret",
      description: "Starts with GOCSPX-",
      secret: true,
      required: true,
      placeholder: "GOCSPX-..."
    }
  ],
  secrets: {
    purposes: ["client_id", "client_secret"],
    envBindings: {
      GOOGLE_WORKSPACE_CLI_CLIENT_ID: "client_id",
      GOOGLE_WORKSPACE_CLI_CLIENT_SECRET: "client_secret"
    }
  },
  // Canonical credential handle the Workspace skills reference by name. NOT the
  // module id ("google-oauth-desktop"): the LOCKED name is the workspace handle
  // so the skills, the credential resolver, and the connector registry all agree
  // (surfaced through canonicalCredentialName in connectors/registry.ts).
  credentialName: "google-workspace-oauth",
  // The boot-registered Google account (ADR google-multi-account.md) satisfies
  // the workspace credential without any connector record. In hosted this
  // account is always present: the host registers the guest's primary Google
  // account at boot, so `readGoogleAccounts()` is non-empty from the first turn
  // and the Workspace API skills stay ACTIVE. Each account's config dir carries
  // its own OAuth client + tokens, so the gws CLI needs no client env vars on
  // that path — which is why `bindingsForCredentials` is untouched. Presence-only
  // by design: sign-in expiry is handled by the skill recipes at run time (`gws
  // auth status`), not by this gate.
  credentialExternallySatisfied: () => readGoogleAccounts().length > 0
};

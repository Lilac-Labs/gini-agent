import type { ProviderModule } from "./types";
import { googleAccountsForInstance } from "./google-accounts";

// Canonical Google Workspace OAuth credential provider. Its `credentialName`
// is the handle Workspace skills declare, while
// `credentialExternallySatisfied` activates those skills once this instance
// has an attached Google account. The fields describe an optional user-supplied
// Desktop OAuth client for the local browser flow and gws subprocesses.
export const googleOauthDesktopProvider: ProviderModule = {
  id: "google-oauth-desktop",
  label: "Google Workspace OAuth",
  description:
    "Desktop OAuth client for connecting Google Workspace accounts locally and authenticating gws.",
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
  // An attached Google account (ADR google-multi-account.md) satisfies the
  // workspace credential without a connector record. Each account's config dir
  // carries its own OAuth client and tokens, so gws needs no client env vars on
  // that path. Presence-only by design: sign-in expiry is handled by the skill
  // recipes at run time (`gws auth status`), not by this gate.
  credentialExternallySatisfied: (instance) => googleAccountsForInstance(instance).length > 0
};

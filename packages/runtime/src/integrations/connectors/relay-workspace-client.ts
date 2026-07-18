// The distributed Google OAuth Desktop client used by the local browser flow
// and the optional gini-relay Workspace grant.
//
// This is the SAME client the relay server authenticates against
// (GINI_GOOGLE_CLIENT_ID/_SECRET on the relay): the relay mints a refresh token
// bound to this client, and a refresh token can only be redeemed by the client
// that minted it — so gws must redeem it with this client's id + secret.
//
// The secret is baked in ON PURPOSE. This is a Desktop ("installed app") OAuth
// client, whose secret Google explicitly does not treat as confidential
// (https://developers.google.com/identity/protocols/oauth2, "Installed
// applications": "the client secret is obviously not treated as a secret"). A
// Desktop client is designed to ship inside the distributed app; PKCE, not the
// secret, is what protects the local browser flow. Storing it here also lets
// gws redeem a relay-issued refresh token with the same client.
export interface RelayWorkspaceClient {
  clientId: string;
  clientSecret: string;
}

export const RELAY_WORKSPACE_CLIENT: RelayWorkspaceClient = {
  clientId: "911117879651-1ha20s2fsks6c7aim71il0s48rpoabd4.apps.googleusercontent.com",
  clientSecret: "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"
};

// Build the standard Google "authorized_user" credential JSON gws reads from a
// config dir's credentials.json (precedence tier 4) or GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE.
// Pure + serialized here so the exact on-disk shape is unit-testable.
export function buildAuthorizedUserCredential(
  refreshToken: string,
  client: RelayWorkspaceClient = RELAY_WORKSPACE_CLIENT
): string {
  return JSON.stringify(
    {
      type: "authorized_user",
      client_id: client.clientId,
      client_secret: client.clientSecret,
      refresh_token: refreshToken
    },
    null,
    2
  );
}

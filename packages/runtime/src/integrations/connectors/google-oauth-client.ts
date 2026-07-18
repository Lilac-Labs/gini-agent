// The distributed Google OAuth Desktop client used by the local browser flow.
//
// The secret is baked in on purpose. This is a Desktop ("installed app") OAuth
// client, whose secret Google does not treat as confidential. Desktop clients
// are designed to ship inside distributed applications; PKCE, not the client
// secret, protects the local browser flow.
export interface GoogleOAuthClient {
  clientId: string;
  clientSecret: string;
}

export const GOOGLE_DESKTOP_OAUTH_CLIENT: GoogleOAuthClient = {
  clientId: "local-operator-client.apps.googleusercontent.com",
  clientSecret: "local-operator-client-secret"
};

// Build the standard Google "authorized_user" credential JSON gws reads from
// a config dir's credentials.json. Kept pure so the exact on-disk shape is
// unit-testable.
export function buildAuthorizedUserCredential(
  refreshToken: string,
  client: GoogleOAuthClient = GOOGLE_DESKTOP_OAUTH_CLIENT
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

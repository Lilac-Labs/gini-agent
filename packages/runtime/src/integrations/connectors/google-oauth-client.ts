// Google OAuth Desktop client supplied by the local operator. The public
// runtime never ships a project-owned client id or secret; the pair resolves
// from the encrypted google-workspace-oauth connector at login start.
export interface GoogleOAuthClient {
  clientId: string;
  clientSecret: string;
}

// Build the standard Google "authorized_user" credential JSON gws reads from
// a config dir's credentials.json. The caller must pass the same local client
// that minted the refresh token; there is deliberately no bundled fallback.
export function buildAuthorizedUserCredential(
  refreshToken: string,
  client: GoogleOAuthClient
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

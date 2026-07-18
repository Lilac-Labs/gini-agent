# Google Workspace setup

Connect Gini to Google so it can work with Gmail, Calendar, Drive, Docs,
Sheets, Forms, and Meet on your behalf.

## Requirements

- A Google account. A personal `@gmail.com` account works; a paid Workspace
  subscription is not required.
- The official [Google Workspace CLI](https://github.com/googleworkspace/cli)
  (`gws`) installed on the machine running Gini.
- The web app opened on that same machine through `localhost` or `127.0.0.1`.
  Google's Desktop OAuth redirect returns to the browser's loopback address.

Install `gws` with one of its official packages if it is not already present:

```bash
brew install googleworkspace-cli
# or
bun add -g @googleworkspace/cli
```

## Connect an account

1. Open **Integrations** in Gini.
2. Open **Google Workspace** and choose **Set up Google OAuth**.
3. [Create a Desktop OAuth client](https://developers.google.com/workspace/guides/create-credentials#desktop-app)
   in your own Google Cloud project, then paste its client ID and client secret
   into Gini. Gini stores both encrypted on the local machine.
4. Choose **Add account** and complete Google's consent screen in the same
   browser tab.
5. Google returns you to Gini, which stores the resulting gws credential in a
   private account directory under `~/.gini/google-accounts/`.

Gini does not ship a shared Google OAuth client. Each installation uses the
operator-supplied Desktop client, while PKCE and a one-time state value protect
the local authorization-code flow. OAuth client values and tokens never enter
chat, traces, or browser responses.

Each runtime instance has its own account bindings. Connecting an account to
one instance does not expose it in another instance's UI. You can add several
accounts, assign readable tags, and select one primary account.

## Reconnect or disconnect

If Google revokes or expires a refresh token, the account row shows
**Reconnect**. Complete the same local consent flow to update that account in
place without changing its id or tag.

A secondary account can be disconnected from the current instance without
deleting its machine credential. To disconnect the primary, select another live
account as primary first. Removing a managed account deletes its private gws
credential directory; removing an adopted `~/.config/gws` account never deletes
that external directory.

## Troubleshooting

- **The page says the origin must be loopback** — open the web app on the Gini
  host through `http://localhost:<port>` or `http://127.0.0.1:<port>` and retry.
- **Google OAuth is not configured** — open **Integrations → Google**, choose
  **Set up Google OAuth**, and store a Desktop client from your Google Cloud
  project before adding an account.
- **gws is not installed** — install only the official
  `googleworkspace/cli` package using one of the commands above.
- **The token was revoked** — use **Reconnect** on the existing account rather
  than adding a duplicate.
- **A service is unavailable** — reconnect and grant the scope required by that
  service.

See ADR [google-multi-account.md](../../adr/google-multi-account.md) for the
credential and instance-isolation design.

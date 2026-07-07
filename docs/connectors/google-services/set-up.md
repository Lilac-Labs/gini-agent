# Google Workspace setup

Connect Gini to your Google account so it can work with **Gmail, Calendar, Drive, Docs, Sheets, Forms, and Meet** on your behalf. Setup is a one-time, guided flow that runs inside chat — the first time you ask Gini to do anything with Google ("check my calendar," "find that Drive doc"), it walks you through everything below.

The OAuth client Gini uses lives in **your own** Google Cloud project. Your credentials are stored in Gini's encrypted secret store and are never written to chat, logs, or disk.

> **Managed deployments:** if your Gini is hosted for you, the Google credential is provisioned when you sign in — there is nothing to install and no setup flow to run, and the granted scopes are fixed at sign-in. The rest of this page applies to self-hosted installs.

## What you need

- A Google account. A personal **@gmail.com** works — you do **not** need a paid Google Workspace subscription.
- **No credit card.** The Google Workspace APIs are free, so there's no billing account and no card on file. This is the exception to Google Cloud's usual rules: most Cloud APIs require billing, but the Workspace ones don't.
- macOS or Linux. Gini installs the `gws` and `gcloud` command-line tools for you.

## How setup works

Gini drives this in chat; you only act at the browser steps.

1. **Confirm.** Gini tells you Google isn't connected yet and asks to set it up.
2. **Install tools.** Gini installs `gws` and `gcloud` in the background.
3. **Sign in.** Gini runs `gcloud auth login` and your browser opens to Google's sign-in. Use the account you want Gini to act as.
4. **Project + APIs.** Gini creates a Cloud project named **Gini Workspace** in your account and enables the seven Workspace APIs. (If a previous run already made one, it reuses it.)
5. **Connect form.** Gini posts a card in chat with two Cloud Console links — one to configure the consent screen, one to create a **Desktop OAuth client**. You create the client, then paste the **Client ID** and **Client Secret** into the form and click **Save**.
6. **Grant access.** Gini runs `gws auth login` and your browser opens to Google's consent screen, which lists each product as its own checkbox. Tick what you want Gini to access and continue.

Your original request then resumes automatically.

## Already have an OAuth client?

If you already created a Desktop OAuth client (you have a **Client ID** and **Client Secret** in hand), you can skip the chat walkthrough: open the **Skills** page, find **Google Workspace setup**, and use **Enter ID & secret** to paste them directly. Gini stores them in the same encrypted secret store and then only needs to sign you in — it won't re-run project creation or API enablement. Re-running setup later is also safe: once a client is stored, Gini goes straight to signing you in.

## First-time Google Cloud users — no credit card needed

You don't need a paid Google Workspace or a credit card. The Workspace APIs are free, so the project Gini creates for you has no billing attached. If you've never opened Google Cloud, its console pushes a prominent *"Start your free trial — add a card"* banner during the OAuth-client step (Step 5) — **ignore it.** You can configure the consent screen and create the OAuth client without starting the trial or entering any payment method.

The only places you touch the browser are Step 5 (the OAuth consent screen and client) and the two sign-in pop-ups. Project creation and API enablement happen automatically — on a brand-new account too.

## Work or school accounts

Managed Google Workspace accounts (for example `you@yourcompany.com`) are often configured so only admins can create Cloud projects. If creation fails with **"You do not have permission to create projects,"** accepting the Terms of Service won't help. Either:

- give Gini an existing Cloud project ID you're allowed to use (ask your Workspace admin), or
- run setup with a personal **@gmail.com** account instead.

## What Gini can access

Gini asks for all seven products up front so you don't have to repeat setup when you move from, say, Calendar to Drive. You decide what to actually grant on Google's consent screen — each product is its own checkbox. You can also tell Gini "read-only" or "Gmail only" before that step to narrow what it requests.

## Multiple accounts

You can connect more than one Google account (for example a personal mailbox and a work mailbox) — just ask Gini to connect another account; each one gets its own tag (`personal`, `work`, …). Gini then picks the right account per request: a request that names an account (a tag or email) runs against that account; an unscoped read ("what's on my calendar", "search my email") runs against every connected account and aggregates the results; a write with no account named makes Gini ask which account first — there is no silent default. See [Multiple Tagged Google Accounts](../../adr/google-multi-account.md) for the full model.

## Use it

Once setup finishes, just ask — "what's on my calendar today?", "share that doc with Sam," "draft a reply to the last email from Pat." Gini runs the request through `gws` against your account.

## Troubleshooting

- **"Callers must accept Terms of Service"** (rare) — open <https://console.cloud.google.com/> once, accept the free terms (no card), then ask Gini to retry.
- **"You do not have permission to create projects"** — managed-account restriction; use an existing project or a personal account (see above).
- **Rate-limited project creation** — Google caps how many projects you can create in a short window; wait ~10 minutes and retry, or point Gini at an existing project.
- **"invalid_client" at the consent step** — the Client ID or Secret was mistyped; redo the Connect form.
- **"redirect_uri mismatch"** — the OAuth client was created as a *Web* application; recreate it as a **Desktop app** and paste the new credentials.

---

Under the hood, Gini follows the `google-workspace-setup` skill, and credentials are captured through the inline Connect form described in [Chat credential provisioning](../../adr/chat-credential-provisioning.md).

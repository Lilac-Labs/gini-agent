# Gini mobile

Expo + TypeScript client for the Gini runtime. The runtime gateway is the
source of truth; this app is a thin chat / agent-picker UI on top of the
existing `/api/*` HTTP contract — same surface the web client uses, except
the mobile app holds its own bearer token rather than relying on a BFF.

## Run

From the repo root:

```bash
bun run mobile        # forwards to `bun --cwd packages/mobile run start`
```

Or from `packages/mobile/`:

```bash
bun install
bun run start         # Metro + Expo Dev Tools (universal)
bun run ios           # iOS simulator
bun run android       # Android emulator
bun run web           # Web preview
```

Typecheck (kept separate from the root `typecheck` script so the web/runtime
flow stays fast):

```bash
cd packages/mobile && bunx tsc --noEmit
```

## First-run setup

The mobile app does not embed the gateway URL or token — you paste them
on the setup screen the first time you launch.

- **Base URL**: the runtime gateway. Defaults to `http://localhost:7421`.
  For a real device on the same network, use your machine's LAN IP
  (e.g. `http://192.168.1.42:7421`); the simulator/emulator can keep
  `localhost`. Off-LAN access (Tailscale, or another stable address in
  front of the gateway) is reached the same way — point the base URL at
  whatever address fronts the gateway.
- **Bearer token**: copy it from `~/.gini/instances/<instance>/config.json`
  (the `token` field) or run `gini status` and look for the token line.

The setup screen calls `GET /api/status` once to validate; if it
returns JSON, the credentials are persisted with `AsyncStorage` and
you're routed to the agent picker.

The manual token from `gini status` does not expire; the credentials
stay valid until you rotate the gateway token.

## Behavior

- **Agents** is the home screen. Tapping an agent activates it on the
  gateway via `POST /api/agents/:id/use` and opens that agent's chat
  list. The active agent shows a checkmark.
- **Chats** lists `GET /api/chat?agentId=<id>` sorted by `updatedAt`.
  The `+` header button creates a new chat (`POST /api/chat`) and opens
  it immediately.
- **Chat detail** seeds with one `GET /api/chat/:id/blocks` fetch and
  then subscribes to `GET /api/chat/:id/stream` (Server-Sent Events via
  `react-native-sse`) for live block updates. Reconnects carry a
  `Last-Event-ID` header so the gateway only replays what was missed.
  Messages render bottom-aligned; the assistant placeholder shows the
  task's `currentStep` ("Thinking" / "Working" / …) until the task
  reaches a terminal state, at which point the client calls
  `POST /api/chat/:id/tasks/:taskId/sync` if no paired assistant block
  materialised on its own.

## Fork & re-skin

Gini is open source — the iOS app is yours to fork, rebrand, and ship
under your own Apple developer account. Two files to edit.

**1. `packages/mobile/app.json`:**

| Path                                                                             | Replace with                                  |
|----------------------------------------------------------------------------------|-----------------------------------------------|
| `expo.name`                                                                      | your app's display name                       |
| `expo.slug`                                                                      | your EAS slug (lowercase, hyphenated)         |
| `expo.scheme`                                                                    | your deep-link scheme (e.g. `myagent`)        |
| `expo.ios.bundleIdentifier`                                                      | your reverse-DNS bundle id                    |
| `expo.android.package`                                                           | same as `bundleIdentifier`                    |
| `expo.owner`                                                                     | your Expo account or org (`expo whoami`)      |
| `expo.extra.eas.projectId`                                                       | from `eas init` in `packages/mobile/`                  |
| `expo.updates.url`                                                               | `https://u.expo.dev/<your-eas-project-id>`    |
| `expo.extra.eas.build.experimental.ios.appExtensions[0].bundleIdentifier`        | `<your-bundle-id>.notificationservice`        |
| `expo.plugins[…with-approval-notification-service].appleTeamId`                  | developer.apple.com → Membership → Team ID    |

**2. `packages/mobile/eas.json` submit profile:** replace `appleTeamId` and
`ascAppId` under `submit.production.ios` with your own before running
`eas submit`.

Then regenerate the native project:

```bash
cd packages/mobile && bunx expo prebuild --platform ios --clean
```

## iOS dev client + Notification Service Extension

Lock-screen Approve / Deny buttons on approval pushes are implemented
as an iOS Notification Service Extension (NSE), added by the Expo
config plugin in `plugins/with-approval-notification-service.js`. This
moves the app from a purely managed Expo workflow to a **dev client +
prebuild** workflow on iOS.

**Managed Expo Go no longer works for this app** because Expo Go
cannot load custom NSE targets. Use the dev client locally and EAS
Build (or `expo run:ios`) for distribution.

### One-time setup

```bash
cd packages/mobile
bun install
bunx expo prebuild --platform ios --clean   # generates ios/ from app.json
bunx expo run:ios                            # builds + boots the simulator
```

`bunx expo prebuild` writes the NSE source from
`packages/mobile/ios-extensions/ApprovalNotificationService/NotificationService.swift`
into `ios/ApprovalNotificationService/` and registers it as an Xcode
target. The generated `ios/` directory is `.gitignore`'d — the
canonical source of truth is the plugin + the Swift file under
`ios-extensions/`. Re-running `expo prebuild --clean` is the safe
way to pick up plugin changes.

### Day-to-day

After the first prebuild, normal Metro / Hot Reload works:

```bash
bun run start          # Metro
bun run ios            # boots the previously-built dev client
```

You only need to re-run `prebuild` when the plugin, the NSE Swift
source, or `app.json`'s plugin list changes.

### Distribution

EAS Build picks the plugin up automatically — `eas build --platform ios`
runs prebuild under the hood and includes the NSE target.

### What the NSE does

When an APNs payload arrives with `mutable-content: 1` (set by the
server-side dispatcher in `packages/runtime/src/integrations/apns/dispatcher.ts` for
`authorization_requested`, `setup_requested`, and `message_completed`
blocks), the OS spawns the NSE for up to 30s before showing the
notification. The NSE does two things:

1. **Enriches the banner.** It reads the gateway base URL + bearer the
   app mirrored into the App Group shared container
   (`packages/mobile/src/shared-credentials.ts`), calls
   `GET /api/push/preview` on the gateway over the device's own
   authenticated connection, and rewrites the title + body — so the
   real message text shows without tapping in, yet never transits
   Apple. On any failure it falls back to the generic as-sent banner.
2. **Attaches the approve/deny category** for `authorization_requested`
   only. `categoryIdentifier = "APPROVAL_REQUEST"` pairs with the
   category the main app registers on launch via
   `Notifications.setNotificationCategoryAsync` — that's what makes the
   Approve / Deny buttons appear. Setup requests need the app (open a
   browser, fill a form), so they deep-link on tap instead of carrying
   action buttons.

When the user taps an Approve / Deny button, `packages/mobile/src/push-dispatch.ts`
posts directly to `/api/authorizations/:id/approve` or `/deny` without
foregrounding the app. Approve is registered with `isAuthenticationRequired`,
so iOS requires an unlock (Face ID / Touch ID / passcode) before the approve
action runs — a locked phone can't authorize a high-risk action on its own.
Deny is fail-safe and needs no unlock.

The action handler runs only if the app is at least suspended; if the
user has fully killed the app from the app switcher, iOS records the
action but our JS never runs. The user must open the app and approve
from there. The approval remains pending in the runtime until acted
on — the runtime does not have a retry loop that re-emits approval
requests.

## OTA updates

JS-only changes ship over the air via EAS Update. Native config changes
(`app.json` native fields, `eas.json`, `plugins/`, `ios-extensions/`)
still require a fresh TestFlight build. The
`.github/workflows/mobile-update.yml` workflow publishes an OTA on every
push to `main` that touches `packages/mobile/**` without changing native config.

The runtime version policy in `packages/mobile/app.json` is `"appVersion"`, so the
`runtimeVersion` an update is published against equals the `version`
field at publish time. A TestFlight build is locked to the
`runtimeVersion` it was compiled with — bumping `packages/mobile/app.json`
`version` cuts a fresh runtime boundary that older builds will never
consume.

For an OTA to actually reach a device, the EAS channel that the build
listens on must be linked to a publish branch. The `production` build
profile in `eas.json` ships on channel `production`, which must point at
the `production` update branch:

```bash
eas channel:view production --json
eas channel:edit production --branch production   # one-time, if missing
```

If the channel has no branch mapping, every manifest request returns
HTTP 400 (`no branches linked to channel`) and the app silently falls
back to the embedded bundle — even though the EAS dashboard shows the
update as published.

To pick up an OTA on a TestFlight build, fully force-quit twice:

1. Cold start #1 — embedded bundle runs; new bundle downloads in the
   background.
2. Cold start #2 — new bundle is applied.

Backgrounding the app is not enough; iOS keeps the JS context alive.

## Known limitations (v1)

- The chat list (`useChats`) still polls `GET /api/chat?agentId=…`
  every 3s. There's no per-agent SSE endpoint yet; chat detail uses
  SSE but the sidebar's "Chats" list does not.
- No tool / approval UI. If a task lands on `waiting_approval`, the
  chat just sticks on "Working…" — resolve the approval from the web
  client.
- No markdown rendering, no images, no file attachments. Plain text
  bubbles only.

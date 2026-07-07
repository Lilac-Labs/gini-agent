// APNs push registration + tap / action handling for the iOS app.
// This module is iOS-only — Android/web call sites must gate on
// Platform.OS first.
//
// Lifecycle:
//   1. The chat detail screen calls `registerForPushAsync()` the first
//      time it mounts. Asking permission at the first chat moment
//      gets noticeably higher grant rates than asking on app launch.
//   2. We request notification permission (idempotent — iOS only
//      shows the prompt once).
//   3. On grant, fetch the raw APNs device token via
//      `Notifications.getDevicePushTokenAsync()`. This is the
//      hex-encoded APNs token, NOT the Expo Push token — we send
//      directly to APNs from the gateway.
//   4. POST the token to `/api/push/devices` so the gateway can fan
//      `authorization_requested` notifications out to it.
//   5. Subscribe to `addPushTokenListener` so a rotated token
//      (rare, but happens on restore-from-backup) re-registers.
//   6. Subscribe to `addNotificationResponseReceivedListener` for tap +
//      action handling, via the idempotent installNotificationResponseListener.
//      The category registered below pairs with the NSE attached on the
//      server-side `authorization_requested` payload — the OS shows
//      Approve / Deny buttons on the lock screen, and this listener routes
//      each action to the right /api/authorizations endpoint without forcing
//      the app to foreground.
//
// Note: the response listener (step 6) is ALSO installed unconditionally at
// root (`app/_layout.tsx`) on every launch — it needs no permission and must
// route taps even when no chat detail ever mounted this process. The
// `registerForPushAsync` flow re-invokes the same idempotent installer, so
// whichever path runs first wins; the listener is process-level and is not
// torn down on sign-out (see __resetRegistrationForSignOut).
//
// Action handling caveat: `opensAppToForeground: false` means the OS
// only invokes the response listener if the app is backgrounded
// (suspended). If the user has fully killed the app from the app
// switcher, the action button still posts the response, but our
// listener never runs because there's no JS to run. Apple does not
// expose a way around this for non-foregrounding actions. The user
// must open the app and approve from there. The approval remains
// pending in the runtime until acted on — the runtime does not have
// a retry loop that re-emits approval requests.
//
// Idempotency: the gateway's POST handler is an upsert. Calling
// register multiple times (e.g. across screen mounts) is safe — the
// row's `last_seen_at` is bumped and nothing else changes.

import { Platform } from "react-native";
import { router, type Href } from "expo-router";
import * as Notifications from "expo-notifications";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { api, ApiError } from "./api";
import {
  APPROVAL_CATEGORY,
  APPROVAL_CATEGORY_ACTIONS,
  APPROVE_ACTION,
  DENY_ACTION,
  buildChatRoute,
  consumeLaunchTap,
  dispatchNotificationResponse
} from "./push-dispatch";
import {
  bumpGeneration,
  captureGeneration,
  isStillCurrent
} from "./push-registration-guard";
import { createDeviceTokenStore, type Storage } from "./device-token-store";

// AsyncStorage's API matches our Storage shape exactly — adapt with a
// thin wrapper so the store stays unaware of the native module.
const asyncStorageAdapter: Storage = {
  getItem: (key) => AsyncStorage.getItem(key),
  setItem: (key, value) => AsyncStorage.setItem(key, value),
  removeItem: (key) => AsyncStorage.removeItem(key)
};

// Module-singleton store backed by AsyncStorage. Constructed eagerly
// so primeDeviceTokenFromStorage / getCachedDeviceToken can read
// through it from the first call.
const deviceTokenStore = createDeviceTokenStore(asyncStorageAdapter);

// Re-export the dispatch identifiers so existing call-sites that
// imported from `./push` continue to compile. The pure dispatcher
// lives in `./push-dispatch` so unit tests can exercise it without
// loading react-native / expo-notifications.
export { APPROVAL_CATEGORY, APPROVE_ACTION, DENY_ACTION, dispatchNotificationResponse };
export type {
  NotificationDispatchOutcome,
  DispatchDeps,
  ResponseLike
} from "./push-dispatch";

// Foreground presentation rule. Silent (content-available) pushes
// must never surface a banner or play a sound — the badge update is
// what they're for, and we manage that explicitly via refreshBadge
// rather than letting APS set it. Alert payloads (authorization_requested
// and message_completed) keep their banner so the user notices the
// signal without unlocking the device. Setting this once at module
// load means every received notification is classified at delivery.
//
// The classifier branches explicitly on `silent === false` for the
// alert path — anything else (silent === true, missing, malformed)
// defaults to the silent presentation. That keeps a future malformed
// payload from accidentally banner-ing the user in foreground.
Notifications.setNotificationHandler({
  handleNotification: async (notification) => {
    // expo-notifications surfaces the remote `userInfo["body"]` object
    // as `content.data` — top-level userInfo keys (including `aps`) are
    // dropped before reaching JS. The server-side dispatcher writes a
    // boolean `silent` discriminator inside `body` so the client can
    // classify without depending on aps internals.
    const data = notification.request.content.data as { silent?: unknown } | undefined;
    const isAlert = data?.silent === false;
    if (isAlert) {
      return {
        shouldShowAlert: true,
        shouldPlaySound: true,
        shouldSetBadge: false,
        shouldShowBanner: true,
        shouldShowList: true
      };
    }
    return {
      shouldShowAlert: false,
      shouldPlaySound: false,
      shouldSetBadge: false,
      // SDK 54's NotificationBehavior added the banner / list flags
      // alongside shouldShowAlert; the older field is preserved for
      // back-compat but the new ones are what iOS actually reads.
      shouldShowBanner: false,
      shouldShowList: false
    };
  }
});

// Registers the APPROVAL_REQUEST notification category so the OS
// renders inline Approve / Deny actions on lock screen and banner.
// Both actions are non-foregrounding (`opensAppToForeground: false`)
// — the listener below dispatches them straight to the gateway. iOS
// caches categories per-install; calling this idempotently on app
// launch is the documented pattern.
//
// Exported for tests; production callers go through the implicit
// invocation in `registerForPushAsync`. The first call caches its
// promise so concurrent callers (root layout effect, the implicit
// invocation inside registerForPushAsync) share a single registration
// rather than racing two `setNotificationCategoryAsync` calls. The
// shared promise also makes it safe to `await` from the response
// listener path, guaranteeing the category exists before any push
// can fire its Approve / Deny buttons against it.
let categoryRegistration: Promise<void> | null = null;
export function registerApprovalCategoryAsync(): Promise<void> {
  if (categoryRegistration) return categoryRegistration;
  categoryRegistration = (async () => {
    if (Platform.OS !== "ios") return;
    try {
      // Action specs (including the Approve auth-required invariant) live
      // in push-dispatch.ts so they're unit-testable without the native
      // module. expo-notifications wants a mutable array, so copy it.
      await Notifications.setNotificationCategoryAsync(
        APPROVAL_CATEGORY,
        APPROVAL_CATEGORY_ACTIONS.map((action) => ({ ...action }))
      );
    } catch {
      // setNotificationCategoryAsync can throw on the very first launch
      // before the native module is ready. Clear the cached promise so
      // a subsequent mount can retry instead of memoizing the failure.
      categoryRegistration = null;
    }
  })();
  return categoryRegistration;
}

// Schedules an immediate local notification so the user gets a visible
// signal when an action button failed (e.g. network down at the moment
// of the tap). The body deliberately stays generic for privacy.
async function notifyActionFailure(verb: "approve" | "deny"): Promise<void> {
  if (Platform.OS !== "ios") return;
  try {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: `Failed to ${verb}`,
        body: "Open the app to retry.",
        sound: "default"
      },
      // `null` trigger means "fire immediately".
      trigger: null
    });
  } catch {
    // Local notifications can fail in unusual states (permission
    // revoked between original push and this callback). The /api
    // call already failed, so there's nothing more we can do here.
  }
}

// Fetch the latest unread total from the gateway and apply it as the
// app icon's badge count. Used as the side-effect of a silent push and
// once on initial mount (so a cold launch picks up everything that
// landed while the app was killed).
export async function refreshBadge(): Promise<void> {
  if (Platform.OS !== "ios") return;
  try {
    const { unread } = await api<{ unread: number }>("/badge");
    await Notifications.setBadgeCountAsync(unread);
  } catch (error) {
    // 401 means we lost auth — leave the badge alone (the next /chat
    // navigation will route to the signed-out screen). Other errors are transient
    // network blips; the next event-driven refresh will catch up.
    if (error instanceof ApiError && error.status === 401) return;
    // swallow — badge accuracy is best-effort
  }
}

// Deep-links to the chat a notification names. A completion surfaces in its
// session (a Topic or a Chat), so the tap opens that session's chat detail.
// Shared by the live-tap response listener and the cold-start launch-tap
// consume so both navigate to exactly the same route.
function navigateToChat(sessionId: string): void {
  // Route construction (encode) lives in the native-free buildChatRoute so
  // it's unit-testable; this wrapper just performs the push. buildChatRoute
  // returns a plain string (it's native-free); cast to Href for expo-router's
  // typed-route signature — the path always matches the declared
  // /chat/[sessionId] route.
  router.push(buildChatRoute(sessionId) as Href);
}

// Installs the live notification-response listener that routes taps and
// Approve/Deny actions while the JS runtime is alive (foreground or
// suspended). Idempotent via the module-scoped `responseSub` guard, and
// requires NO notification permission — listening for a response the OS
// hands us is always safe — so it's installed unconditionally at root
// (app/_layout.tsx) on every launch, not gated behind the permission-prompt
// flow in registerForPushAsync. Without the root install, a tap that arrived
// while the app was suspended on a screen that never opened a chat detail
// (so registerForPushAsync had never run) would be dropped.
//
// Handles three cases via dispatchNotificationResponse:
//   - Default tap (no actionIdentifier, or the OS default action) → deep-link
//     to the chat the payload names.
//   - APPROVE action → POST /api/authorizations/:id/approve.
//   - DENY action → POST /api/authorizations/:id/deny.
// Both action endpoints pre-date the push surface and enforce auth +
// ownership. The action handler runs in the background while the app is
// suspended; iOS gives up to 30s of JS time, plenty for one POST.
export function installNotificationResponseListener(): void {
  if (Platform.OS !== "ios") return;
  if (responseSub) return;
  responseSub = Notifications.addNotificationResponseReceivedListener((response) => {
    void dispatchNotificationResponse(response, {
      apiCall: (path, init) => api(path, init),
      navigate: navigateToChat,
      notifyFailure: notifyActionFailure
    }).finally(() => {
      // A tap handled live is ALSO retained by the OS as the "last
      // notification response". Clear it so a later channels mount's
      // consumeLaunchNotificationRoute() can't replay this already-handled
      // tap (which, after a sign-out → sign-in remount, could navigate into
      // a chat from the prior credential). The cold-start path is the only
      // consumer that should ever act on the stored response.
      try {
        Notifications.clearLastNotificationResponse();
      } catch {
        // Native module not ready — the stored response is harmless until
        // the next consume attempt, which clears it itself.
      }
    }).catch(() => {
      // dispatchNotificationResponse only rejects if the injected navigate
      // (router.push) throws synchronously — the action branches swallow API
      // errors themselves. Swallow here so a throwing navigate on this
      // fire-and-forget path can't surface as an unhandled promise rejection.
    });
  });
}

// Cold-start launch-tap recovery. When the app is launched from a fully
// killed state by a notification tap, iOS does NOT replay that tap through
// the response listener (the listener only fires for taps received while
// the JS runtime is already alive). `getLastNotificationResponse()` returns
// the tap that launched the process; we route it to the right chat, then
// clear it so a later remount can't navigate a second time off the same tap.
//
// Called from the authed landing screen (channels) on mount. The index auth
// gate is presence-only — it routes a MISSING credential to the signed-out screen but lets a
// stale/expired one through — so a dead token here pushes the chat
// optimistically (same as tapping any agent/channel row), then the chat
// screen's own 401 handler clears the token and redirects to the signed-out screen;
// the next cold start skips straight there. Best-effort and iOS-gated: any failure
// leaves the user on the screen they're already on.
//
// Approve/Deny action launches resolve to null in resolveLaunchTapRoute, so
// they never navigate here. Returns the route it navigated to (or null) so
// callers/tests can assert the outcome.
export function consumeLaunchNotificationRoute(): { sessionId: string } | null {
  if (Platform.OS !== "ios") return null;
  try {
    // The get → clear-once → navigate sequence lives in the native-free
    // consumeLaunchTap (push-dispatch) so its ordering is unit-testable; we
    // inject the real Notifications APIs + router here.
    return consumeLaunchTap({
      getLast: () => Notifications.getLastNotificationResponse(),
      clear: () => Notifications.clearLastNotificationResponse(),
      navigate: navigateToChat
    });
  } catch {
    // getLastNotificationResponse / clearLastNotificationResponse can throw
    // in unusual states (native module not ready on a very early mount).
    // The next mount retries; a missed deep-link just leaves the user on
    // the channels home, which is a safe landing.
    return null;
  }
}

// Tracks whether we've already started the registration flow this
// process. The chat detail screen mounts on every navigation; we
// don't want to spam permission requests / token fetches on every
// remount. iOS will short-circuit duplicate permission requests
// internally, but the network round-trip is wasteful and the token
// listener subscription would leak.
let registrationStarted = false;

// Generation counter logic lives in `./push-registration-guard` so
// the race-guard invariants can be unit-tested without loading the
// native surfaces. Any registration that starts in generation N must
// short-circuit (no cache write, no listener install) if the counter
// has advanced by the time its async work resolves. Without this
// guard, a sign-out that races a still-in-flight registration POST
// would wipe the credential, then the late-arriving POST handler
// would cache the token + install listeners under the wiped
// credential — leaving an orphaned subscription alive on the device.

// Promise for the currently-running registerForPushAsync invocation,
// if any. Sign-out awaits this (with a timeout) before bumping the
// generation so an in-flight POST has a chance to settle naturally;
// anything that resolves AFTER the bump still short-circuits via the
// generation check.
let registrationInFlight: Promise<void> | null = null;

// Public hook for the sign-out path. Resolves when the current
// registerForPushAsync run finishes (success or failure), or
// immediately if no registration is in flight. Callers should race
// this against a short timeout so a stuck network can't block
// sign-out indefinitely.
export function awaitRegistrationInFlight(): Promise<void> {
  return registrationInFlight ?? Promise.resolve();
}

// The mobile runtime needs the cached APNs token on every /read,
// /badge, and SSE open so the gateway can scope reads + watch-state to
// this specific device (rather than to the credential, which collapses
// iPhone A and iPhone B onto one row). The store keeps an in-memory
// slot for synchronous header injection and persists across cold
// launches so the X-Device-Token header is available BEFORE the async
// permission/registration flow completes. A rehydrated token may be
// stale (rotated server-side, or paired against a different
// credential), but that's fine: requests still authenticate via the
// bearer, and the eventual registerForPushAsync() re-acquires and
// re-posts the live token, repopulating the slot.

// Read-only accessor. Returns null until the device has registered
// successfully — callers should tolerate that (mobile-only endpoints
// like /badge can no-op when the token isn't set yet, since the
// badge will refresh on the next mount once registration completes).
export function getCachedDeviceToken(): string | null {
  return deviceTokenStore.read();
}

// Rehydrate the device-token cache from AsyncStorage. Called from
// the root layout's priming sequence (alongside primeCredentials)
// so header-bearing requests on cold launch (notably the initial
// refreshBadge() and any SSE open before the chat-detail screen
// mounts) carry X-Device-Token without waiting on the
// permission-gated registration flow. No-op when no token has ever
// been persisted (e.g. fresh install pre-grant) or on read failure.
export async function primeDeviceTokenFromStorage(): Promise<void> {
  await deviceTokenStore.prime();
}

// Subscription handles — kept module-scoped so a hot reload doesn't
// double-subscribe (the listeners would otherwise pile up and call
// `router.push` twice for every notification tap).
let tokenSub: Notifications.Subscription | null = null;
let responseSub: Notifications.Subscription | null = null;
let receivedSub: Notifications.Subscription | null = null;

export interface RegisterPushOptions {
  // Override the bundle id reported to the gateway — useful for
  // dev builds whose bundle differs from production. Falls back to
  // `expo-constants`' resolved bundleIdentifier; the gateway uses
  // it as the APNs topic header so prod/TestFlight builds can
  // coexist behind one set of APNs creds.
  bundleId?: string;
}

export async function registerForPushAsync(opts: RegisterPushOptions = {}): Promise<void> {
  // Step 2/3/4 are iOS-only this round. Gate hard so Android and web
  // never reach the Notifications API surface that doesn't apply.
  if (Platform.OS !== "ios") return;
  if (registrationStarted) return;
  registrationStarted = true;

  // Capture the sign-out generation at entry. Any side effect after
  // an `await` checks this against the current value before touching
  // the cache or installing a listener — if a sign-out happened
  // while we were suspended, the registration must abort silently.
  const entryGeneration = captureGeneration();

  // Always register the approval category up-front, before any
  // permission prompt. If the user has previously granted permission,
  // the next incoming approval push needs the category in place
  // immediately. If they reject permission below, the category
  // registration is harmless (no notifications will arrive to use it).
  // We start the registration here (cached via the module-scoped
  // promise) and await it below before installing the response
  // listener, so the OS sees the category before any Approve / Deny
  // action button can fire.
  const categoryReady = registerApprovalCategoryAsync();

  const run = (async () => {
    try {
      // The library's typings re-export `PermissionResponse` from 'expo'
      // for the base shape, but the 'expo' package only exports it
      // structurally — TS resolves the inherited `status` field
      // inconsistently across SDK versions. Treat the response as a
      // loose record and read `granted`, which is the convenience flag
      // documented as the authoritative grant check.
      const existing = (await Notifications.getPermissionsAsync()) as unknown as { granted?: boolean };
      let granted = Boolean(existing.granted);
      if (!granted) {
        const requested = (await Notifications.requestPermissionsAsync({
          ios: { allowAlert: true, allowBadge: true, allowSound: true }
        })) as unknown as { granted?: boolean };
        granted = Boolean(requested.granted);
      }
      if (!granted) {
        // User declined. Reset the flag so a subsequent screen-mount
        // can retry — they may have changed their mind in Settings.
        registrationStarted = false;
        return;
      }

      const bundleId = opts.bundleId ?? resolveBundleId();
      if (!bundleId) {
        // Can't register without a bundle id (the gateway requires it).
        registrationStarted = false;
        return;
      }

      // getDevicePushTokenAsync returns the raw APNs token — what we
      // want for direct-to-Apple delivery. getExpoPushTokenAsync would
      // route through Expo's push service, which is the wrong fit
      // because the gateway is the push provider and uses its own .p8.
      const token = await Notifications.getDevicePushTokenAsync();
      if (token.type === "ios") {
        await postDevice(token.data, bundleId);
        // Sign-out race guard: if a sign-out bumped the generation
        // while the POST was in flight, abort silently. The token POST
        // already succeeded server-side; the sign-out's awaited DELETE
        // is the cleanup path (it ran with knowledge that the in-flight
        // registration may have just persisted this token, because
        // sign-out awaits awaitRegistrationInFlight before issuing the
        // DELETE).
        if (!isStillCurrent(entryGeneration)) return;
        // Cache after the POST succeeds so callers downstream (api
        // helper, SSE resolver) get the same token the gateway just
        // accepted. On POST failure the store stays empty and those
        // callers no-op until the next mount's retry. The store
        // persists to AsyncStorage so the next cold launch can prime
        // the cache before registration runs again.
        void deviceTokenStore.cache(token.data);
      }

      // Re-check the generation before installing any listener. A
      // sign-out that lands here would otherwise leave the listener
      // subscribed under the wiped credential, firing into a future
      // sign-in.
      if (!isStillCurrent(entryGeneration)) return;

      // Listen for token rotations. The library debounces internally,
      // so we just forward every emission straight to the gateway.
      if (!tokenSub) {
        tokenSub = Notifications.addPushTokenListener((event) => {
          if (event.type !== "ios") return;
          // Same generation check on the rotation path: a rotation
          // callback that resolves after sign-out must not repopulate
          // the cache under a stale credential.
          const rotationGeneration = captureGeneration();
          // Fire-and-forget — if the network is down the next mount's
          // initial registration will catch up.
          void postDevice(event.data, bundleId).then(() => {
            if (!isStillCurrent(rotationGeneration)) return;
            void deviceTokenStore.cache(event.data);
          }).catch(() => { /* swallow */ });
        });
      }

      // Drain the category registration before subscribing to the
      // response listener. The listener routes Approve / Deny taps
      // against the APPROVAL_REQUEST category — installing it before
      // the category exists would let an immediate-on-launch push slip
      // through with no action buttons attached.
      await categoryReady;
      // Generation re-check: the category drain is a fresh await
      // boundary, so a sign-out that arrived during it must still be
      // honoured.
      if (!isStillCurrent(entryGeneration)) return;

      // Install the live tap / action listener (idempotent — the function
      // no-ops if it's already subscribed, e.g. from the root-layout call).
      installNotificationResponseListener();

      // Foreground delivery listener — fires for every received push,
      // including silent ones (where `setNotificationHandler` returned
      // shouldShow=false). We branch on the event discriminator from the
      // payload's data block: `phase_completed` / `phase_failed` are the
      // silent wakes the gateway fires when a task finishes and the user
      // isn't actively watching. The badge refetch is the side-effect.
      // If the relevant chat detail is already mounted, its SSE stream
      // will deliver the same block — no imperative refetch needed from
      // here.
      if (!receivedSub) {
        receivedSub = Notifications.addNotificationReceivedListener((notification) => {
          // Per the wire shape from the server-side dispatcher, all
          // routing fields are inside `userInfo["body"]`, which expo
          // surfaces as `content.data`. The `silent` boolean
          // discriminator pins whether to treat this as a background
          // wake — keying off it (rather than the now-dropped aps
          // sub-object) avoids depending on iOS internals.
          const data = notification.request.content.data as
            | { event?: string; sessionId?: string; silent?: unknown }
            | undefined;
          if (!data) return;
          if (data.silent !== true) return;
          if (data.event === "phase_completed" || data.event === "phase_failed") {
            void refreshBadge();
          }
        });
      }
    } catch {
      // Permission/token retrieval can fail on first launch in
      // unusual states (e.g. iOS Simulator without a Apple ID). Allow
      // retry on next mount.
      registrationStarted = false;
    }
  })();

  registrationInFlight = run.finally(() => {
    // Clear the in-flight slot only if we're still the active run.
    // A retry on a subsequent mount installs its own promise; we
    // mustn't clobber it from this finally.
    if (registrationInFlight === run) registrationInFlight = null;
  });
  await registrationInFlight;
}

// POST the token to /api/push/devices. The gateway's handler is an
// upsert, so calling this multiple times with the same token is a
// no-op aside from the row's last_seen_at bump.
async function postDevice(token: string, bundleId: string): Promise<void> {
  await api("/push/devices", {
    method: "POST",
    body: JSON.stringify({ token, platform: "ios", bundleId })
  });
  // Fold the freshly-registered device token into the App Group shared
  // container alongside the gateway base URL + bearer so the iOS
  // Notification Service Extension can send X-Device-Token when it fetches
  // the notification preview. Best-effort — a failure here must not fail
  // registration, and the NSE's preview endpoint works without the header.
  mirrorDeviceTokenToSharedContainer(token);
}

// Rewrite the App Group shared credentials to include the device token.
// Reads the live gateway base URL + bearer from the auth cache (the same
// pair the NSE authenticates with) and re-writes the shared file. Lazy
// requires keep the import graph acyclic (auth → push → api) and let
// non-RN bundles skip the native file write.
function mirrorDeviceTokenToSharedContainer(deviceToken: string): void {
  try {
    const auth = require("./auth") as { readCachedCredentials?: () => { baseUrl: string; token: string } | null };
    const creds = auth.readCachedCredentials?.();
    if (!creds) return;
    const shared = require("./shared-credentials") as {
      writeSharedCredentials?: (c: { baseUrl: string; token: string; deviceToken?: string }) => void;
    };
    shared.writeSharedCredentials?.({ baseUrl: creds.baseUrl, token: creds.token, deviceToken });
  } catch {
    // require can throw in non-RN envs — best effort.
  }
}

// Reads the bundle id from expo-constants. Falls back to null when
// running in contexts where constants aren't available (e.g. unit
// tests imported directly). The chat detail screen treats null as
// "skip registration for this mount".
function resolveBundleId(): string | null {
  try {
    // Dynamic import so test environments without expo-constants
    // don't crash at module load. Returns null on any failure.
    const Constants = require("expo-constants").default as { expoConfig?: { ios?: { bundleIdentifier?: string } } };
    return Constants.expoConfig?.ios?.bundleIdentifier ?? null;
  } catch {
    return null;
  }
}

// Called from auth.ts after a successful sign-out so the next
// sign-in re-runs the full registration flow (permission, token
// fetch, POST /push/devices, listener re-subscription). The cached
// token is cleared too — the new credential's gateway has a
// different devices table and we must not reuse a stale token under
// the wrong credential. Credential-scoped subscription handles are
// removed so they don't double up on the next register.
export function __resetRegistrationForSignOut(): void {
  registrationStarted = false;
  void deviceTokenStore.clear();
  // Zero the app-icon badge and clear delivered notifications so a stale count or
  // a lingering banner doesn't outlive the credential that produced it (the badge
  // reflects the signed-out account's unread total and is meaningless once gone).
  if (Platform.OS === "ios") {
    void Notifications.setBadgeCountAsync(0).catch(() => {});
    void Notifications.dismissAllNotificationsAsync().catch(() => {});
    // Drop any stored launch tap too. The cold-start consume
    // (consumeLaunchNotificationRoute) only runs on the authed landing
    // screen, so an un-consumed tap that predates this sign-out would
    // otherwise survive the signed-out detour and replay after the
    // next sign-in — navigating into a chat from the prior credential.
    try {
      Notifications.clearLastNotificationResponse();
    } catch {
      // Native module not ready — harmless; the next consume clears it.
    }
  }
  // Bump generation LAST so anything that resolves during a
  // sign-out's pre-bump drain (via awaitRegistrationInFlight) still
  // completes naturally; anything that resolves after the bump
  // short-circuits via the entryGeneration check.
  bumpGeneration();
  if (tokenSub) { tokenSub.remove(); tokenSub = null; }
  if (receivedSub) { receivedSub.remove(); receivedSub = null; }
  // NOTE: responseSub is deliberately NOT torn down. It's installed once at
  // root (app/_layout.tsx) as process-level routing infrastructure and
  // captures no credential-scoped state — only the module-level `api` (which
  // reads the CURRENT credential at call time) and the pure navigateToChat.
  // The root effect runs once per process, so removing it here would leave a
  // signed-out → signed-in user with no live tap routing until they happened
  // to open a chat detail. A tap handled while signed out self-heals: it
  // pushes the chat, the chat screen 401s, clears creds, and redirects to
  // the signed-out screen. Test isolation tears it down via __resetForTests instead.
}

// Call right before `saveCredentials` swaps the persisted base URL +
// bearer to a new pair. The new credentials may target a different
// runtime instance (different devices table, different APNs topic), so
// every short-circuit gate from the prior session must drop:
// registrationStarted, the cached token, the generation counter, and
// the credential-scoped subscriptions (token + received; the response
// listener is process-level and stays — see __resetRegistrationForSignOut).
// Functionally equivalent to __resetRegistrationForSignOut but exported
// under a name that says what the caller means at a credential-swap
// boundary; idempotent — calling on a freshly-mounted process with nothing
// cached is a no-op.
export function resetRegistrationForCredentialSwap(): void {
  __resetRegistrationForSignOut();
}

// Test-only entry — clears the in-process gates so the next call to
// registerForPushAsync runs the full flow again. Used by tests that
// drive multiple registration attempts.
export function __resetForTests(): void {
  registrationStarted = false;
  registrationInFlight = null;
  categoryRegistration = null;
  bumpGeneration();
  void deviceTokenStore.clear();
  if (tokenSub) { tokenSub.remove(); tokenSub = null; }
  if (responseSub) { responseSub.remove(); responseSub = null; }
  if (receivedSub) { receivedSub.remove(); receivedSub = null; }
}

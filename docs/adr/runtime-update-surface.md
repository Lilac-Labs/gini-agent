# ADR: Runtime update surface and automatic restart

## Decision

Expose runtime version and update operations through the authenticated
gateway API:

- `GET /api/version` returns the package version and git metadata for the
  running source tree.
- `POST /api/update/check` refreshes git metadata with `git fetch origin`
  and returns the same version shape.
- `POST /api/update` runs the same source update path as `gini update`
  against the installer-managed runtime, reinstalls root and web
  dependencies, builds the sha-keyed production web bundle for the new
  HEAD (see [Web Production Serving](web-production-serving.md)), and
  schedules a restart when the checked-out commit changed. A failed web
  build aborts the update like a failed install: no restart is scheduled
  and the old servers keep running.

The update's long steps (the `git fetch`, both `bun install`s, and the web
build — 40-90s+ together) run as **awaited async spawns**, never
`spawnSync`: the handler must not block the gateway's event loop, or the
gateway stops answering `/api/status` for the whole window and the watchdog
reads a healthy-but-updating gateway as dead. Updates are **single-flight**
— a second `POST /api/update` while one is running gets a structured 409
("gini update already in progress") instead of interleaving git/install
steps. For the duration of `updateRuntime`, an **update-in-progress marker**
(`~/.gini/update-in-progress`, machine-global because the installed runtime
is shared) tells the watchdog to suppress revive actions. Its body records
the updater's pid (`{"pid": <pid>}`) so a marker left behind by a dead
updater reads as stale immediately; the marker is removed when the update
settles and goes stale after 15 minutes regardless (see
[Always-Up Supervision](always-up-supervision.md)).

The CLI `gini update` keeps the same installer-managed target
(`~/.gini/runtime`) but no longer asks the operator to run
`gini stop && gini start`. If the selected instance is running and the
update changed code, the CLI restarts it directly.

`gini update` also converges a launchd-supervised instance's *home* onto
the installed runtime. The launchd plist home is sticky (see
[Always-Up Supervision](always-up-supervision.md)), so an instance whose
gateway plist's `WorkingDirectory` points at some other checkout keeps
executing that checkout's code across every respawn — updating
`~/.gini/runtime` alone would never reach it. After `updateRuntime`
succeeds, the CLI reads the gateway plist's `WorkingDirectory`; when it
realpath-differs from `~/.gini/runtime` (including a home that no longer
exists), it re-homes the instance — `autostart enable` with an explicit
home of the installed runtime, which regenerates the plists and restarts
the services on it — then waits for the gateway and web to report healthy.
The re-home check is deliberately independent of the sha-based restart
check: a wrongly-homed checkout can sit at the very same sha as the freshly
updated runtime while remaining the wrong thing to execute, so the home
converges even when the update reports up-to-date. Instances with no
gateway plist (foreground / `gini run` / conductor) are never re-homed.

When it is running from the installer-managed runtime, the web control
plane surfaces the version in the sidebar and lets the operator trigger
the update from the browser. Repo/worktree runs show version metadata
but do not mutate `~/.gini/runtime`; those still use normal git
workflows. The browser still never receives the gateway bearer token;
the Next.js BFF forwards same-origin requests to the gateway like other
`/api/runtime/*` calls and rejects cross-origin update POSTs.

## Context

Before this decision, update was CLI-only. The command pulled new source
and installed dependencies, then told the user to restart manually. That
was a poor fit for the local control plane: users could see and operate
Gini in the browser, but had to leave the browser for the one maintenance
action most likely to be needed after a release.

The update operation is local and privileged: it mutates
`~/.gini/runtime` and restarts processes. That means it belongs behind
the gateway's authenticated local API and should reuse the existing
installer-origin guardrails rather than adding a browser-only shortcut.

## Consequences

- Version metadata is part of the runtime status surface, so clients can
  display the running package/git version without deriving it themselves.
- `gini update` and the web update button share the same update helper,
  keeping origin validation, fetch/reset behavior, and dependency install
  behavior consistent.
- Web-triggered updates are only enabled when the running source tree is
  the installer-managed runtime. This prevents a repo checkout from
  accidentally mutating a different installed runtime. When the installed
  runtime exists but the gateway runs from elsewhere, the unsupported
  reason names the directory the gateway is actually running from and
  points at the terminal `gini update` (which updates the installed runtime
  and re-homes a launchd instance onto it) rather than steering every such
  user to git pull.
- Browser-triggered updates schedule a post-response restart helper so the
  HTTP response can flush before the current gateway exits.
- The web client treats a browser-triggered update as a modal operation:
  it blurs and locks the whole app until the restarted stack is verifiably
  up, then confirms completion and reloads onto the new assets. The new
  revision alone is not completion — version metadata is read from git per
  request, so the still-running old gateway reports the new sha while the
  restart is about to take both servers down. Completion is instead gated
  on the running stack proving itself: the gateway must answer
  `/api/status` with a new `pid`, and the web server must prove its local
  `/api/runtime/__healthz` is serving the new code. Under production
  serving that proof is `buildSha` — the short HEAD sha of the bundle the
  server is serving (from `GINI_DIST_DIR=.next-prod-<sha12>`), so the old
  server reports the old build and only the restarted server reports the
  target; the gate completes the web leg when the target revision starts
  with the reported `buildSha`. This is a direct, un-raceable identity. When
  `buildSha` is absent (dev serving, an older server, a build that fell back
  to dev), the web leg instead requires a new `ppid` — the supervising
  `next` CLI process, i.e. the server-tree identity, captured as a baseline
  when the update starts. (The worker `pid` in that response is diagnostic
  only: the `next` CLI respawns its worker in-tree when an update touches
  `next.config.*`, so it proves nothing about a restart.) A leg whose
  baseline could not be captured falls back to a restart-freshness
  heuristic. Before reloading, the client re-probes `__healthz` once and
  drops back to waiting if the web server is not actually serving, so the
  reload can never land on a dead server. The whole gate is bounded by one shared stall deadline that
  phase transitions cannot extend. The deadline firing means the detectors
  never latched, not that the update failed, so before releasing the gate
  does one final definitive read — `/api/version` and `__healthz`, awaited,
  short timeout, no retries: if the gateway is up and idle on the target
  revision and the web server is serving the target build, it reloads onto
  the new app with no error, exactly as a normal completion would. Only
  when the stack is genuinely not up on the target is the blur released with
  a notice instead of trapping the user. The deadline is **progress-aware**:
  `GET /api/version` carries `updateInProgress` (the gateway's single-flight
  update guard), the blurred client polls it every ~5s, and each `true`
  answer pushes the deadline out to at least now + 90s — so a genuinely
  long update keeps the blur up for as long as the gateway proves it is
  still working, capped by an absolute 30-minute ceiling anchored at the
  moment the gate first engaged. The gate-start timestamp is persisted
  with the in-flight state, so a restart-triggered reload resumes the
  original ceiling (and base deadline) instead of re-arming them.
  `false`, errors, and silence extend nothing, so a hung or dead gateway
  still releases on the base deadline. Because the restart only fires
  after the response flushes (above), a dropped `POST /api/update`
  connection is read as "restarting, not failed" — the blur is held and
  released only on a structured error the gateway itself produced. An HTTP
  status alone is not sufficient: the BFF answers for an unreachable
  gateway with its own status-bearing `gateway_unreachable` 503 envelope,
  which arrives exactly in the restart window, so the client treats that
  tagged shape like a transport failure and holds the blur. The
  in-flight state is persisted to `sessionStorage` so the restart-triggered
  reload resumes the blur instead of briefly exposing a half-updated app.
  The gate is **cross-tab**: the owner tab broadcasts `{type:"start"}` /
  `{type:"done"}` on `BroadcastChannel("gini-update-gate")`, and every other
  open tab engages the same blur in follower mode — no POST of its own, but
  the same baselines (captured at engage time), completion detection,
  deadline rules, and probe-then-reload, persisted to its own
  `sessionStorage` the same way. `done` releases a follower whose update
  ended without a restart; a follower already waiting on the restart
  finishes through its own detection. Platforms without `BroadcastChannel`
  degrade to the single-tab gate.
  The gate's base stall deadline is 240s — the POST now contains a full
  `next build` of the web app on top of git + the installs — and the
  restart's downtime window itself is short (~1-2s gateway drain +
  respawn): the restarted web service answers from the prebuilt bundle
  instead of JIT-compiling routes under `next dev`.
- The scheduled restart is supervisor-aware. On a launchd-supervised
  instance the runtime self-SIGTERMs (drains, exits 0) and `KeepAlive`
  respawns it with the freshly checked-out code — no detached stop+start
  helper that would reparent and orphan the respawn outside supervision —
  plus detached `gini autostart kick` children re-exec the web service (for
  any new `packages/web/` dependencies) and the watchdog — the watchdog is a
  long-lived probe loop, so neither KeepAlive (it never exits) nor the
  plist-stamp reconcile (the template is unchanged by a code-only update)
  would otherwise replace its process with the new code. Foreground /
  `gini run` instances keep the detached stop+start helper because there
  is no KeepAlive to respawn them. The always-respawn KeepAlive model, the watchdog, and the
  bootout-as-stop contract live in
  [Always-Up Supervision](always-up-supervision.md); this ADR cross-links
  rather than duplicating them.
- Update remains scoped to the installer-managed runtime. Repo worktrees
  should still use normal git workflows.
## Acceptance Checks

- The sidebar shows a package/git version and an Update button.
- Clicking Update calls `POST /api/update`; when commits changed, the
  current runtime is restarted without asking for manual stop/start.
- A web-triggered update blurs and locks the app for the duration; the
  completion confirmation and reload come only after the restarted gateway
  (new `/api/status` pid) and the restarted web server (the target build's
  `__healthz` `buildSha` under production serving, or a new `ppid` when
  `buildSha` is absent) have both answered, and the blur survives the
  restart-triggered reload rather than briefly exposing the app.
- `GET /api/runtime/__healthz` reports `buildSha` equal to the served
  bundle's short sha when `GINI_DIST_DIR=.next-prod-<sha12>`, and omits it
  under dev serving.
- If the stall deadline fires while the restarted stack is actually up on
  the target revision and build, the gate reloads onto the new app instead
  of showing the "taking longer than expected" notice.
- `gini update` no longer prints a manual restart instruction.
- `gini update` on a launchd instance whose gateway plist home is not the
  installed runtime re-homes it onto `~/.gini/runtime` (regenerating the
  plists and restarting the services there) even when the update reports
  `upToDate: true` and the running gateway reports the matching sha; a
  correctly-homed instance keeps the sha-gated restart; an instance without
  a gateway plist is untouched.
- The gateway answers `/api/status` while a `POST /api/update` is running;
  a concurrent `POST /api/update` returns 409; `GET /api/version` reports
  `updateInProgress: true` exactly while an update is in flight; the
  update-in-progress marker exists exactly for the duration of
  `updateRuntime` (removed on success and on failure).
- After a non-upToDate update, `packages/web/` contains a `.next-prod-*` dir keyed to
  the new HEAD's short sha AND the previous HEAD's bundle (kept so a
  still-running server isn't pulled out from under it; strictly-older bundles
  are GC'd, and the previous one is reclaimed by a later update); a failed web
  build surfaces a structured error and schedules no restart.
- Existing guardrails still reject missing runtimes and unexpected git
  origins.
- `bun run typecheck`, `bun test`, and `bun run gini smoke` pass.

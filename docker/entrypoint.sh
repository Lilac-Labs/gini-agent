#!/usr/bin/env bash
# Container entrypoint for the Gini Agent image.
#
# Brings up the virtual X display Chromium renders into, then hands off to the
# gini CLI. Run as PID 1's child under tini (see Dockerfile ENTRYPOINT), so we
# only need to manage Xvfb's lifecycle relative to the main process — tini reaps
# the rest.
#
# All container-mode behavior (0.0.0.0 bind, headed browser, --no-sandbox) is
# driven by env vars set in the Dockerfile and resolved in
# packages/runtime/src/lib/container-env.ts; this script's only job is the
# display + exec.
set -euo pipefail

DISPLAY="${DISPLAY:-:99}"
export DISPLAY
# Strip the leading ':' to get the display number for the lock-file path.
DISPLAY_NUM="${DISPLAY#:}"
SCREEN_GEOMETRY="${GINI_XVFB_GEOMETRY:-1280x1024x24}"

log() { printf '[entrypoint] %s\n' "$*"; }

# Start Xvfb only when the agent's browser will actually be headed. If the
# operator overrode GINI_BROWSER_HEADLESS back to a headless value there's no
# display to provide, so we skip Xvfb entirely (and never block boot on it).
browser_is_headed() {
  case "${GINI_BROWSER_HEADLESS:-true}" in
    0 | false | FALSE | no | NO | off | OFF) return 0 ;;
    *) return 1 ;;
  esac
}

xvfb_pid=""
if browser_is_headed; then
  # A stale lock from a previous container life (only possible if /tmp is
  # persisted) would make Xvfb refuse the display; clear it best-effort.
  rm -f "/tmp/.X${DISPLAY_NUM}-lock" 2>/dev/null || true

  log "starting Xvfb on ${DISPLAY} (${SCREEN_GEOMETRY})"
  Xvfb "${DISPLAY}" -screen 0 "${SCREEN_GEOMETRY}" -nolisten tcp -ac &
  xvfb_pid=$!

  # Wait for the display socket to exist before launching anything that needs
  # it. Poll rather than sleep a fixed interval (CLAUDE.md fast-test rule, and
  # it makes boot deterministic). The loop runs 100 iterations at 0.1s each, so
  # it gives up after 10 seconds and continues — a missing display then
  # surfaces as a clear Chrome launch error later rather than a silent hang.
  for _ in $(seq 1 100); do
    if [ -S "/tmp/.X11-unix/X${DISPLAY_NUM}" ]; then
      log "Xvfb ready (pid ${xvfb_pid})"
      break
    fi
    if ! kill -0 "${xvfb_pid}" 2>/dev/null; then
      log "WARN: Xvfb exited during startup; continuing without a display"
      xvfb_pid=""
      break
    fi
    sleep 0.1
  done

  # Tear Xvfb down when the main process exits so a restart gets a clean display.
  if [ -n "${xvfb_pid}" ]; then
    trap 'kill "${xvfb_pid}" 2>/dev/null || true' EXIT
  fi
else
  log "GINI_BROWSER_HEADLESS is headless; skipping Xvfb"
fi

# Hand off to the gini CLI. `exec` replaces this shell so signals (SIGTERM from
# `docker stop`) reach the runtime directly for its graceful drain. The runtime
# resolves its instance from GINI_INSTANCE (default) and binds GINI_BIND_HOST.
log "exec: gini $*"
exec bun run /app/packages/runtime/src/cli.ts "$@"

# Docker Deployment (with Xvfb)

Run a Gini instance headless on a server in a container. The image bundles the
runtime gateway, the Next.js control plane, and a real Chromium driven under a
virtual X display (Xvfb), so the agent's browser tools work with no monitor or
GPU. See [ADR: Docker + Xvfb Deployment](adr/docker-xvfb-deployment.md) for the
design and rationale.

## Quick start

```sh
docker compose up --build
# then open the control plane:
open http://localhost:7777
```

The runtime gateway listens on `7778` and the web control plane on `7777` (the
`default` instance's memorable ports). State persists in a named volume, so
chats, sign-ins, memory, and downloaded models survive `docker compose down`
and restarts.

Without Compose:

```sh
docker build -t gini-agent:xvfb .
docker run -d --name gini \
  --init --shm-size=1g \
  -p 7777:7777 -p 7778:7778 \
  -v gini-state:/home/bun/.gini \
  gini-agent:xvfb
open http://localhost:7777
```

`--init` reaps Chromium's child processes; `--shm-size=1g` gives Chrome enough
shared memory (the image also passes `--disable-dev-shm-usage` as a fallback).

## Configure a provider

The image boots with the deterministic `echo` provider so it comes up without
credentials. Point it at a real model one of two ways:

- **At boot, via env.** Set `GINI_PROVIDER` and the matching credential before
  `docker run` / in the Compose `environment:` block. For example, for the
  first-party Claude API:

  ```sh
  docker run -d --name gini --init --shm-size=1g \
    -p 7777:7777 -p 7778:7778 \
    -e GINI_PROVIDER=anthropic -e ANTHROPIC_API_KEY=sk-ant-... \
    -v gini-state:/home/bun/.gini \
    gini-agent:xvfb
  ```

- **After boot, in the browser.** Open `http://localhost:7777/setup` and pick a
  provider from the full catalog (OpenAI, Codex, Anthropic, Bedrock, Azure,
  OpenRouter, DeepSeek, Local). The choice is written to the state volume and
  used on the next request.

`GINI_PROVIDER` only seeds the config the FIRST time an instance boots (when no
`config.json` exists on the volume yet); after that the on-disk config and the
`/setup` page are authoritative.

## How container mode differs from a host install

Three runtime knobs switch on in the image; each defaults to the host behavior
when unset, so nothing here leaks into a normal `gini run` on your laptop. They
are resolved in `packages/runtime/src/lib/container-env.ts`:

| Env var | Image value | Host default | Effect |
|---|---|---|---|
| `GINI_BIND_HOST` | `0.0.0.0` | `127.0.0.1` | Gateway binds all interfaces so published ports reach it |
| `GINI_BROWSER_HEADLESS` | `false` | `true` | Chrome runs headed against the Xvfb display |
| `GINI_CHROME_NO_SANDBOX` | `1` | unset | Adds `--no-sandbox` + `--disable-dev-shm-usage` to the launch |
| `DISPLAY` | `:99` | — | The virtual display the entrypoint starts Xvfb on |

Binding `0.0.0.0` does not grant unauthenticated access. The gateway decides
"is this the local operator?" by the request's real socket peer address, not by
the `Host` header — so a remote client that forges `Host: localhost` over the
published port does **not** get operator access; it is refused (pages 404,
`/api/*` 401) unless edge-trusted. A genuine loopback request (from the host
via the published port on `localhost`, or in-container) is still trusted. If
you put the container behind a reverse proxy on a real hostname, add that
origin to `GINI_TRUSTED_ORIGINS` — and note that a trusted front is
owner-equivalent, with no per-device gate, so restrict who can reach it (see
[ADR: Owner-Token-Only Authentication](adr/owner-token-auth.md)). See
[ADR: Docker + Xvfb Deployment](adr/docker-xvfb-deployment.md) for the
trust-boundary details.

## Persisted state

Everything for the instance lives under the mounted volume at
`/home/bun/.gini`:

- `instances/default/` — config, `state.json`, `memory.db`, the Chrome profile
  (cookies/sign-ins), workspace, logs.
- `models/` — the shared embedding/reranker/speech-to-text model cache,
  downloaded once on first use.

Back up or migrate an instance by backing up that volume.

## Logs

```sh
docker logs -f gini                       # entrypoint + runtime stdout
docker exec gini sh -c 'tail -n 200 ~/.gini/instances/default/logs/runtime-stdout.log'
docker exec gini sh -c 'tail -n 200 ~/.gini/instances/default/logs/web.log'
```

## Browser behavior in the container

The agent's browser launches as a real headed Chromium against `DISPLAY=:99`.
This is intentional — a headed browser under Xvfb presents fewer automation
signals than headless Chrome (see [Browser Stealth Identity](adr/browser-stealth-identity.md)).
The in-chat "connect to the agent's browser" screencast still works: it streams
that headed Chrome over its CDP debug port exactly as on a host install.

To run the browser headless in the container instead (smaller, no Xvfb), set
`GINI_BROWSER_HEADLESS=true`; the entrypoint then skips starting Xvfb.

## Image size and trimming

The image is several gigabytes: it bundles Playwright's Chromium, the CJK font
set, `node_modules`, and the prebuilt web bundle. To slim it:

- Drop `fonts-noto-cjk` (56.7 MB download per the build's apt fetch) if you
  don't need CJK glyph rendering.
- Skip the `playwright install chromium` layer (187.2 MB Chromium download) and
  let the runtime download Chromium on first browser use instead (first use is
  then slower).

## Updating

`gini update` is a host-install concept (it `git fetch`es the installer-managed
runtime) and does not apply in the container. Update by rebuilding the image
from a newer checkout and recreating the container; the state volume carries
your data across the rebuild.

## Architecture-specific note

The image is built and tested on `linux/arm64`. The base `oven/bun:1.3.14-debian`
is Debian 13 (trixie), so the Chromium runtime libraries use the t64-suffixed
package names. Building on `linux/amd64` uses the same package names (the t64
transition is architecture-independent on trixie).

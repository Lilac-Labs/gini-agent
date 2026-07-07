# syntax=docker/dockerfile:1
#
# Gini Agent — container image for headless server deployment.
#
# Runs the full Bun runtime gateway + Next.js control plane in one container,
# with a real (HEADED) Chromium driven by playwright-core under a virtual X
# display (Xvfb). Headed-under-Xvfb is deliberate: a real Chrome presents far
# fewer automation signals than --headless=new, complementing the stealth
# identity (see ADR browser-stealth-identity.md and docker-xvfb-deployment.md).
#
# Layout note: the repo is a Bun workspaces monorepo — the runtime lives in
# packages/runtime (@gini/runtime) and the web control plane in packages/web
# (@gini/web), installed together from the single root bun.lock. The container
# builds straight from the repo root.
#
# Base: oven/bun:1.3.14-debian is Debian 13 "trixie" (verified), so the
# Chromium runtime libs use the t64-suffixed package names from the trixie
# 64-bit-time ABI transition — the pre-trixie names (libasound2, libcups2, …)
# do NOT resolve here.
#
# Pin matches package.json's bun and the bun.lock toolchain.
FROM oven/bun:1.3.14-debian

# --- OS packages -----------------------------------------------------------
# Chromium runtime libs (trixie / t64), Xvfb for the virtual display, a base
# font set so pages render glyphs not tofu boxes, libgomp1 for
# onnxruntime-node's OpenMP runtime (the slim base omits it), tini as a proper
# PID 1 to reap Chromium's child processes, and ca-certificates for TLS.
RUN apt-get update && apt-get install -y --no-install-recommends \
      # Chromium shared-library dependencies (Debian 13 / trixie, t64 names) \
      libasound2t64 \
      libatk-bridge2.0-0t64 \
      libatk1.0-0t64 \
      libatspi2.0-0t64 \
      libcairo2 \
      libcups2t64 \
      libdbus-1-3 \
      libdrm2 \
      libgbm1 \
      libglib2.0-0t64 \
      libnspr4 \
      libnss3 \
      libpango-1.0-0 \
      libx11-6 \
      libxcb1 \
      libxcomposite1 \
      libxdamage1 \
      libxext6 \
      libxfixes3 \
      libxkbcommon0 \
      libxrandr2 \
      # Virtual X display for headed Chromium \
      xvfb \
      # Fonts (avoid tofu boxes for Latin, emoji, and CJK) \
      fonts-liberation \
      fonts-noto-color-emoji \
      fonts-noto-cjk \
      fonts-freefont-ttf \
      # onnxruntime-node (embeddings/reranker/STT) OpenMP runtime \
      libgomp1 \
      # PID 1 init that reaps zombie Chromium children \
      tini \
      ca-certificates \
      # terminal_exec / code_exec wrap commands in `zsh -lc`, so the guest needs
      # zsh on PATH (the Google Workspace + other shell-driven skills fail with
      # "Executable not found in $PATH: zsh" without it). \
      zsh \
      # curl to fetch the gws binary below \
      curl \
      # git: the sha-keyed web prod serving resolves `git rev-parse
      # --short=12 HEAD` at BOTH build and runtime (resolveWebProdDistDir in
      # packages/runtime/src/runtime/update.ts). Absent from the slim base, and
      # the build's COPY brings a worktree .git POINTER file, not a usable repo
      # — so we install git and init a fresh in-container repo below. \
      git \
    && rm -rf /var/lib/apt/lists/*

# --- Google Workspace CLI (gws) --------------------------------------------
# The canonical Workspace tool (github.com/googleworkspace/cli) the
# google-workspace + gmail/calendar skills drive. Hosted guests skip the whole
# gcloud/project/Desktop-client onboarding: the edge bakes a gws credentials
# file (GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE) built from the login's Google
# refresh token, so gws is authenticated the moment the guest boots. Pinned to a
# known release + checksum-verified; installed to /usr/local/bin (always on PATH).
ARG GWS_VERSION=v0.22.5
RUN set -eux; \
    arch="$(uname -m)"; \
    case "$arch" in \
      x86_64) triple="x86_64-unknown-linux-gnu" ;; \
      aarch64) triple="aarch64-unknown-linux-gnu" ;; \
      *) echo "unsupported arch $arch" >&2; exit 1 ;; \
    esac; \
    base="https://github.com/googleworkspace/cli/releases/download/${GWS_VERSION}/google-workspace-cli-${triple}.tar.gz"; \
    cd /tmp; \
    curl -fsSL -o gws.tar.gz "$base"; \
    curl -fsSL -o gws.tar.gz.sha256 "${base}.sha256"; \
    printf '%s  gws.tar.gz\n' "$(cut -d' ' -f1 gws.tar.gz.sha256)" | sha256sum -c -; \
    tar -xzf gws.tar.gz; \
    install -m 0755 gws /usr/local/bin/gws; \
    rm -rf /tmp/gws.tar.gz /tmp/gws.tar.gz.sha256 /tmp/gws /tmp/README.md /tmp/LICENSE /tmp/CHANGELOG.md; \
    gws --version

# Where Playwright caches its bundled Chromium. Pinned to a stable,
# world-readable path (outside any user $HOME) so both the build-time
# `playwright install` and the runtime launch resolve the same browser
# regardless of which UID runs. chrome-discovery.ts reads
# chromium.executablePath(), which honors this env var.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright

WORKDIR /app

# --- Workspace dependencies ------------------------------------------------
# The repo is a Bun workspaces monorepo with a SINGLE root bun.lock that pins
# every package (packages/runtime, packages/web, packages/mobile). Copy the
# root manifests + each workspace's package.json + the bits `bun install` needs
# (the playwright patch and the vendored xlsx tarball) so this layer caches
# across source-only edits. trustedDependencies (onnxruntime-node, protobufjs)
# run their postinstall here; patchedDependencies applies the playwright-core
# patch (the Bun-ws shim the CDP transport depends on).
COPY package.json bun.lock ./
COPY patches ./patches
COPY vendor ./vendor
COPY packages/runtime/package.json ./packages/runtime/package.json
COPY packages/web/package.json ./packages/web/package.json
COPY packages/mobile/package.json ./packages/mobile/package.json
# The `gini-relay` dependency is pinned as git+ssh://git@github.com/... but the
# repo is public, and the build has no SSH key. Rewrite ssh→https for github so
# `bun install` clones it anonymously over HTTPS. Scoped to github.com only.
# The BuildKit cache mount persists bun's global download cache across builds, so
# a dependency bump (which invalidates this layer) re-resolves from cache instead
# of re-downloading the whole dependency tree (~1.9 GB). Requires BuildKit (the
# docker-buildx plugin). sharing=locked serializes access to the cache mount,
# so concurrent builds on the same host can't corrupt bun's shared cache.
RUN --mount=type=cache,target=/root/.bun/install/cache,sharing=locked \
    git config --global url."https://github.com/".insteadOf "git@github.com:" \
    && git config --global url."https://github.com/".insteadOf "ssh://git@github.com/" \
    && bun install --frozen-lockfile

# Download Playwright's bundled Chromium into PLAYWRIGHT_BROWSERS_PATH. This is
# the same binary chrome-launch.ts falls back to; baking it in means first
# browser use doesn't pay the on-demand download. Run via the playwright-core
# CLI it ships. In the monorepo, bun keeps playwright-core under
# packages/runtime/node_modules (it's only a runtime dep); fall back to the root
# in case a future hoist moves it.
RUN if [ -f packages/runtime/node_modules/playwright-core/cli.js ]; then \
      bun packages/runtime/node_modules/playwright-core/cli.js install chromium; \
    else \
      bun node_modules/playwright-core/cli.js install chromium; \
    fi

# --- Firecracker guest-init runtime deps + per-tenant sudo -----------------
# When this image is exported to the microVM golden rootfs, /sbin/gini-init runs
# as PID 1 and uses: ip (iproute2) to bring up eth0 from the kernel cmdline,
# hostname, setpriv (util-linux), and ps (procps). The slim bun base omits these,
# so without them the guest boots with no network ("ip: command not found").
#
# GUEST_SUDO gates passwordless sudo for the runtime `bun` user. It is enabled by
# EXACTLY the value `1` (both branches test `= 1`, so a stray GUEST_SUDO=0/false
# fails closed instead of counterintuitively granting root), and should be set
# ONLY when building a dedicated single-VM image (--build-arg GUEST_SUDO=1).
# Such a guest is a dedicated single-tenant Firecracker
# microVM, so the person using it expects root to `apt install` packages, and
# root stays confined to that VM — the KVM boundary keeps it off the host and away
# from sibling tenants (0600 disks, separate kernels). NOPASSWD because
# terminal_exec runs as `bun` with no TTY to type a password into (and the base
# `bun` account has no password anyway). Note the actor who gains root is not just
# the human tenant but the agent's own model-generated terminal_exec/code_exec —
# it can `sudo` autonomously; accepted because that root can only touch the
# tenant's own VM. The standalone `docker run` deployment (built WITHOUT this arg)
# deliberately stays non-root: it shares the host kernel, so keeping the agent off
# root is real defense-in-depth against a container escape — the microVM is what
# makes root safe, and the container isn't one. Kept ABOVE the source COPY so a
# source-only edit reuses this cached layer instead of re-running apt (a full
# apt-get update + install, ~20s + a package-list fetch) on every build; it still
# sits after the heavy install layers, so their cache survives.
# APT::Sandbox::User=root: /tmp isn't writable by the unprivileged _apt sandbox
# user by this layer (an earlier layer changed its perms), which breaks apt's
# signature verification; run apt as root to sidestep it. The chmod restores /tmp
# to 1777 for the runtime (Xvfb lock, Chrome).
ARG GUEST_SUDO=
RUN chmod 1777 /tmp \
    && if [ "${GUEST_SUDO}" = 1 ]; then SUDO_PKG=sudo; else SUDO_PKG=; fi \
    && apt-get -o APT::Sandbox::User=root update \
    && apt-get -o APT::Sandbox::User=root install -y --no-install-recommends \
      iproute2 hostname util-linux procps ${SUDO_PKG} \
    && rm -rf /var/lib/apt/lists/* \
    && if [ "${GUEST_SUDO}" = 1 ]; then \
         printf 'bun ALL=(ALL) NOPASSWD:ALL\n' > /etc/sudoers.d/bun \
         && chmod 0440 /etc/sudoers.d/bun \
         && visudo -cf /etc/sudoers.d/bun; \
       fi

# --- Developer tooling -----------------------------------------------------
# A guest (and the standalone container) is a working machine the user and the
# agent run real tasks on, so ship the everyday dev/ops toolkit rather than make
# each guest apt-install it on first use: jq (JSON), python3 + pip + venv (the
# other first-class scripting runtime beside bun), an editor (vim/nano), a pager
# (less — git/man are unusable without it), archives (unzip/zip), a second
# fetcher (wget; curl is already in), fast search (ripgrep), and the C/C++
# toolchain (build-essential) so native pip/npm extensions and `make`-based
# installs work. Plus file, tree, rsync, dnsutils (dig), and openssh-client for
# git-over-ssh / scp. Unconditional (NOT gated on GUEST_SUDO) — these are
# ordinary tools, not a privilege, so the standalone image gets them too. Kept
# ABOVE the source COPY so it caches across source-only edits; APT::Sandbox::
# User=root for the same /tmp-perms reason as the layer above.
RUN apt-get -o APT::Sandbox::User=root update \
    && apt-get -o APT::Sandbox::User=root install -y --no-install-recommends \
      jq \
      python3 python3-pip python3-venv \
      build-essential \
      vim nano less \
      unzip zip wget \
      ripgrep tree file rsync openssh-client dnsutils \
    && rm -rf /var/lib/apt/lists/*

# --- Application source ----------------------------------------------------
# .dockerignore ships the repo's .gitignore but excludes the worktree's .git
# pointer (it references a host path that doesn't exist in the image). Init a
# fresh repo and commit the source so `git rev-parse --short=12 HEAD` returns a
# stable sha that BOTH the build below and the runtime's resolveWebProdDistDir()
# agree on — that's what makes the prod bundle actually get served instead of
# silently falling back to dev. The shipped .gitignore keeps `git add -A` from
# hashing node_modules/.next (~1.9 GB), which otherwise made this the second-
# heaviest step (~72s, ~888 MB layer). Source-tree ownership is set in the
# Runtime user step below (bun must own the worktree so the runtime's
# `git rev-parse` and the next-dev fallback work) — but WITHOUT chowning the
# heavy node_modules tree, which is what made the old recursive chown so slow.
COPY . .
RUN git init -q \
    && git config user.email "build@gini.local" \
    && git config user.name "gini-docker-build" \
    && git add -A \
    && git commit -q -m "container build snapshot"

# Build the sha-keyed production web bundle (packages/web/.next-prod-<sha12>)
# so webLaunchPlan() serves it via `next start` instead of falling back to dev.
# Mirrors buildWebProdBundle in packages/runtime/src/runtime/update.ts and
# startWeb in packages/runtime/src/cli/process.ts (webRoot = packages/web,
# `bun run build`). The build is best-effort: on failure the image still runs
# and the runtime falls back to `next dev`, which JIT-compiles routes (slower
# first paint, same behavior). The BUILD_ID check makes success/fallback
# explicit instead of trusting an exit code a usage error wouldn't set.
RUN SHA12="$(git rev-parse --short=12 HEAD)"; DIST=".next-prod-${SHA12}"; \
    ( cd packages/web && GINI_DIST_DIR="${DIST}" bun run build ) || true; \
    if [ -f "packages/web/${DIST}/BUILD_ID" ]; then \
      echo "Built web prod bundle: packages/web/${DIST}"; \
    else \
      echo "WARN: web prod build did not produce packages/web/${DIST}/BUILD_ID; runtime falls back to next dev"; \
    fi

# --- Runtime user ----------------------------------------------------------
# Run as the non-root `bun` user the base image already provides. Chrome still
# launches with --no-sandbox (set via GINI_CHROME_NO_SANDBOX in the entrypoint):
# the agent drives the operator's own trusted automation, and the kernel sandbox
# can't initialize in a default container anyway.
#
# Give bun the WHOLE /app worktree (source, the in-image .git, and the web prod
# bundle) so the runtime's `git rev-parse` resolves the sha — a root-owned
# worktree trips git's dubious-ownership guard, which silently drops the prod
# bundle to `next dev` — and so the next-dev fallback can write into packages/web.
# But PRUNE node_modules from the chown: node_modules (1.9 GB) and the baked
# Chromium in /opt/ms-playwright are only read/executed by bun (default
# 0644/0755), so chowning them just duplicates ~3.5 GB into a fresh layer and adds
# MINUTES to the build for no runtime benefit. `safe.directory` belts the git
# ownership check regardless.
RUN mkdir -p /home/bun/.gini \
    && chown bun:bun /home/bun/.gini \
    && git config --system --add safe.directory /app \
    && find /app \( -path /app/node_modules -o -path '/app/packages/*/node_modules' \) \
         -prune -o -exec chown bun:bun {} +
USER bun

# Persisted state lives here (config, state.json, memory.db, the Chrome
# profile with its cookies, workspace, logs). Declare it a volume so chats,
# sign-ins, and memory survive `docker rm`. The shared model cache also lands
# under here (~/.gini/models) so embeddings/reranker/STT models download once.
ENV HOME=/home/bun
VOLUME ["/home/bun/.gini"]

# --- Container-mode runtime env -------------------------------------------
# These are the seams that switch the runtime into container mode; each
# defaults to the historical host behavior when unset (see
# packages/runtime/src/lib/container-env.ts).
#   GINI_BIND_HOST=0.0.0.0        gateway binds all interfaces so `docker -p` reaches it
#   GINI_BROWSER_HEADLESS=false   Chrome runs HEADED against the Xvfb display
#   GINI_CHROME_NO_SANDBOX=1      append --no-sandbox + --disable-dev-shm-usage
#   DISPLAY=:99                   the virtual display the entrypoint starts Xvfb on
#   GINI_INSTANCE=default         fixed instance → memorable ports 7777/7778
ENV GINI_BIND_HOST=0.0.0.0 \
    GINI_BROWSER_HEADLESS=false \
    GINI_CHROME_NO_SANDBOX=1 \
    GINI_PROVIDER=echo \
    GINI_INSTANCE=default \
    DISPLAY=:99

# Gateway (7778) and web (7777) for the `default` instance. Publish with
# `docker run -p 7777:7777 -p 7778:7778` (or use docker-compose.yml).
EXPOSE 7777 7778

# tini as PID 1 reaps Chromium's orphaned children; the entrypoint starts Xvfb
# then execs `gini run`.
ENTRYPOINT ["tini", "--", "/app/docker/entrypoint.sh"]
CMD ["run"]

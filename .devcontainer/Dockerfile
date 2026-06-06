# Lualambda dev container.
#
# Purpose: isolate npm/Bun supply-chain risk (malicious postinstall, etc.) from
# the host. All dependency installs and dev work happen in here, not on the host.
#
# Base: official Bun image (Debian variant so we have apt for QEMU + tooling).
FROM oven/bun:debian

# --- System tooling -----------------------------------------------------------
# qemu-system-x86: run MicroNT microVMs in TCG mode (no KVM needed in dev).
# qemu-utils:      qemu-img for building/inspecting disk images.
# zip/unzip:       function bundle packaging.
# ca-certificates: TLS to the facilitator + Algorand testnet.
# git, less, jq, procps: day-to-day dev ergonomics.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      qemu-system-x86 \
      qemu-utils \
      zip \
      unzip \
      ca-certificates \
      git \
      less \
      jq \
      procps \
 && rm -rf /var/lib/apt/lists/*

# The oven/bun image already provides a non-root `bun` user (uid 1000). We run as
# that user so anything a dependency does at install/runtime is unprivileged and
# contained. Host secrets (~/.ssh, cloud creds, Algorand MAINNET keys) are
# deliberately NOT mounted — use a throwaway TESTNET key generated inside here.
USER bun

WORKDIR /workspace

# Bun does not run dependency lifecycle scripts by default (only for an explicit
# trustedDependencies allow-list in package.json), which already trims the npm
# postinstall attack surface. The container is the actual trust boundary.

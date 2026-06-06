#!/usr/bin/env bash
# Runs once when the dev container is created.
set -euo pipefail

echo "==> Tool versions"
bun --version
qemu-system-x86_64 --version | head -n1

# Install JS dependencies only if the project has been scaffolded.
# (Frozen lockfile so a compromised registry can't silently swap versions;
#  drop --frozen-lockfile the first time you add a dependency.)
if [ -f package.json ]; then
  echo "==> bun install"
  bun install --frozen-lockfile || bun install
else
  echo "==> No package.json yet — skipping bun install."
  echo "    Scaffold the app, then re-open or run: bun install"
fi

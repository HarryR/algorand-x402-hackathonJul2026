#!/usr/bin/env bash
# Build the lualambda binaries (CLI + orchestrator) into build/.
#
# Defaults to Linux x86_64. Pass a target to build for another platform:
#
#   ./build.sh                 # linux-x64 (default)
#   ./build.sh linux-arm64
#   ./build.sh darwin-arm64
#   ./build.sh windows-x64
#
# Targets map to Bun --target values (the "bun-" prefix is added for you). See
# `bun build --help` for the full list. Both binaries are built for the same
# target; on Windows the orchestrator/CLI get a .exe suffix automatically.
#
# Note: the orchestrator is designed to run on our Linux server (it spawns QEMU),
# so Linux is the target that matters in practice — the others are here so you
# can expand to mac/windows builds later without touching this script.
set -euo pipefail

cd "$(dirname "$0")"

TARGET="${1:-linux-x64}"
OUT="build"
mkdir -p "$OUT"

# Common flags: --minify (smaller) --bytecode (faster startup).
FLAGS=(--compile --minify --bytecode "--target=bun-${TARGET}")

ext=""
[[ "$TARGET" == windows-* ]] && ext=".exe"

build() {
  local entry="$1" name="$2"
  local outfile="${OUT}/${name}${ext}"
  echo "==> ${name} (${TARGET}) -> ${outfile}"
  bun build "${FLAGS[@]}" "$entry" --outfile "$outfile"
}

build ./src/cli/main.ts lualambda
build ./src/orchestrator/server.ts lualambda-orchestrator

echo "==> done; binaries in ${OUT}/"
ls -lh "${OUT}/"

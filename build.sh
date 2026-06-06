#!/usr/bin/env bash
# Build the single all-in-one lualambda binary into build/<target>/.
#
# One executable is client, wallet, AND orchestrator — the role is chosen at
# runtime by the first argument (`lualambda serve` boots the HTTP orchestrator;
# everything else is a CLI command). Shipping one file means the Bun runtime +
# embedded MicroNT artifacts (vmlinux + initrd) are bundled once, not twice.
#
# Defaults to Linux x86_64. Pass a target to build for another platform:
#
#   ./build.sh                 # linux-x64 (default)
#   ./build.sh linux-arm64
#   ./build.sh darwin-arm64
#   ./build.sh windows-x64
#
# Targets are Bun --target suffixes (the "bun-" prefix is added for you); see
# `bun build --help` for the full list. Output goes to a per-target directory so
# multiple targets coexist (e.g. for release capture / CI artifacts):
#
#   build/linux-x64/lualambda
#   build/windows-x64/lualambda.exe
#
# Note: the orchestrator role spawns QEMU, so Linux is the target that matters in
# practice — the others are here so you can expand to mac/windows builds later
# without touching this script (the client/wallet roles work everywhere).
set -euo pipefail

cd "$(dirname "$0")"

TARGET="${1:-linux-x64}"
OUT="build/${TARGET}"
mkdir -p "$OUT"

# Common flags: --minify (smaller) --bytecode (faster startup).
FLAGS=(--compile --minify --bytecode "--target=bun-${TARGET}")

ext=""
[[ "$TARGET" == windows-* ]] && ext=".exe"

outfile="${OUT}/lualambda${ext}"
echo "==> lualambda (${TARGET}) -> ${outfile}"
bun build "${FLAGS[@]}" ./src/cli/main.ts --outfile "$outfile"

echo "==> done; binary in ${OUT}/"
ls -lh "${OUT}/"

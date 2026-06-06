#!/usr/bin/env bash
# Run the live testnet end-to-end integration check.
#
# This drives the WHOLE paid loop for real: it spawns the orchestrator with
# payments enforced, runs the real CLI against it, hits the live GoPlausible
# facilitator, settles live testnet USDC, boots a real MicroNT VM, and asserts on
# the result + on-chain settlement. It is NOT part of `bun test` / CI — it needs
# QEMU, the network, and a funded testnet wallet, and it spends ~$0.001 USDC for
# one `nano` invoke.
#
# Usage:
#   ./e2e-test.sh                       # payTo defaults to the project receiver
#   ./e2e-test.sh <receiver-address>    # send the payment to this address
#   LUALAMBDA_PAY_TO=<addr> ./e2e-test.sh
#
# Safety: hard-refuses anything but testnet, reads the wallet read-only (never
# writes it), and runs the orchestrator in a throwaway workdir. The payer key is
# ~/.config/lualambda/wallet.json (or LUALAMBDA_MNEMONIC); testnet keys only.
set -euo pipefail

cd "$(dirname "$0")"

# Optional first arg = the receiver (payTo) address; env wins if already set.
if [[ -n "${1:-}" ]]; then
  export LUALAMBDA_PAY_TO="$1"
fi

exec bun run scripts/testnet-e2e.ts

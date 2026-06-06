#!/usr/bin/env bash
# Runs each time you attach to the container. Keep it cheap and informative.
set -euo pipefail

cat <<'BANNER'
┌─────────────────────────────────────────────────────────────┐
│ lualambda dev container                                     │
│                                                             │
│  • QEMU runs here in TCG mode (no KVM in dev).              │
│  • Network is open; the container is the trust boundary.   │
│  • Use a THROWAWAY Algorand TESTNET key only — never put   │
│    mainnet keys in here. Fund via Lora (ALGO) + Circle      │
│    (USDC testnet) faucets.                                  │
└─────────────────────────────────────────────────────────────┘
BANNER

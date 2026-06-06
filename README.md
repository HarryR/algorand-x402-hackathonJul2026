# lualambda

x402-powered Lua lambda functions, settled on Algorand. Deploy a directory of
Lua, pay per invocation over [x402](https://x402.org), and your code runs inside
a hardware-isolated [MicroNT](https://github.com/HarryR/nt365) QEMU microVM with
LuaJIT.

See [OUTLINE.md](./OUTLINE.md) for the full design, rationale, and build plan.

## Status

**Working end-to-end on Algorand testnet.** A paid `invoke` has run for real: the
CLI signs a USDC payment on the 402, the orchestrator verifies+settles via the
GoPlausible facilitator (fee-sponsored), then boots a MicroNT microVM and returns
the result + an on-chain settlement receipt. Milestones 0–2 are done; the
vmlinux + initrd are embedded in the compiled binary (no host artifacts needed).

## Model

There is no "deployed function." An **invocation** is a set of package zips + a
module to `require` + an array of args, identified by an **opaque idempotency id**
(a deterministic hash of the inputs, or a nametag) chosen by the client. The zips
are placed in the guest's `\SystemRoot\pkg\`; MicroNT's Lua loader resolves
`require('blah.dorp')` to `\SystemRoot\pkg\blah.zip\blah\dorp.lua`.

```
GET  /invoke               discovery: profiles, prices, URL scheme
GET  /invoke/:id           status only (state + package/arg hashes + expiry)
POST /invoke/:id/:profile  priced, x402-gated; one paid profile per id
                           multipart: package zips + JSON spec { require, args }
GET  /invoke/:id/output    retained output for the profile's window; 410 when gone
```

The profile (and thus price, retention window, and max output) is chosen **at pay
time** via the URL path. You can't pay twice for the same id (→ 409).

## Dev

Everything runs inside the [devcontainer](.devcontainer/) (npm supply-chain
isolation, QEMU in TCG mode, throwaway testnet key only).

```bash
bun install
bun run typecheck
bun test

bun run dev        # start the orchestrator on :8402
bun run cli -- profiles
bun run cli -- discover
bun run cli -- invoke --pkg ./examples/hello --require hello --arg Algorand --profile small
# --pkg accepts a directory (zipped in-process) or an existing .zip (uploaded verbatim)
bun run cli -- status <id>
bun run cli -- output <id>

# Raw Lua — no packaging needed. With no --pkg, a Lua script is read from stdin
# (or pass a single .lua file); --require defaults to the module/file name.
echo 'return 2 + 2' | bun run cli -- invoke
bun run cli -- invoke < script.lua
bun run cli -- invoke --pkg ./hello.lua --arg world
# A bare script, a value-returner, or a full `return function(args) ... end`
# module all work; whatever you return is the JSON output.
```

## Paid invoke on Algorand testnet

The free path above runs with payments off. To exercise the real x402 loop:

```bash
# 1. Client wallet (the payer). Prints address + a QR for funding from a phone.
bun run cli -- wallet create
bun run cli -- wallet opt-in          # opt the payer into testnet USDC (ASA 10458941)
#    fund it: ALGO https://lora.algokit.io/testnet/fund  ·  USDC https://faucet.circle.com/
bun run cli -- wallet status          # confirm ALGO + USDC balances

# 2. The receiver (payTo) must ALSO be opted into USDC to receive it. Use a wallet
#    you control; opt it in once (e.g. via Pera, or `wallet opt-in` from it).

# 3. Run the orchestrator with payments enforced (payTo = the receiver address):
LUALAMBDA_PAY_TO=<your-receiver-address> bun run dev

# 4. Pay-per-run: 402 -> sign USDC -> settle -> VM -> result + receipt.
bun run cli -- invoke --pkg ./examples/hello --require hello --arg Algorand --profile nano
#   -> { "greeting": "hello Algorand" }
#      settled: <txid>   https://lora.algokit.io/testnet/tx/<txid>
```

### Automated testnet check

[scripts/testnet-e2e.ts](scripts/testnet-e2e.ts) runs the whole loop end-to-end
against the live facilitator and a real VM, then asserts on it — a repeatable
version of the runbook above. It is **not** part of `bun test` / CI (it needs
QEMU, the network, and funds); run it on demand:

```bash
./e2e-test.sh <receiver>                          # ~$0.001 USDC for one nano invoke
# or: LUALAMBDA_PAY_TO=<receiver> bun run testnet:e2e
```

It hard-refuses anything but testnet, reads the wallet **read-only** (never
writes it), and runs the orchestrator in a throwaway workdir. Checks: a local
invoke boots the VM for free first (so a broken VM fails before any spend), then
a paid invoke settles (real txid), re-paying the same id returns `409`, and
`--max-price` below the price aborts before signing. `payTo` defaults to the
project receiver; override with `LUALAMBDA_PAY_TO`.

Notes: the facilitator **fee-sponsors** the payment group, so neither the payer
nor the orchestrator needs ALGO for the transfer (only a little for the one-time
opt-in). Payments are enforced only when `LUALAMBDA_PAY_TO` is set; otherwise the
orchestrator runs free. `--network testnet|mainnet` (default testnet) selects the
USDC ASA + CAIP-2 bundle. Re-invoking the same inputs returns `409` (no double
charge). The payer key lives at `~/.config/lualambda/wallet.json` (or
`LUALAMBDA_MNEMONIC`); testnet throwaway keys only.

## Layout

```
src/
  cli/           lualambda CLI (cross-compiles to a single binary)
  orchestrator/  HTTP API, store, QEMU launcher (vm.ts), instance prep,
                 connect-back record protocol, host-sent stager, ports
  guest/         overlay/ merged into the upstream initrd (port-fix agent);
                 the connect-back agent itself ships baked into initrd.zip
  shared/        wire contracts, profiles, config, zip read/write,
                 fat16 + mbr + drive (pure-TS FAT16 disk builder)
examples/hello/  sample package (zips to hello.zip, required as `hello`)
build.sh         build both binaries into build/<target>/ (default linux-x64)
.github/         CI: full build; release tags (v*) publish binaries
```

## Build binaries

`build.sh` compiles both binaries (the `lualambda` CLI and the
`lualambda-orchestrator`) into `build/<target>/` (gitignored). Defaults to Linux
x86_64; pass a Bun target to build for another platform.

```bash
./build.sh                 # build/linux-x64/
./build.sh linux-arm64     # build/linux-arm64/
./build.sh darwin-arm64    # build/darwin-arm64/   (expand to mac/windows later)
./build.sh windows-x64     # build/windows-x64/    (.exe suffix added)
# or: bun run build
```

CI ([.github/workflows/build.yml](.github/workflows/build.yml)) runs typecheck +
lint + tests + build on every push/PR. Pushing a `v*` tag additionally publishes
a GitHub Release with the binaries attached (one tarball per target).

# lualambda

x402-powered Lua lambda functions, settled on Algorand. Deploy a directory of
Lua, pay per invocation over [x402](https://x402.org), and your code runs inside
a hardware-isolated [MicroNT](https://github.com/HarryR/nt365) QEMU microVM with
LuaJIT.

See [OUTLINE.md](./OUTLINE.md) for the full design, rationale, and build plan.

## Status

Scaffold + Milestone 1 skeleton. The VM launcher ([src/orchestrator/vm.ts](src/orchestrator/vm.ts))
is a stub pending the Milestone 0 QEMU spike; x402 payment is a Milestone 2
swap-in at the `payingFetch` seam in [src/cli/main.ts](src/cli/main.ts).

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
```

## Layout

```
src/
  cli/           lualambda CLI (cross-compiles to a single binary)
  orchestrator/  HTTP API, package + invocation store, QEMU VM launcher
  guest/         MicroNT init.lua shim (the in-VM runtime)
  shared/        wire contracts, resource profiles, config
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

# lualambda

Pay-per-run Lua. Every call boots a hardware-isolated microVM running an
NT-compatible kernel, runs your code, settles a fraction of a cent of USDC on
Algorand, hands back the result, and then deletes the VM. All of that, to
compute `2 + 2`.

It is "serverless" in the sense that there is, in fact, a server — it's just a
[MicroNT](https://github.com/HarryR/nt365) + LuaJIT QEMU microVM that exists for
a few seconds and is then never spoken of again.

## Quick start

Grab the `lualambda` binary from the [Releases](../../releases) page and make it
executable. It's one self-contained file — the Bun runtime and the MicroNT kernel
and initrd are baked in, so there's nothing else to download. The VM features
need `qemu-system-x86_64` on your PATH; the wallet and client bits don't.

```bash
tar xzf lualambda-*-linux-x64.tar.gz
chmod +x lualambda
./lualambda --help
```

Run some Lua in a real microVM — no server, no wallet, no payment:

```bash
echo 'return 2 + 2' | ./lualambda invoke --local-test
# -> 4
```

That booted a microVM, ran your Lua inside it, framed the result back over a
socket, and tore the VM down. By default you get just the result (so `| jq` is
happy); add `-v` for the id and timing.

A bare expression, a returned value, or a full `function(args)` all work —
whatever you return is the JSON output:

```bash
echo 'return { hello = "world" }' | ./lualambda invoke --local-test
echo 'return function(a) return "hi "..(a[1] or "there") end' \
  | ./lualambda invoke --arg Algorand --local-test
```

## Drop into a shell

Add `--attach` and the VM stays alive after running — you land in a Lua REPL on
its serial console and can poke around like it's a tiny computer, because it is
one:

```bash
lualambda invoke --local-test --attach            # a bare Lua REPL in a local microVM
lualambda invoke --local-test --attach --pkg ./mylib   # ...with your package there to require()
```

```
LuaJIT 2.1 -- Copyright (C) 2005-2026 Mike Pall. https://luajit.org/
> require('nt.dll.ps').getpid()
1
> 1 + 1
2
```

Drop `--local-test` to run it as a paid session on an orchestrator instead. Those
are multi-attach: `lualambda attach <id>` joins a running one, so several people
can share the same terminal. `Ctrl-]` detaches. The session ends when its
wall-clock or output cap is hit (you're renting CPU, after all).

## One binary, three roles

The same executable is the client, the wallet, and the orchestrator. The first
argument picks the role:

```bash
lualambda invoke …      # run code (locally with --local-test, or against a server)
lualambda serve         # be the orchestrator — the HTTP API (needs QEMU)
lualambda wallet …      # an Algorand wallet (create / fund / opt-in / status)
```

## Pay-per-run on Algorand testnet

The real loop: the client signs a USDC payment in response to an HTTP 402, the
orchestrator verifies and settles it through the GoPlausible facilitator, boots
the VM, and returns your result plus an on-chain receipt.

```bash
# 1. A throwaway payer wallet (prints an address + a QR you can fund from a phone).
lualambda wallet create
lualambda wallet opt-in        # opt the payer into testnet USDC (ASA 10458941)
#   fund it:  ALGO  https://lora.algokit.io/testnet/fund
#             USDC  https://faucet.circle.com/
lualambda wallet status        # check balances

# 2. Start an orchestrator that enforces payment. The receiver must also be
#    opted into USDC to receive it.
lualambda serve --pay-to <your-receiver-address>

# 3. In another terminal: 402 -> sign USDC -> settle -> VM -> result + receipt.
echo 'return function(a) return { greeting = "hello "..(a[1] or "world") } end' \
  | lualambda invoke --arg Algorand --profile nano -v
#   -> { "greeting": "hello Algorand" }
#      settled: <txid>   https://lora.algokit.io/testnet/tx/<txid>
```

The facilitator fee-sponsors the payment group, so neither side needs ALGO for
the transfer (only a little for the one-time opt-in). Drop `--pay-to` and the
orchestrator runs free. The payer key lives at `~/.config/lualambda/wallet.json`
(or `LUALAMBDA_MNEMONIC`) — testnet throwaway keys only, please.

## How it works

There's no "deployed function." An invocation is a set of package zips + a module
to `require` + an array of args, keyed by an opaque id (a hash of the inputs, or
any nametag you pick). The zips land in the guest's `\SystemRoot\pkg\`, and
MicroNT's Lua loader resolves `require('blah.dorp')` to
`\SystemRoot\pkg\blah.zip\blah\dorp.lua`.

```
GET  /invoke               discovery: profiles, prices, URL scheme
GET  /invoke/:id           status (state + hashes + expiry)
POST /invoke/:id/:profile  priced, x402-gated; one paid profile per id
                           multipart: package zips + JSON spec { require, args }
GET  /invoke/:id/output    retained output for the profile's window; 410 once gone
```

You choose the profile — and so the price, CPU/memory, retention window, and
output cap — at pay time, via the URL. You can't pay twice for the same id (you
get a 409).

Guests share QEMU's user-mode network, so each VM has to present a per-instance
connect-back token before the orchestrator hands it any code or accepts a result.
One guest can't read or poison another's invocation.

## Run from source

Everything runs inside the [devcontainer](.devcontainer/) (supply-chain
isolation, QEMU in TCG mode, a throwaway testnet key).

```bash
bun install
bun test
bun run dev                                          # orchestrator on :8402
bun run cli -- invoke --pkg ./examples/hello --require hello --arg Algorand --local-test
```

`--pkg` takes a directory (zipped in-process) or an existing `.zip` (uploaded
verbatim). With no `--pkg`, Lua is read from stdin or a single `.lua` file.

## Build

`build.sh` compiles the single binary into `build/<target>/` — Linux x64 by
default; pass a Bun target (e.g. `darwin-arm64`, `windows-x64`) for others:

```bash
./build.sh
```

CI builds and tests on every push. Pushing a `v*` tag publishes a GitHub Release
with the binary attached and a signed build-provenance attestation.

## More

Design notes live in [OUTLINE.md](./OUTLINE.md). There are also
[hackathon slides](https://docs.google.com/presentation/d/1P8DxG34sZoJQHEu3WijpxBsueuJsHZWx77lmKm18Cv4/edit?usp=sharing).

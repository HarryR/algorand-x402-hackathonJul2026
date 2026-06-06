# Lualambda — x402-powered Lua Lambda Functions, Settled on Algorand

> Hackathon project outline — July 2026

## One-liner

A serverless "lambda" platform where you `lualambda deploy ./mydir`, pay
per-invocation over [x402](https://x402.org), and your code runs inside a
hardware-isolated [MicroNT](https://github.com/HarryR/nt365) QEMU microVM with
LuaJIT. Payments settle on **Algorand** using the official x402-on-Algorand
`exact` scheme.

## The pitch (why this is interesting)

- **Novel use of x402-on-Algorand.** Algorand already has official x402 support
  (the `exact` scheme for AVM, a managed facilitator, and SDKs). So instead of
  burning the hackathon writing a facilitator, we **consume** that infrastructure
  to build something nobody's built: **metered, pay-per-run untrusted compute.**
- **Real isolation, not containers.** Each function runs in a genuine VM
  (MicroNT under QEMU), not a shared interpreter or container. Strong tenant
  isolation is the right substrate for "run a stranger's code, charge per run."
- **Honest metering.** Resource profiles (CPU share, memory, disk, bandwidth)
  map directly to x402 price tiers. You pay for the capacity you ask for, per call.

---

## What already exists (so we don't rebuild it)

From the [Algorand x402 developer docs](https://algorand.co/agentic-commerce/x402/developers)
and the [`exact` scheme spec](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_algo.md):

- **Scheme:** `exact` on AVM. Network id is CAIP-2 style, e.g. testnet
  `algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=`.
- **Asset:** any opted-in ASA; **USDC** is the example (mainnet ASA `31566704`,
  there's a testnet USDC ASA + Circle faucet).
- **Payment payload:** `{ paymentIndex, paymentGroup }` where `paymentGroup` is
  an array of base64+msgpack-encoded Algorand txns forming an atomic group; the
  txn at `paymentIndex` is the `axfer` (asset transfer) to `payTo`. Facilitator
  can fee-sponsor via `extra.feePayer`.
- **Facilitator:** managed at `https://facilitator.goplausible.xyz`
  (`/verify` + `/settle`), OR self-host the Express reference impl from
  [`algorand-devrel/x402-demo`](https://github.com/algorand-devrel/x402-demo).
- **SDKs (TypeScript):** `@x402/core`, `@x402/avm` (signing), `@x402/fetch`
  (`wrapFetchWithPayment` client), server middleware `@x402/hono` / `@x402/express`,
  plus `@algorandfoundation/algokit-utils`.

**Implication for us:** the entire payment layer is a library integration, not
protocol engineering. Our hackathon value is the **compute platform** glued to it.

---

## Language decision — TypeScript on Bun (locked in)

The **x402-on-Algorand SDKs are TypeScript/JS** (`@x402/avm`, `@x402/hono`,
`@x402/fetch`), and Hono middleware does the 402 challenge + verify/settle
handshake for us. So we write **TypeScript and run/bundle with Bun**.

| Option | x402 integration | Binaries | Verdict |
|---|---|---|---|
| **A. TS on Bun (chosen)** | ✅ official SDKs, least glue | `bun build --compile` cross-compiles real single-file binaries for all OSes from one machine | ✅ **chosen** — fastest path to a working paid invoke |
| B. Go everywhere | ❌ reimplement the payload (msgpack txn group, X-PAYMENT) by hand on go-algorand-sdk | ✅ great static binaries | only if we *want* protocol work; costs time |
| C. Hybrid (TS server + Go CLI) | split | mixed | more moving parts than it's worth |

Use the official SDKs and middleware so payments "just work," and spend the
saved time on the VM/metering story — the actually-novel part. Revisit Go only
if a sponsor prize specifically rewards the Go SDK / a from-scratch facilitator.

See **Tooling & Packaging** below for the Bun bundling and devcontainer details.

> The rest of this outline is written language-agnostically; swap "service" for
> your chosen runtime.

---

## Architecture

```
┌──────────┐   1. zip + deploy        ┌─────────────────────────┐
│  CLI     │ ───────────────────────► │  Orchestrator (HTTP)    │
│          │                          │                         │
│          │   2. invoke (no pay)     │  ┌───────────────────┐  │
│          │ ───────────────────────► │  │ x402 middleware   │  │
│          │ ◄─── 402 + requirements  │  │ (@x402/hono)      │  │
│          │                          │  │  402 / verify /   │  │
│          │   3. invoke + X-PAYMENT  │  │  settle           │  │
│          │ ───────────────────────► │  └─────────┬─────────┘  │
│ wrapFetch│                          │            │            │
│WithPayment ◄─ 200 + result + receipt│  ┌─────────▼─────────┐  │
└──────────┘                          │  │ VM pool / launcher│  │
                                      │  │  - qemu spawn     │  │
                                      │  │  - resource caps  │  │
                                      │  │  - bandwidth thr. │  │
                                      │  └─────────┬─────────┘  │
                                      └────────────┼────────────┘
                                                   │
                         ┌─────────────────────────▼────────────┐
                         │  QEMU microVM (MicroNT)               │
                         │   - LuaJIT 2.1 init                   │
                         │   - VirtIO net (slirp), block, console│
                         │   - runs \pkg\<fn> with args, returns │
                         └───────────────────────────────────────┘

   x402 middleware ──► facilitator.goplausible.xyz (/verify /settle) ──► Algorand testnet
```

### Components

| Component | Responsibility |
|---|---|
| **CLI** (`lualambda`) | Zip a dir, deploy, invoke, pay (`wrapFetchWithPayment`). Bundled binary. |
| **Orchestrator** | HTTP API; x402 middleware gates invoke; QEMU lifecycle + resource enforcement. |
| **x402 layer** | `@x402/hono` middleware + managed/self-hosted facilitator. *Integration, not new code.* |
| **Guest runtime** | MicroNT `init` Lua shim: load fn + args, run, return result over console/net. |

---

## Component detail

### 1. CLI — `lualambda`

```
lualambda deploy ./myfn --profile small      # zip dir, upload, get a function id
lualambda invoke  <fn-id> --arg foo --arg bar # pays via x402, prints result
lualambda invoke  <fn-id> --max-price 0.01    # client-side price ceiling
lualambda profiles                            # list resource/price tiers
lualambda wallet  status                      # Algorand account + USDC balance
```

- Builds a deterministic zip of the dir (skip `.git`, etc.).
- On `invoke`: uses `wrapFetchWithPayment` (`@x402/fetch`) so the `402 → sign →
  retry with X-PAYMENT` dance is automatic; signing via `@x402/avm`.
- Holds an Algorand testnet keypair; opted into testnet USDC ASA.
- Prints the result + settlement receipt (txid) + explorer link.

### 2. Orchestrator (HTTP server)

- **Deploy**: accept zip, store, assign function id, validate `main.lua` entrypoint.
- **Invoke**: x402-gated via `paymentMiddleware`. Declares per-profile price; on a
  valid payment the middleware verifies+settles through the facilitator, then the
  handler launches the VM.
- **VM launcher**:
  - Inject the function zip + args into the guest (rebuild `initrd.zip`, or attach
    a per-call data disk).
  - Spawn QEMU with MicroNT via **PVH** (`vmlinux` + `initrd.zip`) — no firmware,
    easiest payload injection. (UEFI `BOOTX64.EFI` is the alternative.)
  - Apply resource caps, wait for result, tear down.
- **Result channel**: VirtIO-console (simplest) or TCP-over-slirp. Start: console.

#### Resource profiles → price tiers

| Profile | Memory | vCPU | Disk | Bandwidth | Price |
|---|---|---|---|---|---|
| `nano`  | 64 MB  | throttled | 16 MB | 1 Mbps  | $0.001 |
| `small` | 128 MB | 1 shared  | 64 MB | 5 Mbps  | $0.005 |
| `med`   | 256 MB | 1 full    | 256 MB| 25 Mbps | $0.02 |

- **Memory** `qemu -m`; **CPU** via cgroup `cpu.max` on the QEMU pid (share vs full);
  **Disk** = attached block image size.
- **Bandwidth**: MicroNT nets through **slirp (userspace)**, so we can throttle in
  userspace — QEMU netdev rate-limiting, or a small userspace proxy. *Nice demo angle.*

### 3. x402 / Algorand integration (mostly config)

- Middleware config per the docs:
  ```ts
  paymentMiddleware({
    'POST /invoke/:fn': { accepts: [{
      scheme: 'exact',
      price: '$0.005',                 // or per-profile
      network: ALGORAND_TESTNET_CAIP2, // algorand:SGO1GKSzyE7IEP...
      payTo: orchestratorAvmAddress,
      extra: { asset: USDC_TESTNET_ASA_ID }
    }]}
  }, server)
  ```
- **Facilitator**: start with managed `facilitator.goplausible.xyz`; optionally
  self-host the `algorand-devrel/x402-demo` reference impl for the "we run our own"
  story (stretch).
- **Payments are atomic txn groups** (`paymentGroup` / `paymentIndex`), `axfer`
  USDC to `payTo`; facilitator can sponsor fees via `extra.feePayer`. All handled
  by the SDK — we just supply config + addresses.

### 4. Guest runtime (MicroNT / LuaJIT)

- MicroNT boots LuaJIT 2.1 as `init`; user Lua lives in `\SystemRoot\pkg\`.
- Thin `init` shim:
  1. Read the injected function zip + args.
  2. Load user `main.lua`.
  3. Call entrypoint `handler(args)`.
  4. Serialize the return (JSON) to console/socket.
- Tiny user contract:

  ```lua
  -- main.lua
  return function(args)
    return { greeting = "hello " .. (args[1] or "world") }
  end
  ```

---

## End-to-end flow (the demo)

1. `lualambda deploy ./hello --profile small` → `fn_abc123`.
2. `lualambda invoke fn_abc123 --arg Algorand`
   - server → `402` + requirements (price for `small`, testnet USDC).
   - CLI auto-signs the Algorand txn group → retries with `X-PAYMENT`.
   - middleware verifies + settles via facilitator → txid confirmed (instant finality).
   - orchestrator boots MicroNT VM, runs `hello/main.lua` with `["Algorand"]`.
   - VM returns `{"greeting":"hello Algorand"}`.
   - server → `200` + result + settlement receipt.
3. CLI prints result + txn explorer link.

---

## Build plan (hackathon-scoped)

### Milestone 0 — spike & de-risk (do first)
- [ ] Boot MicroNT under QEMU from the orchestrator process; inject a payload;
      capture console output.
- [ ] Run the `algorand-devrel/x402-demo` server+client locally; make one paid
      request through the managed facilitator on testnet (USDC faucet + ALGO faucet).
- [ ] Confirm the `@x402/hono` + `@x402/fetch` handshake end-to-end with a stub route.

### Milestone 1 — happy path, no payment
- [ ] CLI `deploy` (zip) + `invoke`.
- [ ] Orchestrator stores fn, launches VM, runs `main.lua`, returns result.
- [ ] Guest `init` shim + function contract.

### Milestone 2 — wire in x402
- [ ] Put `paymentMiddleware` in front of `/invoke`; price the `small` profile.
- [ ] CLI uses `wrapFetchWithPayment`; full paid invoke works on testnet.

### Milestone 3 — profiles & polish
- [ ] Profiles → QEMU memory/cpu/disk caps; price per profile.
- [ ] Userspace bandwidth throttle (stretch / demo flourish).
- [ ] Receipts, explorer links, clean CLI output.

### Stretch
- [ ] Self-host the facilitator (own `/verify` + `/settle`) for the full-control story.
- [ ] Warm VM pool to cut cold-start latency.
- [ ] Per-function pricing / multiple `payTo` addresses.
- [ ] Function logs + a metering breakdown in the receipt.

---

## Tooling & Packaging

### Runtime & bundling — Bun

We write TypeScript and use **Bun** as runtime + bundler. The headline feature is
`bun build --compile`, which produces a **single self-contained executable** that
embeds the Bun runtime + all dependencies — no Node install, no `node_modules` at
the user's end.

- **Cross-compile every platform from one (Linux) machine** via `--target`:

  ```bash
  # CLI, all platforms, from the dev box:
  for t in bun-linux-x64 bun-linux-arm64 bun-darwin-arm64 \
           bun-darwin-x64 bun-windows-x64 bun-windows-arm64; do
    bun build --compile --minify --bytecode \
      --target=$t ./src/cli/main.ts \
      --outfile dist/lualambda-${t#bun-}
  done
  ```
- Useful flags: `--minify --bytecode` (smaller + faster startup), `--define`
  for build-time version stamping, Windows `.exe` icon/metadata, macOS
  `codesign` with a JIT entitlements plist (avoids Gatekeeper warnings).
- **Why not Node SEA:** Node's Single Executable App is still "active
  development," **can't cross-compile** with code-cache/snapshots, has **no macOS
  x64**, and by default `require()` only loads built-ins (you'd bundle with
  esbuild *then* inject with postject). Bun does it all in one flag. Skip SEA.

> ⚠️ **Native-addon caveat:** `--compile` cross-targets can't bundle native
> N-API `.node` addons for *other* OSes, and Windows-icon/metadata flags don't
> work when cross-compiling. Mitigation falls out of our architecture:
> - **CLI = pure JS** (zip + HTTP + Algorand signing via `@x402/avm`/`@x402/fetch`
>   are pure JS) → cross-compiles cleanly to all 6 targets.
> - **Orchestrator** only ever runs on our Linux server, so any native deps
>   compile *natively* there — no cross-compile needed.

### Dev environment — devcontainer (npm supply-chain isolation)

All Node/Bun dependency work happens **inside a devcontainer**, so a malicious
`postinstall` can't touch the host. Decisions for this project:

- **Network: open** inside the container — the container boundary is the trust
  line. (If we ever want more, an npm/registry + testnet egress allowlist is the
  next step, but it's out of scope for the hackathon.)
- **Keep host secrets out** of the container: no real `~/.ssh`, no cloud creds,
  **no Algorand mainnet keys**. Generate a **throwaway testnet key inside** the
  container; fund it from the Lora (ALGO) + Circle (USDC) testnet faucets.
- **Bun reduces install-time risk** even inside the container: it does **not**
  run dependency lifecycle scripts by default (only for an explicit
  `trustedDependencies` allow-list) — a real cut in attack surface vs npm,
  though not a replacement for the container.

### QEMU in dev vs packaged

- **In dev:** run QEMU **inside the devcontainer in TCG mode** (pure userspace
  emulation, no KVM/privileges needed). Slower, but fully reproducible and needs
  no host device passthrough — fine for iterating on the boot/inject/result loop.
- **When packaged:** the orchestrator **auto-detects KVM at runtime**
  (`/dev/kvm` present + accessible → add `-enable-kvm -cpu host`; else fall back
  to TCG). One binary, fast on capable hosts, still works everywhere.

---

## Open questions / decisions to confirm

1. ~~**Language**~~ — **decided: TypeScript on Bun.**
2. **Facilitator**: managed GoPlausible (fast) vs self-hosted reference impl (stretch).
3. **Result channel**: VirtIO-console (start) vs TCP-over-slirp.
4. **Payload injection**: rebuild `initrd.zip` per call vs shared data disk.
5. **Asset**: testnet USDC ASA (matches the "stablecoin" story) — confirm the
   testnet ASA id from the docs.

---

## Key references

- x402: <https://x402.org> · spec: <https://github.com/x402-foundation/x402>
- **Algorand x402 devs**: <https://algorand.co/agentic-commerce/x402/developers>
- **`exact` scheme (Algorand)**: <https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_algo.md>
- **Reference impl / demo**: <https://github.com/algorand-devrel/x402-demo>
- Algorand x402 reference docs: <https://dev.algorand.co/resources/x402-on-algorand/>
- MicroNT (guest OS): <https://github.com/HarryR/nt365>
- Bun single-file executables: <https://bun.sh/docs/bundler/executables>
- Algorand Go SDK (only if we revisit the Go option): <https://github.com/algorand/go-algorand-sdk>

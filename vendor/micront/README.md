# Vendored MicroNT artifacts

Version-controlled boot artifacts for the guest microVM. These are vendored
(rather than fetched from an upstream release) so the repo is self-contained and
reproducible — there is no separate MicroNT release pipeline to pull from.

| File         | What it is                                                                                                                                                                                                                                                |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vmlinux`    | PVH loader ELF (32-bit x86). QEMU boots it via `-kernel`. ~128 KB.                                                                                                                                                                                        |
| `initrd.zip` | MicroNT base system: `ntoskrnl`, HAL, drivers (incl. `nvme2k`, `fastfat`, `vionet`), `lua.exe`/`lua.dll`, `System32/launch.lua` + `preamble.lua`, and `pkg/` (the `nt.zip` runtime + the connect-back agent `pkg/main.lua`). All entries STORED. ~4.2 MB. |

The orchestrator boots these by default (`src/shared/config.ts` →
`LUALAMBDA_KERNEL` / `LUALAMBDA_INITRD_TEMPLATE`); override the env vars to point
at a newer build.

## The overlay (why these stay "upstream-ish")

We rely on the **stable launch shape** of the upstream OS — `launch.lua` reads
the init cmdline's `-- <module> <args>` tail and `require()`s that module;
`preamble.lua` sets up `package.path` + the transparent-zip loader. MicroNT is
designed for exactly this "drop in your own `main.lua`" use case.

So we never fork the base system. Instead, per instance the launcher rebuilds a
copy of `initrd.zip` with:

1. **our overlay** (`src/guest/overlay/`) merged in — currently `pkg/main.lua`
   with the port-from-arg fix, overriding the baked-in agent;
2. **the user's package zips** dropped into `pkg/` (STORED).

This `initrd.zip` happens to already carry the port-fixed `pkg/main.lua` baked
in; the overlay re-applies the same file idempotently, so a fresh upstream build
dropped in here works the same way. See `src/guest/overlay/README.md`.

## Updating

Replace the file(s) and re-run the suite (`bun test`) plus a real boot smoke
test. The FAT16 data disk is built in pure TS (`src/shared/fat16.ts`), so no
host FAT tooling is needed to exercise the full path.

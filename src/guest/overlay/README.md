# initrd overlay

Files here are merged into a copy of the **pristine upstream `initrd.zip`** when
the orchestrator prepares each instance — the upstream artifact itself is never
modified. Paths mirror the in-zip layout: `pkg/main.lua` here is added to the
initrd as `pkg/main.lua`, **overriding** the template's entry of the same name
(a `zip` update replaces matching entries).

Everything is stored as STORED (uncompressed) so the guest's Lua loader can read
it, and the rebuilt initrd is re-validated STORED-only before boot.

## Current overlay

- **`pkg/main.lua`** — the connect-back agent with the port-from-arg fix:
  reads the per-instance port from `arg[1]` (set by `launch.lua` from the kernel
  cmdline's `-- main <port>` tail), falling back to `4444`. The upstream agent
  hardcoded `4444` and ignored the forwarded port; this overlay corrects it
  until the fix lands in an upstream nt365 build. Keep in sync with that build.

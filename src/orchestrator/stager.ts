/**
 * Build the Lua "stager" chunk the host sends to the guest agent.
 *
 * The agent (src/guest/main.lua) reads one length-prefixed Lua chunk and runs it
 * with the control socket as its argument. Our stager:
 *   1. require()s the user module (already baked into the initrd pkg dir),
 *   2. calls handler(args),
 *   3. JSON-encodes the result and sends it framed between RESULT_BEGIN/END so
 *      the host reads the answer off the socket (never grepping the console).
 *
 * The module name and args are interpolated as Lua string literals. The JSON
 * encoder is self-contained (no guest-side dependencies) so it runs before any
 * package manager exists in the guest.
 */

import { RESULT_BEGIN, RESULT_END } from '@/shared/protocol.ts';

/**
 * Stager for an interactive session: hand the serial console to an interactive
 * Lua REPL (`lua.exe -i`) under nt.term's cooked line discipline (echo + editing
 * + CR→LF), which is exactly what an attached terminal drives. `run.cooked` opens
 * the serial console itself and runs the reactor until the child exits, so this
 * chunk blocks for the life of the VM — the host abandons the connect-back socket
 * on teardown (its Bun.listen is aborted with the session).
 *
 * `requireModule` (optional): run that module first, so "run your code, then drop
 * into a shell" — its output/side effects land on the console before the prompt.
 * The module stays loaded in package.loaded, so the REPL can re-require it.
 */
export function buildReplStager(requireModule?: string, args: string[] = []): string {
  const exe = luaString('\\SystemRoot\\System32\\lua.exe');
  const cmdline = luaString('"lua.exe" -i');
  const runModule = requireModule
    ? `pcall(function()
  local h = require(${luaString(requireModule)})
  if type(h) == 'function' then h(${luaArgsTable(args)}) end
end)\n`
    : '';
  // When the REPL exits (Ctrl-D / os.exit), power the VM off so the session ends
  // and QEMU exits — otherwise the host would wait out the wall-clock cap. power_off
  // needs SeShutdownPrivilege enabled; reboot is the fallback (QEMU has -no-reboot,
  // so a reset makes it exit too).
  return `
${runModule}require('nt.term.run').cooked{ exe = ${exe}, cmdline = ${cmdline} }
pcall(function()
  local se  = require('nt.dll.se')
  local sys = require('nt.dll.sys')
  se.enable_privileges(se.open_process_token(), { 'SeShutdownPrivilege' })
  if not pcall(sys.NtShutdownSystem, 'power_off') then
    pcall(sys.NtShutdownSystem, 'reboot')
  end
end)
`;
}

/** Escape a string for embedding as a Lua double-quoted literal. */
function luaString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (code < 0x20)
      out += '\\' + code; // \ddd decimal escape
    else out += ch;
  }
  return out + '"';
}

/** A Lua table constructor for the positional args array. */
function luaArgsTable(args: string[]): string {
  return '{' + args.map(luaString).join(', ') + '}';
}

/**
 * Generate the stager Lua source for a given module + args. `RESULT_BEGIN/END`
 * frame the single JSON line the host parses with extractFramedResult().
 */
export function buildStager(requireModule: string, args: string[]): string {
  // The encoder + run logic is self-contained Lua; only `module` and `args`
  // vary, interpolated as literals below.
  return `
local sock = ...

-- Minimal JSON encoder (objects, arrays, strings, numbers, booleans, nil).
local function encode(v)
  local t = type(v)
  if t == 'nil' then return 'null'
  elseif t == 'boolean' then return v and 'true' or 'false'
  elseif t == 'number' then return tostring(v)
  elseif t == 'string' then
    return '"' .. v:gsub('[%z\\1-\\31\\\\"]', function(c)
      local map = { ['"']='\\\\"', ['\\\\']='\\\\\\\\', ['\\n']='\\\\n', ['\\r']='\\\\r', ['\\t']='\\\\t' }
      return map[c] or string.format('\\\\u%04x', c:byte())
    end) .. '"'
  elseif t == 'table' then
    local n = 0
    for _ in pairs(v) do n = n + 1 end
    local isArray = n > 0
    for i = 1, n do if v[i] == nil then isArray = false break end end
    local parts = {}
    if isArray then
      for i = 1, n do parts[i] = encode(v[i]) end
      return '[' .. table.concat(parts, ',') .. ']'
    else
      for k, val in pairs(v) do
        parts[#parts + 1] = encode(tostring(k)) .. ':' .. encode(val)
      end
      return '{' .. table.concat(parts, ',') .. '}'
    end
  else
    error('cannot encode value of type ' .. t)
  end
end

local function emit(output)
  local line = ${luaString(RESULT_BEGIN)} .. '\\n' .. encode(output) .. '\\n' .. ${luaString(RESULT_END)} .. '\\n'
  pcall(require('nt.net.afd').send, sock, line)
end

local function run()
  local handler = require(${luaString(requireModule)})
  assert(type(handler) == 'function', ${luaString(requireModule)} .. ' must return a function(args)')
  return handler(${luaArgsTable(args)})
end

local ok, result = pcall(run)
if ok then
  emit({ ok = true, result = result })
else
  emit({ ok = false, error = tostring(result) })
end
`;
}

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
 * A no-op "keepalive" stager for interactive sessions. The guest agent dials back
 * and runs whatever chunk we hand it; for a session there is no module to run —
 * the serial getty drives the console independently — so we hand it a chunk that
 * simply parks forever. This keeps the guest's connect-back loop satisfied (one
 * occupied socket) instead of spinning + printing reconnect noise onto the very
 * serial console the user is attached to. The host abandons this socket on
 * teardown (its Bun.listen is aborted with the session).
 */
export function buildKeepaliveStager(): string {
  return `
local ke = require('nt.dll.ke')
while true do ke.NtDelayExecution(false, ke.timeout(3600)) end
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

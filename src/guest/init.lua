-- lualambda guest init shim (LuaJIT, runs as MicroNT `init`).
--
-- Contract (mirrors src/shared/protocol.ts):
--   1. Read the injected input envelope: { require = "blah.dorp", args = {...} }.
--   2. The package zips have already been placed in \SystemRoot\pkg\; MicroNT's
--      Lua loader resolves require('blah.dorp') transparently to
--      \SystemRoot\pkg\blah.zip\blah\dorp.lua.
--   3. The required module must `return function(args) ... end`. Call it(args).
--   4. Emit the result as one line of JSON between sentinel lines on the console.
--
-- The host frames output with RESULT_BEGIN / RESULT_END sentinels and parses the
-- single JSON line between them. Keep this file dependency-light: in the real VM
-- it loads before any package manager exists.

local RESULT_BEGIN = '---LUALAMBDA-RESULT-BEGIN---'
local RESULT_END = '---LUALAMBDA-RESULT-END---'

-- Minimal JSON encoder (objects, arrays, strings, numbers, booleans, nil).
-- A full microVM image can swap this for a real cjson; this keeps the shim
-- self-contained so the boot path has zero dependencies.
local function encode(v)
  local t = type(v)
  if t == 'nil' then
    return 'null'
  elseif t == 'boolean' then
    return v and 'true' or 'false'
  elseif t == 'number' then
    return tostring(v)
  elseif t == 'string' then
    return '"' .. v:gsub('[%z\1-\31\\"]', function(c)
      local map = { ['"'] = '\\"', ['\\'] = '\\\\', ['\n'] = '\\n', ['\r'] = '\\r', ['\t'] = '\\t' }
      return map[c] or string.format('\\u%04x', c:byte())
    end) .. '"'
  elseif t == 'table' then
    -- Array if keys are 1..n contiguous, else object.
    local n = 0
    for _ in pairs(v) do n = n + 1 end
    local isArray = n > 0
    for i = 1, n do
      if v[i] == nil then isArray = false break end
    end
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
  io.write(RESULT_BEGIN, '\n', encode(output), '\n', RESULT_END, '\n')
  io.flush()
end

-- Read the input envelope. In the real VM this comes from the injected payload
-- (initrd file or data disk); for the host-side test harness it is the first
-- line of stdin: a JSON object { entry, args }. Decoding is intentionally tiny
-- and handled host-side in tests; here we accept a pre-parsed global if present.
local function load_input()
  if lualambda_input ~= nil then
    return lualambda_input -- injected by the host as a Lua table
  end
  error('no input envelope provided (expected global lualambda_input)')
end

local function run()
  local input = load_input()
  local modname = assert(input.require, 'input.require (dotted module) is required')
  -- Transparent .zip resolution: require('blah.dorp') loads
  -- \SystemRoot\pkg\blah.zip\blah\dorp.lua via the MicroNT loader.
  local handler = require(modname)
  assert(type(handler) == 'function', modname .. ' must return a function(args)')
  return handler(input.args or {})
end

local ok, result = pcall(run)
if ok then
  emit({ ok = true, result = result })
else
  emit({ ok = false, error = tostring(result) })
end

-- Example lualambda package: zips to hello.zip, required as `hello`.
--
-- The MicroNT loader resolves require('hello') to
-- \SystemRoot\pkg\hello.zip\hello\init.lua (this file). The module must
-- `return function(args)` where args is the array of positional arguments.
-- Whatever you return is JSON-serialized and surfaced as the invocation output.
return function(args)
  return { greeting = 'hello ' .. (args[1] or 'world') }
end

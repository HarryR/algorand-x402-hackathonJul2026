import { test, expect } from 'bun:test';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { resolveWorkDir } from '@/shared/config.ts';

// resolveWorkDir is pure (takes an env bag), so we test precedence directly
// without the import-time-frozen config object.

test('LUALAMBDA_WORKDIR wins over everything', () => {
  const got = resolveWorkDir({
    LUALAMBDA_WORKDIR: '/srv/lambda',
    LUALAMBDA_DATA_DIR: '/old/data',
    XDG_DATA_HOME: '/xdg',
  });
  expect(got).toBe('/srv/lambda');
});

test('LUALAMBDA_DATA_DIR is honored as a back-compat fallback', () => {
  const got = resolveWorkDir({ LUALAMBDA_DATA_DIR: '/old/data', XDG_DATA_HOME: '/xdg' });
  expect(got).toBe('/old/data');
});

test('default uses $XDG_DATA_HOME/lualambda when set', () => {
  const got = resolveWorkDir({ XDG_DATA_HOME: '/xdg' });
  expect(got).toBe(join('/xdg', 'lualambda'));
});

test('default falls back to ~/.local/share/lualambda', () => {
  const got = resolveWorkDir({}); // neither workdir/datadir nor XDG set
  expect(got).toBe(join(homedir(), '.local', 'share', 'lualambda'));
});

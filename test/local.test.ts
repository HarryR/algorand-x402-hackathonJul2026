import { test, expect } from 'bun:test';
import { buildLaunchPlan } from '@/orchestrator/local.ts';
import { deriveId } from '@/shared/idempotency.ts';
import { packageFile } from '@/orchestrator/store.ts';
import { getProfile } from '@/shared/profiles.ts';
import { sha256Hex } from '@/orchestrator/store.ts';
import { zipPackage } from '@/cli/zip.ts';
import { ValidationError } from '@/shared/validate.ts';

// buildLaunchPlan is the pre-launch half of the shared core (no QEMU). It must
// produce EXACTLY the id / package mounts / profile a server invoke would, so a
// local-test is a faithful dry-run. We assert that equivalence here.

test('buildLaunchPlan derives the same id + mounts + profile a server invoke would', async () => {
  const pkg = await zipPackage('examples/hello'); // { name: 'hello.zip', bytes }
  const require = 'hello';
  const args = ['world'];

  const plan = await buildLaunchPlan({
    packages: [{ name: pkg.name, bytes: pkg.bytes }],
    require,
    args,
    profileName: 'nano',
  });

  // id: identical to deriveId over the same inputs (what cmdInvoke/server use).
  expect(plan.id).toBe(await deriveId([pkg.bytes], require, args));

  // packages: content-addressed mount path == packageFile(sha256(bytes)).
  const hash = await sha256Hex(pkg.bytes);
  expect(plan.packages).toEqual([{ name: 'hello.zip', path: packageFile(hash) }]);

  // input + profile pass through faithfully.
  expect(plan.input).toEqual({ require, args });
  expect(plan.profile).toBe(getProfile('nano'));
});

test('buildLaunchPlan honors an explicit (validated) id', async () => {
  const pkg = await zipPackage('examples/hello');
  const plan = await buildLaunchPlan({
    packages: [{ name: pkg.name, bytes: pkg.bytes }],
    require: 'hello',
    args: [],
    profileName: 'small',
    id: 'my-nametag_1',
  });
  expect(plan.id).toBe('my-nametag_1');
});

test('buildLaunchPlan rejects a bad profile name', async () => {
  const pkg = await zipPackage('examples/hello');
  await expect(
    buildLaunchPlan({
      packages: [{ name: pkg.name, bytes: pkg.bytes }],
      require: 'hello',
      args: [],
      profileName: 'gigantic',
    }),
  ).rejects.toThrow(/unknown profile/);
});

test('buildLaunchPlan rejects a traversal id and a bad package name', async () => {
  const pkg = await zipPackage('examples/hello');
  await expect(
    buildLaunchPlan({
      packages: [{ name: pkg.name, bytes: pkg.bytes }],
      require: 'hello',
      args: [],
      profileName: 'nano',
      id: '../escape',
    }),
  ).rejects.toThrow(ValidationError);

  await expect(
    buildLaunchPlan({
      packages: [{ name: '../evil.zip', bytes: pkg.bytes }],
      require: 'hello',
      args: [],
      profileName: 'nano',
    }),
  ).rejects.toThrow(ValidationError);
});

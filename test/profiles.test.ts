import { test, expect } from 'bun:test';
import { PROFILES, getProfile, isProfileName, DEFAULT_PROFILE } from '@/shared/profiles.ts';

test('every profile is self-consistent and named', () => {
  for (const [key, p] of Object.entries(PROFILES)) {
    expect(p.name).toBe(key as typeof p.name);
    expect(p.memoryMiB).toBeGreaterThan(0);
    expect(p.diskMiB).toBeGreaterThan(0);
    expect(p.price).toMatch(/^\$\d/);
  }
});

test('default profile exists', () => {
  expect(PROFILES[DEFAULT_PROFILE]).toBeDefined();
});

test('isProfileName narrows correctly', () => {
  expect(isProfileName('small')).toBe(true);
  expect(isProfileName('huge')).toBe(false);
});

test('getProfile throws on unknown name', () => {
  expect(() => getProfile('huge')).toThrow(/unknown profile/);
  expect(getProfile('med').memoryMiB).toBe(256);
});

import { test, expect } from 'bun:test';
import { NETWORKS, getNetwork, isNetworkName, DEFAULT_NETWORK } from '@/shared/networks.ts';

test('USDC ASA ids are the fixed protocol constants', () => {
  expect(NETWORKS.testnet.usdcAsaId).toBe('10458941');
  expect(NETWORKS.mainnet.usdcAsaId).toBe('31566704');
});

test('CAIP-2 ids match the known genesis hashes', () => {
  expect(NETWORKS.testnet.caip2).toBe('algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=');
  expect(NETWORKS.mainnet.caip2).toBe('algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=');
});

test('each bundle is self-consistent and named', () => {
  for (const [key, n] of Object.entries(NETWORKS)) {
    expect(n.name).toBe(key as typeof n.name);
    expect(n.algodUrl).toMatch(/^https:\/\//);
    expect(n.explorerTxBase).toMatch(/^https:\/\//);
  }
});

test('default is testnet', () => {
  expect(DEFAULT_NETWORK).toBe('testnet');
});

test('getNetwork resolves valid names and rejects others', () => {
  expect(getNetwork('mainnet').usdcAsaId).toBe('31566704');
  expect(() => getNetwork('devnet')).toThrow(/unknown network/);
  expect(isNetworkName('testnet')).toBe(true);
  expect(isNetworkName('devnet')).toBe(false);
});

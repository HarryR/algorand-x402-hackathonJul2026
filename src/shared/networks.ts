/**
 * Per-network Algorand constants. Hardcoded protocol facts — NOT deployment
 * config — selected by `LUALAMBDA_NETWORK` (default `testnet`).
 *
 * The USDC ASA ids and CAIP-2 network ids are fixed by the chain and the asset,
 * so they live here rather than in the environment. Operational endpoints
 * (algod, explorer) carry sensible per-network defaults but stay env-overridable
 * in config.ts. The x402 facilitator URL is shared across networks (it routes by
 * the CAIP-2 id in each request), so it is not part of this bundle.
 */

export type NetworkName = 'testnet' | 'mainnet';

export interface AlgorandNetwork {
  name: NetworkName;
  /** CAIP-2 network id (genesis hash), used in x402 payment requirements. */
  caip2: string;
  /** USDC Algorand Standard Asset id (fixed protocol constant). */
  usdcAsaId: string;
  /** Default algod endpoint for wallet balance / opt-in. */
  algodUrl: string;
  /** Default explorer tx URL prefix: `${explorerTxBase}/${txid}`. */
  explorerTxBase: string;
}

export const NETWORKS: Record<NetworkName, AlgorandNetwork> = {
  testnet: {
    name: 'testnet',
    caip2: 'algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=',
    usdcAsaId: '10458941',
    algodUrl: 'https://testnet-api.algonode.cloud',
    explorerTxBase: 'https://lora.algokit.io/testnet/tx',
  },
  mainnet: {
    name: 'mainnet',
    caip2: 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=',
    usdcAsaId: '31566704',
    algodUrl: 'https://mainnet-api.algonode.cloud',
    explorerTxBase: 'https://lora.algokit.io/mainnet/tx',
  },
};

export const DEFAULT_NETWORK: NetworkName = 'testnet';

export function isNetworkName(s: string): s is NetworkName {
  return s === 'testnet' || s === 'mainnet';
}

export function getNetwork(name: string): AlgorandNetwork {
  if (!isNetworkName(name)) {
    throw new Error(`unknown network "${name}"; expected "testnet" or "mainnet"`);
  }
  return NETWORKS[name];
}

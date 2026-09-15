/** Network identity and RPC plumbing. */

import { Networks, rpc } from '@stellar/stellar-sdk';
import type { Config } from '../config.ts';

export interface StellarNetwork {
  readonly name: Config['STELLAR_NETWORK'];
  readonly passphrase: string;
  readonly rpcUrl: string;
  readonly horizonUrl: string;
}

const PASSPHRASES: Record<Config['STELLAR_NETWORK'], string> = {
  testnet: Networks.TESTNET,
  futurenet: Networks.FUTURENET,
  mainnet: Networks.PUBLIC,
  standalone:
    'Standalone Network ; February 2017',
};

export function resolveNetwork(config: Config): StellarNetwork {
  return {
    name: config.STELLAR_NETWORK,
    passphrase: PASSPHRASES[config.STELLAR_NETWORK],
    rpcUrl: config.rpcUrl,
    horizonUrl: config.horizonUrl,
  };
}

/** A Soroban RPC server. One per process is enough; the SDK pools internally. */
export function createServer(network: StellarNetwork): rpc.Server {
  return new rpc.Server(network.rpcUrl, {
    allowHttp: network.rpcUrl.startsWith('http://'),
    timeout: 20_000,
  });
}

/** Raw explorer links, for humans reading logs and API responses. */
export function explorerLinks(network: StellarNetwork, txHash: string): { horizon: string; stellarExpert: string } {
  const horizonBase =
    network.name === 'mainnet'
      ? 'https://stellar.expert/explorer/public'
      : `https://stellar.expert/explorer/${network.name === 'futurenet' ? 'futurenet' : 'testnet'}`;
  return {
    horizon: `${network.horizonUrl}/tx/${txHash}`,
    stellarExpert: `${horizonBase}/tx/${txHash}`,
  };
}

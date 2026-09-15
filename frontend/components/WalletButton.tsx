'use client';

/** Connect / disconnect control, plus the network-mismatch warning when it applies. */

import { useWallet } from './WalletProvider.tsx';
import { shortenAddress } from '../lib/format.ts';

export function WalletButton() {
  const { address, available, connecting, error, connect, disconnect, networkMismatch } = useWallet();

  if (address) {
    return (
      <div className="flex items-center gap-2">
        {networkMismatch ? (
          <span
            className="chip border-amber2/40 bg-amber2/10 text-amber2"
            title="Freighter is on a different network than the relayer. Switch networks before signing."
          >
            wrong network
          </span>
        ) : null}
        <button
          type="button"
          onClick={disconnect}
          className="btn-secondary font-mono text-xs"
          title="Freighter keeps its own permission; this only forgets the address here."
        >
          {shortenAddress(address)}
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3">
      {error ? <span className="text-xs text-wax-300">{error}</span> : null}
      <button
        type="button"
        onClick={() => void connect()}
        disabled={connecting}
        className="btn-primary"
      >
        {connecting ? 'Connecting…' : available ? 'Connect wallet' : 'Install Freighter'}
      </button>
    </div>
  );
}

/** A full-width banner, for pages where the wallet is the whole point. */
export function NetworkWarning() {
  const { networkMismatch, walletPassphrase, expectedPassphrase } = useWallet();
  if (!networkMismatch) return null;

  return (
    <div className="rounded-lg border border-amber2/40 bg-amber2/10 p-4 text-sm text-amber2">
      <p className="font-medium">Your wallet is on a different network.</p>
      <p className="mt-1 text-amber2/80">
        Freighter: <span className="font-mono">{walletPassphrase ?? 'unknown'}</span>
        <br />
        Relayer: <span className="font-mono">{expectedPassphrase ?? 'unknown'}</span>
      </p>
      <p className="mt-2 text-amber2/80">
        Switch Freighter to the relayer&rsquo;s network before signing. A transaction signed for
        the wrong network is rejected by the RPC in a way whose error message rarely mentions the
        real cause.
      </p>
    </div>
  );
}

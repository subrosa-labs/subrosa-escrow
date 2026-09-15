'use client';

/**
 * Wallet context.
 *
 * Keeps the connected address, the passphrase Freighter is pointed at, and whether that
 * matches the network the relayer builds envelopes for. The mismatch case is surfaced
 * loudly: signing a testnet transaction with a mainnet wallet produces an XDR that the
 * network rejects in a way that is genuinely hard to diagnose from the error message.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  connectWallet,
  currentAddress,
  currentNetworkPassphrase,
  isWalletAvailable,
  WalletError,
} from '../lib/wallet.ts';
import { api } from '../lib/api.ts';

export interface WalletState {
  readonly address: string | null;
  readonly walletPassphrase: string | null;
  readonly expectedPassphrase: string | null;
  readonly available: boolean;
  readonly connecting: boolean;
  readonly error: string | null;
  readonly networkMismatch: boolean;
  connect: () => Promise<void>;
  disconnect: () => void;
  refresh: () => Promise<void>;
}

const WalletContext = createContext<WalletState | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const [address, setAddress] = useState<string | null>(null);
  const [walletPassphrase, setWalletPassphrase] = useState<string | null>(null);
  const [expectedPassphrase, setExpectedPassphrase] = useState<string | null>(null);
  const [available, setAvailable] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    // Restore silently: `isAllowed` never opens a popup, so a returning visitor sees
    // their address without being asked again.
    void (async () => {
      const [hasWallet, restored, passphrase, expected] = await Promise.all([
        isWalletAvailable(),
        currentAddress(),
        currentNetworkPassphrase(),
        api.networkPassphrase(),
      ]);
      if (cancelled) return;
      setAvailable(hasWallet);
      setAddress(restored);
      setWalletPassphrase(passphrase);
      setExpectedPassphrase(expected);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const connect = useCallback(async () => {
    setConnecting(true);
    setError(null);
    try {
      const [connection, expected] = await Promise.all([connectWallet(), api.networkPassphrase()]);
      setAddress(connection.address);
      setWalletPassphrase(connection.networkPassphrase);
      setExpectedPassphrase(expected);
    } catch (caught) {
      setError(caught instanceof WalletError ? caught.message : 'could not connect to Freighter');
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(() => {
    // Freighter has no revoke call, and pretending otherwise would be a lie. We forget
    // the address locally; the extension keeps its own permission.
    setAddress(null);
    setWalletPassphrase(null);
    setError(null);
  }, []);

  const refresh = useCallback(async () => {
    const [restored, passphrase] = await Promise.all([
      currentAddress(),
      currentNetworkPassphrase(),
    ]);
    setAddress(restored);
    setWalletPassphrase(passphrase);
  }, []);

  const value = useMemo<WalletState>(
    () => ({
      address,
      walletPassphrase,
      expectedPassphrase,
      available,
      connecting,
      error,
      networkMismatch:
        address !== null &&
        expectedPassphrase !== null &&
        walletPassphrase !== null &&
        walletPassphrase !== expectedPassphrase,
      connect,
      disconnect,
      refresh,
    }),
    [
      address,
      walletPassphrase,
      expectedPassphrase,
      available,
      connecting,
      error,
      connect,
      disconnect,
      refresh,
    ],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletState {
  const context = useContext(WalletContext);
  if (!context) throw new Error('useWallet must be used inside a WalletProvider');
  return context;
}

import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';
import { WalletButton } from '../components/WalletButton.tsx';
import { WalletProvider } from '../components/WalletProvider.tsx';

export const metadata: Metadata = {
  title: {
    default: 'SubRosa Escrow',
    template: '%s · SubRosa Escrow',
  },
  description:
    'Sealed-bid auctions on Stellar. Bids are timelock-encrypted to a future drand round, so nobody — including the operator — can read them until bidding closes.',
  applicationName: 'SubRosa Escrow',
  robots: { index: true, follow: true },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <WalletProvider>
          <div className="mx-auto flex min-h-screen max-w-5xl flex-col px-5 py-6">
            <header className="flex flex-wrap items-center justify-between gap-4 border-b border-ink-700 pb-4">
              <Link href="/" className="flex items-baseline gap-2 no-underline">
                <span className="text-lg font-semibold tracking-tight text-ash-100">
                  SubRosa
                </span>
                <span className="text-xs uppercase tracking-[0.2em] text-ash-400">escrow</span>
              </Link>

              <nav className="flex items-center gap-1 text-sm">
                <Link href="/auctions" className="btn-ghost no-underline">
                  Auctions
                </Link>
                <Link href="/create" className="btn-ghost no-underline">
                  Create
                </Link>
                <Link href="/how" className="btn-ghost no-underline">
                  How it works
                </Link>
                <span className="ml-3">
                  <WalletButton />
                </span>
              </nav>
            </header>

            <main className="flex-1 py-8">{children}</main>

            <footer className="border-t border-ink-700 pt-4 text-xs text-ash-400">
              <p>
                Bids are encrypted in your browser with <span className="font-mono">tlock</span> and
                sealed to a future League of Entropy quicknet round. The operator holds a ciphertext
                and a hash, never an amount.
              </p>
            </footer>
          </div>
        </WalletProvider>
      </body>
    </html>
  );
}

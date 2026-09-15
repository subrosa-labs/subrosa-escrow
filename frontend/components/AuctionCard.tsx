import Link from 'next/link';
import type { AuctionDto } from '../lib/types.ts';
import { roundTime } from '../lib/drand.ts';
import { formatAmount, shortenAddress } from '../lib/format.ts';
import { PhaseBadge } from './PhaseBadge.tsx';
import { Countdown } from './Countdown.tsx';
import { Stat } from './ui.tsx';

/**
 * Auction summary.
 *
 * The card shows how many envelopes exist but never their contents — that is the entire
 * product, so the copy is explicit about it rather than leaving a reader to wonder
 * whether "0 revealed" means "no bids" or "bids we cannot see".
 */
export function AuctionCard({
  auction,
  tokenSymbol,
}: {
  auction: AuctionDto;
  tokenSymbol?: string;
}) {
  const closed = auction.revealedCount > 0 || auction.phase !== 'Sealed';

  return (
    <Link
      href={`/auctions/${auction.id}`}
      className="card block transition-colors hover:border-ink-600"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <span className="font-mono text-sm text-ash-400">#{auction.id}</span>
          <PhaseBadge phase={auction.phase} />
        </div>
        {auction.phase === 'Sealed' ? (
          // The countdown target is derived, not fetched: the reveal round is fixed at
          // creation and drand rounds are arithmetic, so the list needs no timing API.
          <Countdown
            targetMs={roundTime(auction.revealRound) * 1000}
            label="opens in"
            className="text-xs text-ash-400"
          />
        ) : null}
      </div>

      <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat
          label="Reserve"
          value={formatAmount(auction.reservePrice, 7, { withSymbol: tokenSymbol })}
        />
        <Stat
          label="Sealed bids"
          value={auction.sealedCount}
          hint="encrypted, unreadable"
        />
        <Stat
          label="Revealed"
          value={closed ? auction.revealedCount : '—'}
          hint={closed ? undefined : 'after the commit deadline'}
        />
        <Stat
          label="Escrowed"
          value={formatAmount(auction.escrowed, 7, { withSymbol: tokenSymbol })}
        />
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-ink-700 pt-3 text-xs text-ash-400">
        <span>
          seller <span className="font-mono">{shortenAddress(auction.seller)}</span>
        </span>
        <span>
          reveal round <span className="font-mono">{auction.revealRound}</span>
        </span>
        {auction.winner ? (
          <span className="text-reveal-300">
            winner <span className="font-mono">{shortenAddress(auction.winner)}</span> at{' '}
            {formatAmount(auction.hammerPrice, 7, { withSymbol: tokenSymbol })}
          </span>
        ) : null}
      </div>
    </Link>
  );
}

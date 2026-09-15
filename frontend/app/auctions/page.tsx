import Link from 'next/link';
import { api } from '../../lib/api.ts';
import { SETTLEMENT_SYMBOL } from '../../lib/format.ts';
import { AuctionCard } from '../../components/AuctionCard.tsx';
import { Notice } from '../../components/ui.tsx';
import type { AuctionDto } from '../../lib/types.ts';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Auctions' };

export default async function AuctionsPage() {
  let auctions: readonly AuctionDto[] = [];
  let source = 'chain';
  let failure: string | null = null;

  try {
    const result = await api.auctions(20);
    auctions = result.auctions;
    source = result.source;
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-xl font-medium text-ash-100">Auctions</h1>
          <p className="mt-1 text-sm text-ash-400">
            Sealed counts are public. Amounts appear only once the reveal round has published, when
            they can no longer influence anyone&rsquo;s bid.
          </p>
        </div>
        <Link href="/create" className="btn-secondary no-underline">
          New auction
        </Link>
      </div>

      {failure ? (
        <Notice tone="warn" title="Could not list auctions">
          {failure}
        </Notice>
      ) : null}

      {!failure && auctions.length === 0 ? (
        <Notice tone="info" title="No auctions on this contract yet">
          Create one to exercise the full lifecycle — seal, reveal, fund, settle, claim.
        </Notice>
      ) : null}

      {auctions.length > 0 ? (
        <>
          <p className="text-xs text-ash-400">
            {auctions.length} auction{auctions.length === 1 ? '' : 's'} · read from the{' '}
            {source === 'chain' ? 'ledger' : 'relayer cache'}
          </p>
          <div className="space-y-3">
            {auctions.map((auction) => (
              <AuctionCard key={auction.id} auction={auction} tokenSymbol={SETTLEMENT_SYMBOL} />
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

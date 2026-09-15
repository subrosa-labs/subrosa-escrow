import Link from 'next/link';
import { api } from '../lib/api.ts';
import { formatAmount, SETTLEMENT_SYMBOL, formatBps } from '../lib/format.ts';
import { AuctionCard } from '../components/AuctionCard.tsx';
import { Notice, Stat } from '../components/ui.tsx';
import type { AuctionDto } from '../lib/types.ts';

// Live chain reads, so nothing here is cached across requests.
export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Sealed-bid auctions on Stellar',
};

export default async function HomePage() {
  const [health, auctions, drand, config] = await Promise.all([
    api.health().catch(() => null),
    api.auctions(6).catch(() => null),
    api.drandInfo().catch(() => null),
    api.config().catch(() => null),
  ]);

  const list: readonly AuctionDto[] = auctions?.auctions ?? [];

  return (
    <div className="space-y-10">
      <section className="space-y-5">
        <h1 className="max-w-3xl text-3xl font-semibold leading-tight tracking-tight text-ash-100 sm:text-4xl">
          Bids nobody can read, until nobody can change theirs.
        </h1>
        <p className="max-w-2xl text-ash-300">
          SubRosa is a sealed-bid auction engine on Stellar. A bid is encrypted in the bidder&rsquo;s
          browser to a future drand round, so the amount provably cannot exist anywhere — not on the
          ledger, not in our database, not in our memory — until that round&rsquo;s threshold
          signature is published. Once it is published the key is public to everybody at once,
          which is what makes revealing compulsory rather than optional.
        </p>

        <div className="flex flex-wrap gap-3">
          <Link href="/auctions" className="btn-primary no-underline">
            Browse auctions
          </Link>
          <Link href="/create" className="btn-secondary no-underline">
            Create an auction
          </Link>
          <Link href="/how" className="btn-ghost no-underline">
            Read the design
          </Link>
        </div>
      </section>

      {health === null ? (
        <Notice tone="warn" title="The relayer is not reachable">
          Nothing on this page can be loaded without it. Start the backend with{' '}
          <code className="font-mono">npm run dev:backend</code> and point{' '}
          <code className="font-mono">NEXT_PUBLIC_SUBROSA_API_URL</code> at it. Reads come from the
          chain through the relayer; the seal flow needs it only to publish a ciphertext and build a
          transaction.
        </Notice>
      ) : null}

      {health !== null && health.preflight.length > 0 ? (
        <Notice tone="error" title="The deployment is not fully configured">
          <ul className="list-inside list-disc space-y-1">
            {health.preflight.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </Notice>
      ) : null}

      <section className="card space-y-4">
        <h2 className="text-sm font-medium uppercase tracking-wider text-ash-400">
          Live parameters
        </h2>
        <div className="grid grid-cols-2 gap-5 sm:grid-cols-4">
          <Stat
            label="Network"
            value={health ? health.network : drand ? 'drand reachable' : 'unknown'}
            hint={health?.contractId ? `contract ${health.contractId.slice(0, 8)}…` : undefined}
          />
          <Stat
            label="Stellar ledger"
            value={health?.ledger ?? '—'}
            hint={health?.rpc === 'unreachable' ? 'RPC unreachable' : 'RPC ok'}
          />
          <Stat
            label="drand round"
            value={drand?.latestRound ?? '—'}
            hint={drand ? `${drand.periodSeconds}s rounds · ${drand.beaconId}` : undefined}
          />
          <Stat
            label="Protocol fee"
            value={config ? formatBps(config.feeBps) : '—'}
            hint={config ? `treasury ${config.treasury.slice(0, 6)}…` : undefined}
          />
        </div>

        {config ? (
          <div className="grid grid-cols-2 gap-5 border-t border-ink-700 pt-4 sm:grid-cols-4">
            <Stat
              label="Minimum bond"
              value={formatAmount(config.minBond, config.tokenDecimals, {
                withSymbol: SETTLEMENT_SYMBOL,
              })}
            />
            <Stat label="Bid cap per auction" value={config.maxBids} hint="bounds settlement cost" />
            <Stat
              label="Attestation quorum"
              value={`${config.relayerThreshold} of ${config.relayerCommitteeSize}`}
              hint="ed25519 beacon witness"
            />
            <Stat
              label="Reveal margin"
              value={`${config.marginRounds} round${config.marginRounds === 1 ? '' : 's'}`}
              hint="buffer between commit close and reveal"
            />
          </div>
        ) : null}
      </section>

      <section className="space-y-4">
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-medium text-ash-100">Recent auctions</h2>
          <Link href="/auctions" className="text-sm text-ash-400 no-underline hover:text-ash-200">
            all auctions →
          </Link>
        </div>

        {list.length === 0 ? (
          <Notice tone="info" title="No auctions yet">
            {health === null
              ? 'The relayer is unreachable, so there is nothing to list.'
              : 'Nothing has been created on this contract yet. Create one to see the whole lifecycle run.'}
          </Notice>
        ) : (
          <div className="space-y-3">
            {list.map((auction) => (
              <AuctionCard
                key={auction.id}
                auction={auction}
                tokenSymbol={SETTLEMENT_SYMBOL}
              />
            ))}
          </div>
        )}
      </section>

      <section className="grid gap-4 sm:grid-cols-3">
        <Explain
          title="Sealed"
          tone="wax"
          body="A bid is encrypted to a drand round that does not exist yet. The plaintext never leaves the bidder's browser, and the round's key is a threshold signature that no single party can produce early."
        />
        <Explain
          title="Revealed"
          tone="reveal"
          body="When the round publishes, the key becomes public — so every envelope can be opened by anyone. A bidder who would rather not reveal can no longer choose: a relayer or a stranger can do it for them."
        />
        <Explain
          title="Escrowed"
          tone="ash"
          body="The winner tops up to the hammer price inside a funding window. Bids that revealed more than they escrowed forfeit their bond to the seller, and the next bidder up wins instead."
        />
      </section>
    </div>
  );
}

function Explain({
  title,
  body,
  tone,
}: {
  title: string;
  body: string;
  tone: 'wax' | 'reveal' | 'ash';
}) {
  const tones = {
    wax: 'border-wax-500/30',
    reveal: 'border-reveal-500/30',
    ash: 'border-ink-600',
  } as const;

  return (
    <div className={`rounded-xl border ${tones[tone]} bg-ink-900/60 p-5`}>
      <h3 className="text-sm font-medium text-ash-100">{title}</h3>
      <p className="mt-2 text-sm text-ash-400">{body}</p>
    </div>
  );
}

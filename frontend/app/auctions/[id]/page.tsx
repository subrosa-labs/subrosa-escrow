import Link from 'next/link';
import { notFound } from 'next/navigation';
import { api, ApiError } from '../../../lib/api.ts';
import { beaconUrl, roundTime, QUICKNET } from '../../../lib/drand.ts';
import { formatAmount, formatTimestamp, SETTLEMENT_SYMBOL, shortenAddress } from '../../../lib/format.ts';
import { windowsOf, type AuctionDetailDto, type BidDto, type ConfigDto } from '../../../lib/types.ts';
import { AuctionActions } from '../../../components/AuctionActions.tsx';
import { Countdown } from '../../../components/Countdown.tsx';
import { PhaseBadge } from '../../../components/PhaseBadge.tsx';
import { SealBidForm } from '../../../components/SealBidForm.tsx';
import { ExplorerLink, Hash, Notice, Stat } from '../../../components/ui.tsx';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: { id: string } }) {
  return { title: `Auction #${params.id}` };
}

export default async function AuctionPage({ params }: { params: { id: string } }) {
  if (!/^\d+$/.test(params.id)) notFound();

  let detail: AuctionDetailDto;
  try {
    detail = await api.auction(params.id);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }

  const [bidResult, config] = await Promise.all([
    api.bids(params.id).catch(() => ({ bids: [] as BidDto[] })),
    api.config().catch(() => null),
  ]);

  const bids: readonly BidDto[] = bidResult.bids;
  const { auction, timing, attestation, envelopes } = detail;
  const windows = windowsOf(auction.phase, timing);
  const decimals = config?.tokenDecimals ?? 7;

  return (
    <div className="space-y-8">
      <div className="space-y-3">
        <Link href="/auctions" className="text-sm text-ash-400 no-underline hover:text-ash-200">
          ← auctions
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-medium text-ash-100">Auction #{auction.id}</h1>
          <PhaseBadge phase={auction.phase} />
          {auction.phase === 'Sealed' && timing.commitClosesInMs > 0 ? (
            <Countdown
              targetMs={timing.revealRoundPublishesAt}
              label="sealing closes in"
              className="text-sm text-ash-400"
            />
          ) : null}
        </div>
        <p className="max-w-3xl text-sm text-ash-400">
          seller <span className="font-mono text-ash-200">{auction.seller}</span>
        </p>
      </div>

      <Windows summary={windows} timing={timing} phase={auction.phase} config={config} />

      <section className="card space-y-4">
        <h2 className="text-sm font-medium uppercase tracking-wider text-ash-400">Terms</h2>
        <div className="grid grid-cols-2 gap-5 sm:grid-cols-4">
          <Stat
            label="Reserve"
            value={formatAmount(auction.reservePrice, decimals, { withSymbol: SETTLEMENT_SYMBOL })}
          />
          <Stat
            label="Bid bond"
            value={formatAmount(auction.bond, decimals, { withSymbol: SETTLEMENT_SYMBOL })}
            hint="flat, per bidder"
          />
          <Stat
            label="Seller bond"
            value={formatAmount(auction.sellerBond, decimals, { withSymbol: SETTLEMENT_SYMBOL })}
            hint="forfeit on cancellation"
          />
          <Stat
            label="Reveal round"
            value={auction.revealRound}
            hint={formatTimestamp(roundTime(auction.revealRound, QUICKNET) * 1000)}
          />
        </div>

        <div className="grid grid-cols-2 gap-5 border-t border-ink-700 pt-4 sm:grid-cols-4">
          <Stat label="Sealed bids" value={auction.sealedCount} hint="encrypted" />
          <Stat
            label="Revealed"
            value={windows.sealing ? '—' : auction.revealedCount}
            hint={windows.sealing ? 'sealed until the round publishes' : undefined}
          />
          <Stat
            label="Escrowed"
            value={formatAmount(auction.escrowed, decimals, { withSymbol: SETTLEMENT_SYMBOL })}
          />
          <Stat
            label="Slashed bonds"
            value={formatAmount(auction.slashed, decimals, { withSymbol: SETTLEMENT_SYMBOL })}
            hint={auction.winner ? 'paid to the seller' : undefined}
          />
        </div>

        {auction.winner ? (
          <div className="rounded-lg border border-reveal-500/30 bg-reveal-500/5 p-4">
            <div className="grid grid-cols-2 gap-5 sm:grid-cols-3">
              <Stat
                label="Winner"
                value={<span className="font-mono">{shortenAddress(auction.winner)}</span>}
                mono={false}
              />
              <Stat
                label="Hammer price"
                value={formatAmount(auction.hammerPrice, decimals, { withSymbol: SETTLEMENT_SYMBOL })}
              />
              <Stat
                label="Claimed out"
                value={formatAmount(auction.claimed, decimals, { withSymbol: SETTLEMENT_SYMBOL })}
                mono
              />
            </div>
          </div>
        ) : null}

        {auction.phase === 'Cancelled' && auction.cancelCompensation !== '0' ? (
          <Notice tone="warn" title="The seller cancelled after bids were sealed">
            The seller bond was liquidated and split between the sealed bidders:{' '}
            <span className="font-mono">
              {formatAmount(auction.cancelCompensation, decimals, { withSymbol: SETTLEMENT_SYMBOL })}
            </span>{' '}
            each. That is the only thing that makes cancelling a credible commitment rather than an
            option.
          </Notice>
        ) : null}
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-4">
          <h2 className="text-lg font-medium text-ash-100">What you can do</h2>
          <AuctionActions
            auction={auction}
            timing={timing}
            windows={windows}
            claimable={detail.claimable}
            attested={attestation !== null}
            tokenDecimals={decimals}
            tokenSymbol={SETTLEMENT_SYMBOL}
          />

          {windows.sealing ? (
            <div className="card">
              <h3 className="text-sm font-medium text-ash-100">Place a sealed bid</h3>
              <p className="mt-1 text-xs text-ash-400">
                Encrypted here, in this tab. What leaves your browser is a ciphertext and a hash.
              </p>
              <div className="mt-4">
                <SealBidForm
                  auction={auction}
                  tokenDecimals={decimals}
                  tokenSymbol={SETTLEMENT_SYMBOL}
                  recommendedBond={auction.bond}
                  minBond={config?.minBond ?? auction.bond}
                />
              </div>
            </div>
          ) : null}
        </div>

        <div className="space-y-4">
          <h2 className="text-lg font-medium text-ash-100">Beacon</h2>
          <div className="card space-y-3">
            {attestation === null ? (
              <p className="text-sm text-ash-400">
                No attestation on record yet. The relayer BLS-verifies round{' '}
                <span className="font-mono">{auction.revealRound}</span> against quicknet&rsquo;s pinned
                public key, then has the quorum sign a digest binding{' '}
                <span className="font-mono">(chain, round, randomness, auction)</span>.
              </p>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-4">
                  <Stat label="Round" value={attestation.round} />
                  <Stat
                    label="Signers"
                    value={`${attestation.signers.length} of ${attestation.committeeSize}`}
                    hint={`threshold ${attestation.threshold}`}
                  />
                </div>
                <div>
                  <div className="label">Randomness</div>
                  <div className="mt-1 break-all">
                    <Hash value={attestation.randomness} chars={16} />
                  </div>
                </div>
                <div className="text-xs text-ash-400">
                  Signer indexes:{' '}
                  <span className="font-mono">[{attestation.signers.join(', ')}]</span> · recorded{' '}
                  {formatTimestamp(Date.parse(attestation.createdAt))}
                </div>
                <ExplorerLink url={beaconUrl(attestation.round)} className="text-xs">
                  Verify round {attestation.round} at the drand beacon →
                </ExplorerLink>
                <p className="border-t border-ink-700 pt-3 text-xs text-ash-400">
                  Soroban has no pairing function, so the BLS signature itself is verified off-chain
                  by every relayer before it signs. On-chain authenticity is an{' '}
                  {attestation.threshold}-of-{attestation.committeeSize} ed25519 quorum — a real
                  trust assumption, documented rather than hidden.
                </p>
              </>
            )}
          </div>

          <h2 className="text-lg font-medium text-ash-100">Bulletin</h2>
          <div className="card space-y-3">
            <p className="text-xs text-ash-400">
              The relayer holds {envelopes} ciphertext{envelopes === 1 ? '' : 's'} sealed to round{' '}
              {auction.revealRound}, so a reveal never depends on the bidder being online. Without
              the beacon they are noise; after it they are public anyway. Each is pinned by the{' '}
              <span className="font-mono">envelope_hash</span> committed on-chain, so the relayer
              cannot swap one out even if it wanted to.
            </p>
            {bids.length > 0 ? (
              <BidTable bids={bids} decimals={decimals} sealing={windows.sealing} />
            ) : (
              <p className="text-sm text-ash-400">
                No bids have been filed. A sealed bid is a committed hash plus a ciphertext the
                relayer cannot open — so a bidder keeps their own copy of the opening as well.
              </p>
            )}
            {bids.length > 0 ? (
              <p className="text-xs text-ash-400">
                Bonds are escrowed at seal time, which is why their size is public while the bid is
                not.
              </p>
            ) : null}
          </div>
        </div>
      </section>

      <DeploymentNote config={config} />
    </div>
  );
}

/**
 * Window tiles.
 *
 * Three rows, not four, because revealing and funding share one interval: the contract
 * accepts both from the commit deadline through the funding deadline. Splitting them into
 * separate tiles would imply a boundary that is not enforced anywhere.
 */
function Windows({
  summary,
  timing,
  phase,
  config,
}: {
  summary: ReturnType<typeof windowsOf>;
  timing: AuctionDetailDto['timing'];
  phase: AuctionDetailDto['auction']['phase'];
  config: ConfigDto | null;
}) {
  const ledgerSeconds = config?.assumedLedgerSeconds ?? 5;
  const rows: { label: string; open: boolean; detail: string }[] = [
    {
      label: 'Sealing',
      open: summary.sealing,
      detail: remaining('closes', timing.commitLedgersRemaining, ledgerSeconds),
    },
    {
      label: 'Opening & funding',
      open: summary.revealAndFunding,
      detail: remaining('closes', timing.fundingLedgersRemaining, ledgerSeconds),
    },
    {
      label: 'Settlement',
      open: summary.settlement,
      detail: summary.settlement
        ? 'permissionless — anyone can trigger it'
        : remaining('opens', timing.fundingLedgersRemaining, ledgerSeconds),
    },
  ];

  return (
    <section className="card space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium uppercase tracking-wider text-ash-400">Windows</h2>
        <span className="text-xs text-ash-400">
          {timing.currentLedger === null ? (
            'ledger height unavailable — using phase and beacon clock'
          ) : (
            <>
              current ledger <span className="font-mono">{timing.currentLedger}</span> · assuming{' '}
              {ledgerSeconds}s closes
            </>
          )}
        </span>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        {rows.map((row) => (
          <div
            key={row.label}
            className={`rounded-lg border p-3 ${
              row.open ? 'border-reveal-500/40 bg-reveal-500/5' : 'border-ink-700 bg-ink-850/50'
            }`}
          >
            <div className="flex items-center gap-2">
              <span
                className={`h-1.5 w-1.5 rounded-full ${row.open ? 'bg-reveal-400' : 'bg-ash-400'}`}
                aria-hidden
              />
              <span className="text-sm text-ash-100">{row.label}</span>
            </div>
            <p className="mt-1 text-xs text-ash-400">{row.detail}</p>
          </div>
        ))}
      </div>

      {phase === 'Funding' && !summary.settlement ? (
        <p className="text-xs text-ash-400">
          The phase has moved to funding but the window has not closed: <span className="font-mono">reveal_bid</span>{' '}
          and <span className="font-mono">fund_bid</span> are both still accepted until the funding
          deadline. A stalled relayer cannot strand an auction, because the phase is recomputed from
          the ledger on every call rather than trusted from storage.
        </p>
      ) : null}
    </section>
  );
}

/**
 * A window's state in words.
 *
 * Estimates come from the assumed ledger close time, which is a configuration value, not a
 * measurement — so this is labelled as an estimate everywhere it appears rather than
 * presented as a deadline the chain has agreed to.
 */
function remaining(
  verb: 'closes' | 'opens',
  ledgers: number | null,
  ledgerSeconds: number,
): string {
  if (ledgers === null) return 'ledger height unavailable';
  if (verb === 'closes') {
    if (ledgers < 0) return 'closed';
    return `closes in ${ledgers} ledger${ledgers === 1 ? '' : 's'} (≈ ${estimate(ledgers, ledgerSeconds)})`;
  }
  if (ledgers >= 0) return `opens in ≈ ${estimate(ledgers, ledgerSeconds)}`;
  return 'open';
}

function estimate(ledgers: number, ledgerSeconds: number): string {
  const seconds = Math.abs(ledgers) * ledgerSeconds;
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 120) return `${minutes}m`;
  const hours = minutes / 60;
  if (hours < 48) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

function BidTable({
  bids,
  decimals,
  sealing,
}: {
  bids: readonly BidDto[];
  decimals: number;
  sealing: boolean;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs">
        <thead className="text-ash-400">
          <tr className="border-b border-ink-700">
            <th className="py-2 pr-3 font-medium">bidder</th>
            <th className="py-2 pr-3 font-medium">bond</th>
            <th className="py-2 pr-3 font-medium">revealed</th>
            <th className="py-2 pr-3 font-medium">escrowed</th>
            <th className="py-2 font-medium">status</th>
          </tr>
        </thead>
        <tbody className="font-mono">
          {bids.map((bid) => (
            <tr key={bid.bidder} className="border-b border-ink-800 last:border-0">
              <td className="py-2 pr-3 text-ash-200" title={bid.bidder}>
                {shortenAddress(bid.bidder)}
              </td>
              <td className="py-2 pr-3 text-ash-300">
                {formatAmount(bid.bond, decimals)}
              </td>
              <td className="py-2 pr-3 text-ash-300">
                {bid.revealed ? formatAmount(bid.revealedAmount, decimals) : sealing ? 'sealed' : '—'}
              </td>
              <td className="py-2 pr-3 text-ash-300">{formatAmount(bid.funded, decimals)}</td>
              <td className="py-2">
                {bid.disqualified ? (
                  <span className="text-wax-300">bond slashed</span>
                ) : bid.revealed ? (
                  <span className="text-reveal-300">revealed</span>
                ) : (
                  <span className="text-ash-400">sealed</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DeploymentNote({ config }: { config: ConfigDto | null }) {
  if (config === null) {
    return (
      <Notice tone="warn" title="Protocol configuration unavailable">
        The relayer could not read the contract&rsquo;s configuration, so the panels above fall back
        to display assumptions (7 decimals, 5 second ledgers). Window availability is derived from
        ledger distance where it is available and from the phase and beacon clock where it is not.
      </Notice>
    );
  }

  return (
    <section className="card space-y-2 text-xs text-ash-400">
      <h2 className="text-sm font-medium uppercase tracking-wider text-ash-400">Deployment</h2>
      <div className="grid gap-2 sm:grid-cols-2">
        <p>
          settlement token <Hash value={config.settlementToken} chars={8} />
        </p>
        <p>
          treasury <Hash value={config.treasury} chars={8} />
        </p>
        <p>
          admin <Hash value={config.admin} chars={8} />
        </p>
        <p>
          drand chain <Hash value={config.chainHash} chars={8} />
        </p>
      </div>
      <p>
        Fee {config.feeBps / 100}% on the hammer price. Bond floor{' '}
        {formatAmount(config.minBond, config.tokenDecimals, { withSymbol: SETTLEMENT_SYMBOL })}.
        Maximum {config.maxBids} sealed bids per auction, which is what bounds the cost of settling
        one. {config.paused ? 'The contract is paused: all writes will fail.' : ''}
      </p>
    </section>
  );
}

'use client';

/**
 * Everything a participant can do once bids are sealed.
 *
 * The panel is driven by ledger distance rather than by the phase name, because the
 * contract's windows are finer than its phase labels: `reveal_bid` and `fund_bid` both
 * stay callable right through the funding window, while `settle` is only legal strictly
 * after it. Getting that wrong produces a rejected transaction with an `InvalidPhase`
 * error, which tells a user nothing.
 *
 * Two deliberate design choices:
 *
 * * **Reveal prefers the local opening.** The bidder's own backup file (or the envelope
 *   in the bulletin, opened with the now-public beacon) is passed to the contract
 *   directly. That means the reveal path depends on neither drand's HTTP API nor this
 *   relayer being up.
 * * **Settle is offered to everyone.** It is permissionless on-chain, so a stuck relayer
 *   queue is never a reason a seller has to wait for their money.
 */

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '../lib/api.ts';
import { QUICKNET } from '../lib/drand.ts';
import { hexToBytes32 } from '../lib/commitment.ts';
import { formatAmount, parseAmountToBaseUnits, shortenAddress } from '../lib/format.ts';
import {
  cancelAuctionFlow,
  claimFlow,
  fundBidFlow,
  revealBidFlow,
  settleFlow,
  type FlowProgress,
  type FlowStep,
} from '../lib/flow.ts';
import { openEnvelope } from '../lib/tlock.ts';
import type { AuctionDto, AuctionTiming, BidDto, Windows } from '../lib/types.ts';
import { useWallet } from './WalletProvider.tsx';
import { StepList } from './StepList.tsx';
import { Notice } from './ui.tsx';

export interface AuctionActionsProps {
  readonly auction: AuctionDto;
  readonly timing: AuctionTiming;
  readonly windows: Windows;
  readonly claimable: string | null;
  readonly attested: boolean;
  readonly tokenDecimals: number;
  readonly tokenSymbol: string;
}

/** Shared plumbing for the four flows: one busy flag, one step list, one error slot. */
function useFlow() {
  const [steps, setSteps] = useState<readonly FlowStep[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const onProgress = useCallback((next: readonly FlowStep[]) => setSteps(next), []);

  const run = useCallback(
    async (work: (progress: FlowProgress) => Promise<unknown>) => {
      setBusy(true);
      setError(null);
      try {
        await work(onProgress);
        router.refresh();
      } catch (caught) {
        setError(describe(caught));
      } finally {
        setBusy(false);
      }
    },
    [onProgress, router],
  );

  return { steps, busy, error, setError, onProgress, run };
}

function describe(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.body?.contractErrorName) {
      return `${error.body.contractErrorName} — ${error.body.message}`;
    }
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

export function AuctionActions(props: AuctionActionsProps) {
  const { auction, timing, windows, claimable, attested, tokenDecimals, tokenSymbol } = props;
  const { address, expectedPassphrase, walletPassphrase } = useWallet();

  const [myBid, setMyBid] = useState<BidDto | null>(null);
  const [bidLoaded, setBidLoaded] = useState(false);

  // The relayer knows nothing about who is looking, so the bid lookup happens here,
  // after the wallet is known. Only this address's own bid is ever selected.
  useEffect(() => {
    if (address === null) {
      setMyBid(null);
      setBidLoaded(false);
      return;
    }
    let cancelled = false;
    setBidLoaded(false);
    void (async () => {
      try {
        const result = await api.bids(auction.id);
        if (cancelled) return;
        setMyBid(result.bids.find((bid) => bid.bidder === address) ?? null);
      } catch {
        if (!cancelled) setMyBid(null);
      } finally {
        if (!cancelled) setBidLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [address, auction.id]);

  const isSeller = address !== null && address === auction.seller;
  const passphrase = expectedPassphrase ?? walletPassphrase;

  const panels: React.ReactNode[] = [];

  if (timing.terminal && claimable !== null && BigInt(claimable) > 0n) {
    panels.push(
      <ClaimPanel
        key="claim"
        auction={auction}
        claimable={claimable}
        address={address}
        passphrase={passphrase}
        tokenDecimals={tokenDecimals}
        tokenSymbol={tokenSymbol}
      />,
    );
  }

  if (windows.settlement) {
    panels.push(
      <SettlePanel
        key="settle"
        auction={auction}
        address={address}
        passphrase={passphrase}
      />,
    );
  }

  if (windows.revealAndFunding && myBid && !myBid.revealed) {
    panels.push(
      <RevealPanel
        key="reveal"
        auction={auction}
        address={address as string}
        passphrase={passphrase}
        attested={attested}
        tokenDecimals={tokenDecimals}
        tokenSymbol={tokenSymbol}
      />,
    );
  }

  if (windows.revealAndFunding && myBid?.revealed) {
    panels.push(
      <FundPanel
        key="fund"
        auction={auction}
        bid={myBid}
        address={address as string}
        passphrase={passphrase}
        tokenDecimals={tokenDecimals}
        tokenSymbol={tokenSymbol}
      />,
    );
  }

  if (windows.canCancel && isSeller) {
    panels.push(
      <CancelPanel key="cancel" auction={auction} address={address as string} passphrase={passphrase} />,
    );
  }

  if (panels.length === 0) {
    return (
      <Notice tone="info" title={summaryTitle(props)}>
        {summaryBody(props, { address, bidLoaded, myBid, isSeller })}
      </Notice>
    );
  }

  return <div className="space-y-4">{panels}</div>;
}

// ---------------------------------------------------------------------------
// Reveal
// ---------------------------------------------------------------------------

function RevealPanel({
  auction,
  address,
  passphrase,
  attested,
  tokenDecimals,
  tokenSymbol,
}: {
  auction: AuctionDto;
  address: string;
  passphrase: string | null;
  attested: boolean;
  tokenDecimals: number;
  tokenSymbol: string;
}) {
  const { steps, busy, error, setError, onProgress, run } = useFlow();
  const [mode, setMode] = useState<'auto' | 'backup'>('auto');
  const [backupText, setBackupText] = useState('');

  async function revealFromBulletin() {
    if (passphrase === null) return;
    await run(async (progress) => {
      progress([
        { id: 'fetch', label: 'Fetching your sealed envelope', status: 'active' },
        { id: 'open', label: 'Opening it with the published beacon', status: 'pending' },
        { id: 'reveal', label: 'Revealing to the contract', status: 'pending' },
      ] satisfies FlowStep[]);

      const stored = await api.envelopeFor(auction.id, address);
      progress([
        { id: 'fetch', label: 'Fetching your sealed envelope', status: 'done' },
        { id: 'open', label: 'Opening it with the published beacon', status: 'active' },
        { id: 'reveal', label: 'Revealing to the contract', status: 'pending' },
      ] satisfies FlowStep[]);

      const opened = await openEnvelope(stored.envelope, QUICKNET);
      progress([
        { id: 'fetch', label: 'Fetching your sealed envelope', status: 'done' },
        {
          id: 'open',
          label: 'Opening it with the published beacon',
          status: 'done',
          detail: `${formatAmount(opened.amount, tokenDecimals, { withSymbol: tokenSymbol })}`,
        },
        { id: 'reveal', label: 'Revealing to the contract', status: 'active' },
      ] satisfies FlowStep[]);

      await revealBidFlow({
        auctionId: BigInt(auction.id),
        bidder: address,
        amount: opened.amount,
        salt: opened.salt,
        envelope: stored.envelope,
        networkPassphrase: passphrase,
        onProgress,
      });
    });
  }

  async function revealFromBackup() {
    if (passphrase === null) return;
    let parsed: { auctionId?: unknown; amount?: unknown; salt?: unknown; envelope?: unknown };
    try {
      parsed = JSON.parse(backupText) as typeof parsed;
    } catch {
      setError('that is not valid JSON — paste the whole file you downloaded when you sealed');
      return;
    }

    if (String(parsed.auctionId) !== auction.id) {
      setError(`this backup is for auction ${String(parsed.auctionId)}, not ${auction.id}`);
      return;
    }
    if (
      typeof parsed.amount !== 'string' ||
      typeof parsed.salt !== 'string' ||
      typeof parsed.envelope !== 'string' ||
      !/^\d+$/.test(parsed.amount) ||
      !/^[0-9a-f]{64}$/i.test(parsed.salt)
    ) {
      setError('this backup is missing its amount, salt, or envelope');
      return;
    }

    await run(async (progress) =>
      revealBidFlow({
        auctionId: BigInt(auction.id),
        bidder: address,
        amount: BigInt(parsed.amount as string),
        salt: hexToBytes32(parsed.salt as string, 'salt'),
        envelope: parsed.envelope as string,
        networkPassphrase: passphrase,
        onProgress: progress,
      }),
    );
  }

  return (
    <div className="card space-y-3">
      <div>
        <h3 className="text-sm font-medium text-ash-100">Reveal your bid</h3>
        <p className="mt-1 text-xs text-ash-400">
          The reveal round has published, so your envelope can be opened. Revealing is
          compulsory: the relayer will do it for you, but doing it yourself removes any
          dependency on us. The bond is forfeit if this does not happen before the funding
          deadline.
        </p>
      </div>

      {!attested ? (
        <Notice tone="warn">
          The reveal-round beacon has not been attested on-chain yet. A reveal would fail with
          <span className="font-mono"> BeaconUnavailable</span>. The relayer attests it within
          seconds of publication; check again shortly.
        </Notice>
      ) : null}

      <div className="flex gap-2 text-xs">
        <button
          type="button"
          className={mode === 'auto' ? 'btn-secondary' : 'btn-ghost'}
          onClick={() => setMode('auto')}
        >
          I have no backup
        </button>
        <button
          type="button"
          className={mode === 'backup' ? 'btn-secondary' : 'btn-ghost'}
          onClick={() => setMode('backup')}
        >
          I saved a backup
        </button>
      </div>

      {mode === 'auto' ? (
        <button
          type="button"
          className="btn-primary"
          disabled={busy || passphrase === null || !attested}
          onClick={() => void revealFromBulletin()}
        >
          {busy ? 'Revealing…' : 'Open my envelope and reveal'}
        </button>
      ) : (
        <div className="space-y-2">
          <textarea
            className="input h-24 resize-none"
            placeholder="Paste the contents of subrosa-bid-auction-….json"
            value={backupText}
            onChange={(event) => setBackupText(event.target.value)}
            disabled={busy}
          />
          <button
            type="button"
            className="btn-primary"
            disabled={busy || passphrase === null || backupText.trim() === ''}
            onClick={() => void revealFromBackup()}
          >
            {busy ? 'Revealing…' : 'Reveal from backup'}
          </button>
          <p className="text-xs text-ash-400">
            A backup reveal needs no beacon access at all — the contract only checks the two
            hashes, so this works even if drand and this relayer are both down.
          </p>
        </div>
      )}

      <StepList steps={steps} />
      {error ? <Notice tone="error" title="Reveal failed">{error}</Notice> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Fund
// ---------------------------------------------------------------------------

function FundPanel({
  auction,
  bid,
  address,
  passphrase,
  tokenDecimals,
  tokenSymbol,
}: {
  auction: AuctionDto;
  bid: BidDto;
  address: string;
  passphrase: string | null;
  tokenDecimals: number;
  tokenSymbol: string;
}) {
  const { steps, busy, error, run } = useFlow();
  const shortfall = BigInt(bid.revealedAmount) - BigInt(bid.funded);
  const [amount, setAmount] = useState('');

  const parsed = (() => {
    if (amount.trim() === '') return shortfall;
    try {
      return parseAmountToBaseUnits(amount, tokenDecimals);
    } catch {
      return null;
    }
  })();

  const stillShort = parsed !== null && parsed < shortfall;

  return (
    <div className="card space-y-3">
      <div>
        <h3 className="text-sm font-medium text-ash-100">Back your revealed bid</h3>
        <p className="mt-1 text-xs text-ash-400">
          You revealed{' '}
          <span className="font-mono text-ash-200">
            {formatAmount(bid.revealedAmount, tokenDecimals, { withSymbol: tokenSymbol })}
          </span>
          , so that is what you owe the escrow — the bond you already posted does not count
          towards it. Anything short by the funding deadline means the bond is slashed and paid
          to the seller, and the next bidder up wins instead.
        </p>
      </div>

      <div className="grid grid-cols-3 gap-3 text-xs">
        <div>
          <div className="label">Escrowed</div>
          <div className="value mt-0.5">
            {formatAmount(bid.funded, tokenDecimals, { withSymbol: tokenSymbol })}
          </div>
        </div>
        <div>
          <div className="label">Revealed</div>
          <div className="value mt-0.5">
            {formatAmount(bid.revealedAmount, tokenDecimals, { withSymbol: tokenSymbol })}
          </div>
        </div>
        <div>
          <div className="label">Outstanding</div>
          <div className="value mt-0.5 text-amber2">
            {formatAmount(shortfall, tokenDecimals, { withSymbol: tokenSymbol })}
          </div>
        </div>
      </div>

      <div className="flex gap-2">
        <input
          className="input"
          inputMode="decimal"
          placeholder={formatAmount(shortfall, tokenDecimals)}
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          disabled={busy}
        />
        <button
          type="button"
          className="btn-primary whitespace-nowrap"
          disabled={busy || parsed === null || parsed <= 0n || passphrase === null}
          onClick={() =>
            void run(async (progress) =>
              fundBidFlow({
                auctionId: BigInt(auction.id),
                bidder: address,
                amount: parsed ?? 0n,
                networkPassphrase: passphrase as string,
                onProgress: progress,
              }),
            )
          }
        >
          {busy ? 'Escrowing…' : 'Escrow'}
        </button>
      </div>

      {stillShort ? (
        <Notice tone="warn">
          This is less than the outstanding amount. It is a partial escrow, and the rest is still
          due before the funding deadline.
        </Notice>
      ) : null}

      <StepList steps={steps} />
      {error ? <Notice tone="error" title="Escrow failed">{error}</Notice> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Settle
// ---------------------------------------------------------------------------

function SettlePanel({
  auction,
  address,
  passphrase,
}: {
  auction: AuctionDto;
  address: string | null;
  passphrase: string | null;
}) {
  const { steps, busy, error, run } = useFlow();

  return (
    <div className="card space-y-3">
      <div>
        <h3 className="text-sm font-medium text-ash-100">Release escrow</h3>
        <p className="mt-1 text-xs text-ash-400">
          The funding window has closed. Settlement is permissionless — the outcome is a fixed
          function of on-chain state, so <em>anyone</em> can trigger it and the result is the same.
          The relayer's worker does this automatically; this button exists so you never have to
          wait on it.
        </p>
      </div>

      <button
        type="button"
        className="btn-secondary"
        disabled={busy || address === null || passphrase === null}
        onClick={() =>
          void run(async (progress) =>
            settleFlow({
              auctionId: BigInt(auction.id),
              source: address as string,
              networkPassphrase: passphrase as string,
              onProgress: progress,
            }),
          )
        }
      >
        {busy ? 'Settling…' : 'Settle this auction'}
      </button>

      {address === null ? (
        <p className="text-xs text-ash-400">Connect a wallet to pay the fee for settlement.</p>
      ) : null}

      <StepList steps={steps} />
      {error ? <Notice tone="error" title="Settlement failed">{error}</Notice> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Claim
// ---------------------------------------------------------------------------

function ClaimPanel({
  auction,
  claimable,
  address,
  passphrase,
  tokenDecimals,
  tokenSymbol,
}: {
  auction: AuctionDto;
  claimable: string;
  address: string | null;
  passphrase: string | null;
  tokenDecimals: number;
  tokenSymbol: string;
}) {
  const { steps, busy, error, run } = useFlow();

  return (
    <div className="card space-y-3">
      <div>
        <h3 className="text-sm font-medium text-ash-100">Claim your refund</h3>
        <p className="mt-1 text-xs text-ash-400">
          This auction is over and{' '}
          <span className="font-mono text-reveal-300">
            {formatAmount(claimable, tokenDecimals, { withSymbol: tokenSymbol })}
          </span>{' '}
          is owed to <span className="font-mono">{address ? shortenAddress(address) : 'you'}</span>.
          Refunds are derived on demand from your own bid, which is why settlement never has to
          pay out to every losing bidder at once.
        </p>
      </div>

      <button
        type="button"
        className="btn-primary"
        disabled={busy || address === null || passphrase === null}
        onClick={() =>
          void run(async (progress) =>
            claimFlow({
              auctionId: BigInt(auction.id),
              claimant: address as string,
              networkPassphrase: passphrase as string,
              onProgress: progress,
            }),
          )
        }
      >
        {busy ? 'Claiming…' : `Claim ${formatAmount(claimable, tokenDecimals, { withSymbol: tokenSymbol })}`}
      </button>

      <StepList steps={steps} />
      {error ? <Notice tone="error" title="Claim failed">{error}</Notice> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------

function CancelPanel({
  auction,
  address,
  passphrase,
}: {
  auction: AuctionDto;
  address: string;
  passphrase: string | null;
}) {
  const { steps, busy, error, run } = useFlow();
  const [armed, setArmed] = useState(false);

  const forfeits = auction.sealedCount > 0;

  return (
    <div className="card space-y-3">
      <div>
        <h3 className="text-sm font-medium text-ash-100">Cancel this auction</h3>
        <p className="mt-1 text-xs text-ash-400">
          Only possible while the sealing window is open, and only by you.
          {forfeits ? (
            <>
              {' '}
              <span className="text-amber2">
                There {auction.sealedCount === 1 ? 'is 1 sealed bid' : `are ${auction.sealedCount} sealed bids`},
                so your seller bond is liquidated and split between them as compensation for the
                wasted commitment.
              </span>
            </>
          ) : (
            ' No bids are sealed, so your bond comes straight back.'
          )}
        </p>
      </div>

      {forfeits && !armed ? (
        <button type="button" className="btn-secondary" onClick={() => setArmed(true)}>
          I understand the bond is forfeit
        </button>
      ) : (
        <button
          type="button"
          className="btn-secondary border-wax-500/40 text-wax-300"
          disabled={busy || passphrase === null}
          onClick={() =>
            void run(async (progress) =>
              cancelAuctionFlow({
                auctionId: BigInt(auction.id),
                seller: address,
                networkPassphrase: passphrase as string,
                onProgress: progress,
              }),
            )
          }
        >
          {busy ? 'Cancelling…' : 'Cancel auction'}
        </button>
      )}

      <StepList steps={steps} />
      {error ? <Notice tone="error" title="Cancel failed">{error}</Notice> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Idle copy
// ---------------------------------------------------------------------------

function summaryTitle({ timing, windows }: AuctionActionsProps): string {
  if (timing.terminal) return 'This auction is finished';
  if (windows.sealing) return 'Nothing to do yet';
  if (windows.settlement) return 'Waiting on settlement';
  return 'Nothing to do yet';
}

function summaryBody(
  { auction, timing, windows }: AuctionActionsProps,
  state: { address: string | null; bidLoaded: boolean; myBid: BidDto | null; isSeller: boolean },
): React.ReactNode {
  if (state.address === null) {
    return 'Connect a wallet to see what it can do here. Reads work without a wallet; every action needs a signature.';
  }
  if (!state.bidLoaded) return 'Checking whether you have a sealed bid here…';
  if (timing.terminal) {
    return `The auction ended as ${auction.phase.toLowerCase()}. Nothing is claimable for this address.`;
  }
  if (windows.sealing) {
    return state.isSeller
      ? 'You are the seller. Bids are being sealed and you cannot see them — not even the count of what they are worth. This page updates as they arrive.'
      : 'Bids are still being sealed. Seal one above to take part; once the reveal round publishes you will be able to open every envelope at once.';
  }
  if (state.myBid?.revealed) {
    return 'Your bid is revealed and escrowed in full. Nothing further is required from you.';
  }
  if (state.myBid) {
    return 'Your bid has been revealed. The escrow panel appears when there is an outstanding amount.';
  }
  if (windows.settlement) {
    return 'The funding window has closed and settlement is available to anyone — see the panel above.';
  }
  return state.isSeller
    ? 'Bids are being opened. Once the funding window closes you can release escrow.'
    : 'The reveal window is open. If you do not have a bid here, there is nothing for this address to do.';
}

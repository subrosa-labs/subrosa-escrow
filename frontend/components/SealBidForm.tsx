'use client';

/**
 * Sealing a bid.
 *
 * The plaintext amount typed into this field is encrypted in this tab and never leaves
 * it. What the relayer receives is an age ciphertext it cannot open until drand
 * publishes the reveal round, plus the hashes the contract will compare against.
 *
 * The form is deliberately blunt about two things users get wrong:
 *
 * * the bid cannot be withdrawn or changed, because anyone can open it at the reveal
 *   round — including us;
 * * the backup blob matters, because it is the difference between revealing your bid
 *   yourself and hoping our bulletin holds your envelope.
 */

import { useCallback, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { sealBidFlow, type FlowStep } from '../lib/flow.ts';
import { formatAmount, parseAmountToBaseUnits } from '../lib/format.ts';
import { msUntilRound, roundTime, QUICKNET } from '../lib/drand.ts';
import type { AuctionDto } from '../lib/types.ts';
import { useWallet } from './WalletProvider.tsx';
import { StepList } from './StepList.tsx';
import { Notice } from './ui.tsx';

export interface SealBidFormProps {
  readonly auction: AuctionDto;
  readonly tokenDecimals: number;
  readonly tokenSymbol: string;
  readonly recommendedBond: string;
  readonly minBond: string;
}

interface Backup {
  readonly envelope: string;
  readonly salt: string;
  readonly commitment: string;
  readonly auctionId: string;
}

export function SealBidForm({
  auction,
  tokenDecimals,
  tokenSymbol,
  recommendedBond,
  minBond,
}: SealBidFormProps) {
  const router = useRouter();
  const { address, expectedPassphrase, walletPassphrase } = useWallet();

  const [amount, setAmount] = useState('');
  const [steps, setSteps] = useState<readonly FlowStep[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [backup, setBackup] = useState<Backup | null>(null);

  const passphrase = expectedPassphrase ?? walletPassphrase;
  const opensInMs = msUntilRound(auction.revealRound, QUICKNET);
  const revealRoundLive = opensInMs <= 0;

  const parsed = useMemo(() => {
    if (amount.trim() === '') return null;
    try {
      return parseAmountToBaseUnits(amount, tokenDecimals);
    } catch {
      return null;
    }
  }, [amount, tokenDecimals]);

  const belowReserve = parsed !== null && parsed < BigInt(auction.reservePrice);

  const onProgress = useCallback((next: readonly FlowStep[]) => setSteps(next), []);

  async function seal() {
    if (parsed === null || address === null || passphrase === null) return;

    setBusy(true);
    setError(null);
    setBackup(null);
    try {
      const result = await sealBidFlow({
        auctionId: BigInt(auction.id),
        amount: parsed,
        revealRound: auction.revealRound,
        address,
        networkPassphrase: passphrase,
        sponsor: true,
        onProgress,
      });

      setBackup({
        envelope: result.backup.envelope,
        salt: result.backup.salt,
        commitment: result.backup.commitment,
        auctionId: auction.id,
      });
      setAmount('');
      // The sealed count and the phase may both have moved.
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  if (address === null) {
    return (
      <Notice tone="info" title="Connect a wallet to bid">
        Your bid is encrypted in your browser. There is no account to create and nothing to
        upload — but the seal itself is a signed transaction, so a wallet is required.
      </Notice>
    );
  }

  if (revealRoundLive) {
    return (
      <Notice tone="warn" title="Sealing has closed">
        Round {auction.revealRound} was published at{' '}
        {new Date(roundTime(auction.revealRound, QUICKNET) * 1000).toLocaleString()}. A bid sealed
        now would be readable immediately by anyone, so the contract refuses it and so does the
        UI. Wait for the next auction.
      </Notice>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <label htmlFor="bid-amount" className="label">
          Your bid, sealed to round {auction.revealRound}
        </label>
        <div className="mt-1.5 flex gap-2">
          <input
            id="bid-amount"
            className="input"
            inputMode="decimal"
            placeholder="0.00"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            disabled={busy}
            autoComplete="off"
          />
          <span className="flex items-center px-2 font-mono text-xs text-ash-400">
            {tokenSymbol}
          </span>
        </div>
        <p className="mt-1.5 text-xs text-ash-400">
          Reserve {formatAmount(auction.reservePrice, tokenDecimals, { withSymbol: tokenSymbol })}
          {belowReserve ? (
            <span className="text-amber2">
              {' '}
              — below the reserve. This bid will never win, though it will still be filed.
            </span>
          ) : null}
        </p>
      </div>

      <div className="card-tight space-y-1 text-xs text-ash-400">
        <p>
          <span className="text-ash-200">A bond is escrowed with the bid.</span> Suggested{' '}
          <span className="font-mono text-ash-200">
            {formatAmount(recommendedBond, tokenDecimals, { withSymbol: tokenSymbol })}
          </span>{' '}
          (minimum{' '}
          <span className="font-mono text-ash-200">
            {formatAmount(minBond, tokenDecimals, { withSymbol: tokenSymbol })}
          </span>
          ). The contract sets this, not you.
        </p>
        <p>
          <span className="text-ash-200">Revealing is compulsory.</span> If you do not reveal
          before the reveal deadline, the bond is forfeit and paid to the seller. That is what
          makes a sealed bid binding rather than an option.
        </p>
        <p>
          <span className="text-ash-200">Sealed now, readable in {shortly(opensInMs)}.</span> The
          key is the drand beacon for round {auction.revealRound} — nobody, including this
          service, holds it.
        </p>
      </div>

      <button
        type="button"
        className="btn-primary w-full"
        onClick={() => void seal()}
        disabled={busy || parsed === null || parsed <= 0n || passphrase === null}
      >
        {busy ? 'Sealing…' : 'Seal this bid'}
      </button>

      {passphrase === null ? (
        <Notice tone="warn">
          The relayer is unreachable, so the network this transaction must be signed for is
          unknown. Start the backend (or check its URL) and try again.
        </Notice>
      ) : null}

      <StepList steps={steps} />

      {error ? (
        <Notice tone="error" title="The bid was not sealed">
          {error}
        </Notice>
      ) : null}

      {backup ? <BackupPanel backup={backup} /> : null}
    </div>
  );
}

/**
 * The backup blob.
 *
 * Not a transaction receipt. The ciphertext is the bidder's own copy of what is on-chain,
 * and the salt is the witness the contract checks; with both, a bidder can reveal without
 * our help.
 */
function BackupPanel({ backup }: { backup: Backup }) {
  const router = useRouter();
  const [copied, setCopied] = useState<string | null>(null);

  function download() {
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `subrosa-bid-auction-${backup.auctionId}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function copy(key: string, value: string) {
    await navigator.clipboard.writeText(value);
    setCopied(key);
    setTimeout(() => setCopied(null), 2_000);
  }

  return (
    <Notice tone="ok" title="Sealed. Save this before you close the tab.">
      <p>
        The bid is on-chain and the relayer holds a copy of the envelope, so you can normally just
        press <em>Reveal</em> when the round opens. This file is your fallback if the relayer loses
        it — and the only way to open the bid yourself.
      </p>

      <div className="mt-3 space-y-2">
        {(
          [
            ['commitment', 'commitment (on-chain)', backup.commitment],
            ['salt', 'salt (your witness)', backup.salt],
            ['envelope', 'envelope (age ciphertext)', backup.envelope],
          ] as const
        ).map(([key, label, value]) => (
          <div key={key} className="flex items-center gap-2">
            <span className="w-48 shrink-0 text-xs text-ash-400">{label}</span>
            <code className="min-w-0 flex-1 truncate font-mono text-xs text-ash-200" title={value}>
              {value}
            </code>
            <button type="button" className="btn-ghost px-2 py-1 text-xs" onClick={() => void copy(key, value)}>
              {copied === key ? 'copied' : 'copy'}
            </button>
          </div>
        ))}
      </div>

      <div className="mt-3 flex gap-2">
        <button type="button" className="btn-secondary text-xs" onClick={download}>
          Download backup
        </button>
        <button type="button" className="btn-ghost text-xs" onClick={() => router.refresh()}>
          Refresh auction
        </button>
      </div>
    </Notice>
  );
}

function shortly(ms: number): string {
  if (ms <= 0) return 'now';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`;
  return `${Math.round(hours / 24)} days`;
}

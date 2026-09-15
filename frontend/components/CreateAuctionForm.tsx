'use client';

/**
 * Creating an auction.
 *
 * Windows are entered in ledgers because that is the unit the contract enforces, but each
 * field also shows what it works out to in wall-clock time at the assumed ledger close.
 * That assumption is a display convenience only — the contract protects sealing with the
 * drand round, not with a timestamp, so a wrong estimate shifts the reveal round rather
 * than opening a hole.
 */

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createAuctionFlow, type FlowStep } from '../lib/flow.ts';
import { formatAmount, parseAmountToBaseUnits } from '../lib/format.ts';
import type { ConfigDto } from '../lib/types.ts';
import { useWallet } from './WalletProvider.tsx';
import { StepList } from './StepList.tsx';
import { Notice } from './ui.tsx';

export interface CreateAuctionFormProps {
  readonly config: ConfigDto;
  readonly tokenSymbol: string;
}

const DEFAULT_WINDOWS = {
  commitWindowLedgers: 3_456, // ~4.8h at 5s per ledger
  revealWindowLedgers: 1_728, // ~2.4h
  fundingWindowLedgers: 1_728,
};

export function CreateAuctionForm({ config, tokenSymbol }: CreateAuctionFormProps) {
  const router = useRouter();
  const { address, expectedPassphrase, walletPassphrase } = useWallet();

  const [reserve, setReserve] = useState('');
  const [bond, setBond] = useState(formatAmount(config.minBond, config.tokenDecimals));
  const [sellerBond, setSellerBond] = useState(
    formatAmount(config.minBond, config.tokenDecimals),
  );
  const [windows, setWindows] = useState(DEFAULT_WINDOWS);
  const [steps, setSteps] = useState<readonly FlowStep[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const passphrase = expectedPassphrase ?? walletPassphrase;

  const parsed = useMemo(() => {
    function parse(value: string) {
      try {
        return parseAmountToBaseUnits(value, config.tokenDecimals);
      } catch {
        return null;
      }
    }
    return { reserve: parse(reserve), bond: parse(bond), sellerBond: parse(sellerBond) };
  }, [reserve, bond, sellerBond, config.tokenDecimals]);

  const problems = useMemo(() => {
    const found: string[] = [];
    if (parsed.reserve === null || parsed.reserve <= 0n) found.push('enter a positive reserve price');
    if (parsed.bond === null || parsed.bond < BigInt(config.minBond)) {
      found.push(
        `the bid bond must be at least ${formatAmount(config.minBond, config.tokenDecimals, {
          withSymbol: tokenSymbol,
        })}`,
      );
    }
    if (parsed.sellerBond === null || parsed.sellerBond <= 0n) {
      found.push('enter a positive seller bond');
    }
    if (windows.commitWindowLedgers < config.minRevealLeadLedgers) {
      found.push(
        `the sealing window must run for at least ${config.minRevealLeadLedgers} ledgers so the reveal round can be pinned safely ahead of it`,
      );
    }
    if (windows.revealWindowLedgers < 1 || windows.fundingWindowLedgers < 1) {
      found.push('the reveal and funding windows must both be at least one ledger');
    }
    return found;
  }, [parsed, windows, config.minBond, config.minRevealLeadLedgers, config.tokenDecimals, tokenSymbol]);

  async function create() {
    if (
      address === null ||
      passphrase === null ||
      parsed.reserve === null ||
      parsed.bond === null ||
      parsed.sellerBond === null
    ) {
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await createAuctionFlow({
        seller: address,
        reservePrice: parsed.reserve,
        bond: parsed.bond,
        sellerBond: parsed.sellerBond,
        commitWindowLedgers: windows.commitWindowLedgers,
        revealWindowLedgers: windows.revealWindowLedgers,
        fundingWindowLedgers: windows.fundingWindowLedgers,
        networkPassphrase: passphrase,
        onProgress: (next) => setSteps(next),
      });
      router.push('/auctions');
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="card space-y-4">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field
            label="Reserve price"
            hint="The lowest bid that can win. Below it, the auction fails and every bid is refundable."
          >
            <div className="flex items-center gap-2">
              <input
                className="input"
                inputMode="decimal"
                placeholder="0.00"
                value={reserve}
                onChange={(event) => setReserve(event.target.value)}
                disabled={busy}
              />
              <span className="font-mono text-xs text-ash-400">{tokenSymbol}</span>
            </div>
          </Field>

          <Field
            label="Bid bond"
            hint="Flat, escrowed by every bidder at seal time and slashed if they never fund what they revealed."
          >
            <div className="flex items-center gap-2">
              <input
                className="input"
                inputMode="decimal"
                value={bond}
                onChange={(event) => setBond(event.target.value)}
                disabled={busy}
              />
              <span className="font-mono text-xs text-ash-400">{tokenSymbol}</span>
            </div>
          </Field>

          <Field
            label="Your bond"
            hint="Forfeited in full to the sealed bidders if you cancel once bids exist. Your commitment, not a fee."
          >
            <div className="flex items-center gap-2">
              <input
                className="input"
                inputMode="decimal"
                value={sellerBond}
                onChange={(event) => setSellerBond(event.target.value)}
                disabled={busy}
              />
              <span className="font-mono text-xs text-ash-400">{tokenSymbol}</span>
            </div>
          </Field>
        </div>
      </div>

      <div className="card space-y-4">
        <h3 className="text-sm font-medium text-ash-100">Windows</h3>
        <p className="text-xs text-ash-400">
          The sealing window sets the reveal round: the contract computes it from the estimated
          close of the commit deadline plus {config.marginRounds} spare drand round
          {config.marginRounds === 1 ? '' : 's'} at {config.drandPeriod}s each. Those margins are
          what guarantee the beacon cannot exist while bids are still being accepted.
        </p>

        <div className="grid gap-4 sm:grid-cols-3">
          <WindowField
            label="Sealing"
            value={windows.commitWindowLedgers}
            onChange={(commitWindowLedgers) => setWindows((w) => ({ ...w, commitWindowLedgers }))}
            ledgerSeconds={config.assumedLedgerSeconds}
            disabled={busy}
            minimum={config.minRevealLeadLedgers}
          />
          <WindowField
            label="Reveal"
            value={windows.revealWindowLedgers}
            onChange={(revealWindowLedgers) => setWindows((w) => ({ ...w, revealWindowLedgers }))}
            ledgerSeconds={config.assumedLedgerSeconds}
            disabled={busy}
            minimum={1}
          />
          <WindowField
            label="Funding"
            value={windows.fundingWindowLedgers}
            onChange={(fundingWindowLedgers) => setWindows((w) => ({ ...w, fundingWindowLedgers }))}
            ledgerSeconds={config.assumedLedgerSeconds}
            disabled={busy}
            minimum={1}
          />
        </div>
      </div>

      {problems.length > 0 ? (
        <Notice tone="warn" title="Check these before creating">
          <ul className="list-inside list-disc space-y-1">
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </Notice>
      ) : null}

      <button
        type="button"
        className="btn-primary"
        disabled={busy || problems.length > 0 || address === null || passphrase === null}
        onClick={() => void create()}
      >
        {busy ? 'Creating…' : 'Create auction'}
      </button>

      {address === null ? (
        <Notice tone="info">
          Connect a wallet. The seller bond is transferred on creation, so a signature is required
          either way.
        </Notice>
      ) : null}

      <StepList steps={steps} />
      {error ? <Notice tone="error" title="Auction not created">{error}</Notice> : null}
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <span className="label">{label}</span>
      <div className="mt-1.5">{children}</div>
      {hint ? <p className="mt-1.5 text-xs text-ash-400">{hint}</p> : null}
    </div>
  );
}

function WindowField({
  label,
  value,
  onChange,
  ledgerSeconds,
  disabled,
  minimum,
}: {
  label: string;
  value: number;
  onChange: (next: number) => void;
  ledgerSeconds: number;
  disabled: boolean;
  minimum: number;
}) {
  const seconds = value * ledgerSeconds;
  return (
    <div>
      <span className="label">{label}</span>
      <div className="mt-1.5 flex items-center gap-2">
        <input
          className="input"
          inputMode="numeric"
          value={value}
          onChange={(event) => {
            const next = Number.parseInt(event.target.value.replace(/[^0-9]/g, ''), 10);
            onChange(Number.isNaN(next) ? 0 : next);
          }}
          disabled={disabled}
        />
        <span className="whitespace-nowrap font-mono text-xs text-ash-400">ledgers</span>
      </div>
      <p className="mt-1.5 text-xs text-ash-400">
        ≈ {humanise(seconds)}
        {value < minimum ? <span className="text-amber2"> — minimum is {minimum}</span> : null}
      </p>
    </div>
  );
}

function humanise(seconds: number): string {
  if (seconds <= 0) return '0';
  const hours = seconds / 3_600;
  if (hours >= 48) return `${(hours / 24).toFixed(1)} days`;
  if (hours >= 2) return `${hours.toFixed(1)} hours`;
  return `${Math.round(seconds / 60)} minutes`;
}

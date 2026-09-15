import { api } from '../../lib/api.ts';
import { SETTLEMENT_SYMBOL } from '../../lib/format.ts';
import { CreateAuctionForm } from '../../components/CreateAuctionForm.tsx';
import { NetworkWarning } from '../../components/WalletButton.tsx';
import { Notice } from '../../components/ui.tsx';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Create an auction' };

export default async function CreatePage() {
  const config = await api.config().catch(() => null);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-medium text-ash-100">Create an auction</h1>
        <p className="mt-1 max-w-3xl text-sm text-ash-400">
          You set the terms once: a reserve, a flat bond every bidder posts at seal time, and your
          own bond which is what makes cancelling expensive. Bidders see the terms and nothing else
          — not each other&rsquo;s amounts, not the count of what has been bid.
        </p>
      </div>

      <NetworkWarning />

      {config === null ? (
        <Notice tone="warn" title="Cannot read the contract configuration">
          The relayer could not reach the contract, so the bond floor, minimum window lengths and
          ledger assumptions are unknown. Creating an auction with guessed values would be rejected
          on-chain; fix the relayer first.
        </Notice>
      ) : config.paused ? (
        <Notice tone="error" title="The contract is paused">
          All writes will fail until an admin unpauses it.
        </Notice>
      ) : (
        <CreateAuctionForm config={config} tokenSymbol={SETTLEMENT_SYMBOL} />
      )}

      <section className="card space-y-2 text-xs text-ash-400">
        <h2 className="text-sm font-medium uppercase tracking-wider text-ash-400">
          What happens after you create it
        </h2>
        <ol className="list-inside list-decimal space-y-1">
          <li>
            Your seller bond is transferred into escrow immediately, and the contract computes{' '}
            <span className="font-mono">reveal_round</span> from the estimated close of the sealing
            window plus a safety margin.
          </li>
          <li>
            Bidders seal envelopes. Each also escrows a flat bond, so the bond size is public while
            the bid is not.
          </li>
          <li>
            The drand round publishes, every relayer BLS-verifies it, a quorum signs an attestation,
            and the beacon lands on-chain. From that instant every envelope is openable by anyone.
          </li>
          <li>
            Revealed bids escrow the full amount they named inside a funding window. Anything short
            is slashed and the bond goes to you, so you are compensated for the wasted auction.
          </li>
          <li>
            Settlement is permissionless: the highest fully-escrowed bid wins, escrow is released to
            you minus the protocol fee, and every other bidder derives their refund from their own
            bid when they claim.
          </li>
        </ol>
      </section>
    </div>
  );
}

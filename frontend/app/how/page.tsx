import { api } from '../../lib/api.ts';
import { QUICKNET } from '../../lib/drand.ts';
import { Hash, Notice, Stat } from '../../components/ui.tsx';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'How it works' };

const PREIMAGE = `commitment = sha256(
    "subrosa.bid.v1"      // 14 bytes, ASCII domain separator
 || auction_id            // u64,  big-endian
 || amount                // i128, big-endian
 || salt                  // 32 bytes, random
)`;

const BEACON_DIGEST = `digest = sha256(
    "subrosa.beacon.v1"   // 17 bytes
 || chain_hash            // 32 bytes
 || round                 // u64, big-endian
 || randomness            // 32 bytes
 || auction_id            // u64, big-endian
)`;

export default async function HowPage() {
  const drand = await api.drandInfo().catch(() => null);

  return (
    <article className="max-w-3xl space-y-10">
      <header className="space-y-3">
        <h1 className="text-2xl font-medium text-ash-100">How it works</h1>
        <p className="text-ash-300">
          A commit-reveal auction with a public ledger solves half the problem: the bid is hidden
          while it is being placed. It leaves the other half open, because the bidder chooses
          whether to reveal. A bidder who learns they have lost simply never opens their envelope —
          which makes their bid non-binding at exactly the moment it starts to matter.
        </p>
        <p className="text-ash-300">
          SubRosa removes the choice. A bid is encrypted to a drand round that does not exist yet,
          and the decryption key is a threshold signature that becomes public to everyone at the
          same instant. There is no window in which a bidder holds the key and nobody else does, so
          anyone — the bidder, our relayer, or a stranger reading the chain — can complete the
          reveal.
        </p>
      </header>

      <Section title="The seal">
        <p>
          Sealing happens in the browser, in{' '}
          <span className="font-mono">frontend/lib/tlock.ts</span>. The plaintext payload is a small
          JSON object — auction id, amount, salt, commitment, reveal round, chain — encrypted with{' '}
          <span className="font-mono">tlock</span> and armour-encoded. What leaves the tab is:
        </p>
        <ul className="list-inside list-disc space-y-1">
          <li>
            the ciphertext, which is also anchored on-chain by its hash so it cannot be swapped;
          </li>
          <li>the commitment, a 32-byte hash of the amount, salt and auction id;</li>
          <li>the bidder&rsquo;s address, an escrowed bond, and a signature.</li>
        </ul>
        <p>
          The relayer never accepts an amount, so it cannot leak one. The bidder&rsquo;s address is
          deliberately not part of the commitment preimage: a bid is filed under whichever address
          signed the seal, and a reveal looks the bid up by that address, so a third party who
          learns an opening can only ever do the bidder a favour.
        </p>
        <Code>{PREIMAGE}</Code>
      </Section>

      <Section title="The reveal">
        <p>
          The contract computes each auction&rsquo;s reveal round when it is created, from the
          estimated close of the sealing window plus a margin of spare drand rounds. Because drand
          is unchained, rounds are pure arithmetic:
        </p>
        <Code>{`round = floor((t - genesis) / period) + 1`}</Code>
        <p>
          A bidder cannot reveal before the commit deadline, and — more to the point — they cannot
          reveal early even if they wanted to, because the key has not been produced. This is the
          property a hash-based commit-reveal cannot give you, and it is what makes the sealing
          window trustworthy.
        </p>
        <p>
          Once the round publishes, the relayer verifies the BLS signature against quicknet&rsquo;s
          pinned public key and then opens{' '}
          <em>every</em> envelope it holds, submitting the openings in a batch. Revealing is
          permissionless on-chain, so this is a convenience, not a privilege: any observer can do
          the same, and the bidder can always do it themselves from the backup file they saved.
        </p>
      </Section>

      <Section title="The beacon, and the trust it needs">
        <p>
          Soroban exposes no BN254 pairing function, so the contract cannot check drand&rsquo;s BLS
          signature itself. Rather than hide that, the protocol names the assumption and narrows it:
          registered relayers each verify the signature off-chain and sign an ed25519 digest that
          binds the chain, round, randomness and auction id. The contract checks the quorum once per
          auction, in <span className="font-mono">attest_beacon</span>, and every later reveal just
          reads the recorded beacon.
        </p>
        <Code>{BEACON_DIGEST}</Code>
        <p>
          Binding <span className="font-mono">auction_id</span> means an attestation gathered for one
          auction cannot be replayed into another. Binding{' '}
          <span className="font-mono">chain_hash</span> means an attestation from a different drand
          network is rejected — and the chain hash is pinned in the contract at initialisation, not
          supplied per call.
        </p>
        <Notice tone="warn" title="What is not proven on-chain">
          A quorum of relayers is trusted to have verified the BLS signature honestly. A colluding
          quorum could invent a randomness value. Crucially it still could not decrypt anything
          early — inventing a beacon for a future round does not produce the round&rsquo;s key — so
          the failure mode is a disputed outcome, not a privacy break. A future version can replace
          the quorum with an on-chain pairing check when Soroban exposes one.
        </Notice>
      </Section>

      <Section title="Bonds, and why the funding window exists">
        <p>
          A sealed bid cannot commit to escrowing an amount nobody is allowed to see, so the bond is
          a flat number the bidder posts with the seal. That leaves a gap: a bidder could reveal the
          largest number in the room and then decline to escrow it. The funding window closes the
          gap. Revealing is a binding commitment to be able to pay, and anything not escrowed by the
          funding deadline is treated as unbacked: the bond is slashed to the seller and the next
          highest fully-escrowed bid wins.
        </p>
        <p>
          The seller posts a bond too. Cancelling while bids are sealed does not return it — it is
          split between the sealed bidders, at{' '}
          <span className="font-mono">seller_bond / sealed_count</span> each. A seller who might
          otherwise abandon an auction whose outcome they dislike has to pay for the privilege.
        </p>
      </Section>

      <Section title="Settlement is bounded on purpose">
        <p>
          Soroban meters every ledger entry a transaction touches, so a design that writes one
          refund per losing bidder breaks quietly at scale. Settlement here is one bounded read pass
          and three writes: it scans at most{' '}
          <span className="font-mono">max_bids</span> already-revealed bids to find the hammer price
          and total the slashed bonds, credits the seller and treasury through a claim ledger, and
          stops. Losing bidders&rsquo; refunds are derived on demand in{' '}
          <span className="font-mono">claim</span> from their own bid and the auction&rsquo;s
          terminal state, so each claimant pays only for their own entry.
        </p>
        <p>
          Settlement itself is permissionless. The winner is a deterministic function of state, so
          it does not matter who pays the fee — a stalled relayer cannot strand anyone&rsquo;s
          money, and the UI offers the button to every connected wallet.
        </p>
      </Section>

      <Section title="What an observer sees">
        <div className="grid gap-4 sm:grid-cols-2">
          <Stat label="Always visible" value="auction terms, bond sizes, bidder addresses, timings" mono={false} />
          <Stat label="Visible after the reveal round" value="amounts, the winner, the hammer price" mono={false} />
        </div>
        <p className="mt-3">
          Before the commit deadline the sealed count is public — the number of envelopes, not
          what is inside them. That is a deliberate tradeoff: hiding the count would mean hiding the
          on-chain bid entries themselves, which this contract does not attempt. What it does
          guarantee is that no amount is knowable, by anyone, until the beacon publishes.
        </p>
      </Section>

      <Section title="The drand parameters in use">
        {drand === null ? (
          <Notice tone="warn">
            The relayer is unreachable, so live beacon parameters cannot be shown. The values below
            are the ones this build is compiled against.
          </Notice>
        ) : null}
        <div className="grid gap-4 sm:grid-cols-3">
          <Stat label="Beacon" value={drand?.beaconId ?? QUICKNET.beaconId} />
          <Stat label="Round period" value={`${drand?.periodSeconds ?? QUICKNET.periodSeconds}s`} />
          <Stat label="Latest round" value={drand?.latestRound ?? '—'} />
        </div>
        <p className="mt-3">
          Chain hash <Hash value={drand?.chainHash ?? QUICKNET.chainHash} chars={12} /> — pinned in
          the contract at initialisation, mirrored in the relayer and in the browser, and pinned
          again by a golden-vector test on each side. All three copies must agree; a mismatch is a
          build failure, not a runtime surprise.
        </p>
      </Section>
    </article>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-medium text-ash-100">{title}</h2>
      <div className="space-y-3 text-sm leading-relaxed text-ash-300">{children}</div>
    </section>
  );
}

function Code({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-lg border border-ink-700 bg-ink-900 p-4 font-mono text-xs leading-relaxed text-ash-200">
      {children}
    </pre>
  );
}

# Deployment runbook

Testnet first, always. Every step below is written so that the same commands work on mainnet
with the network name changed, and the two places where mainnet is genuinely different are
called out and gated.

---

## 0. Prerequisites

| Tool | Version | Needed for |
| --- | --- | --- |
| Node | ≥ 22.7.0 | Backend and frontend. The backend runs TypeScript directly via `--experimental-transform-types`, which landed in 22.7.0. |
| Rust | ≥ 1.81.0, with `wasm32-unknown-unknown` | Building the contract |
| Stellar CLI | ≥ 22.1.0 | Deploying and invoking the contract |
| Postgres | ≥ 14 | Production persistence. Optional in development. |

```bash
rustup target add wasm32-unknown-unknown
cargo install --locked stellar-cli --version 22.1.0   # provides `stellar`
```

Before deploying anything, confirm the offline suite passes. It catches an encoder drift that
would otherwise only surface as a rejected reveal, hours later, with money already escrowed.

```bash
npm install
make -C contracts test
npm test
npm run test --workspace frontend
npm run typecheck
npm run build --workspace frontend
```

---

## 1. Relayer keys (do this before deploying the contract)

The contract pins the relayer public keys at initialisation, so they have to exist first.

**The quorum is the one place this system trusts a set of parties.** Generate each key on the
machine that will use it, and never let one operator hold `>= threshold` keys. The backend
enforces this on mainnet (`config.ts` refuses to start with more than one key when
`NODE_ENV=production` and the worker is enabled), and the deploy script refuses to invent keys
outside testnet.

On each operator's machine:

```bash
node -e '
  const { generateKeyPairSync } = require("node:crypto");
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  // A raw ed25519 public key is the trailing 32 bytes of the SPKI DER encoding, and a raw
  // seed is the trailing 32 bytes of the PKCS8 encoding. Both are fixed-length for ed25519.
  const pub = publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("hex");
  const seed = privateKey.export({ type: "pkcs8", format: "der" }).subarray(-32);
  console.log("public (share this):", pub);
  // The Stellar CLI can turn the raw seed into a strkey S... secret. See below.
  require("node:fs").writeFileSync("relayer-seed.hex", seed.toString("hex"), { mode: 0o600 });
'
```

Collect the public keys from every operator and join them with commas:

```bash
export SUBROSA_RELAYER_PUBKEYS="<hex>,<hex>,<hex>"
export SUBROSA_RELAYER_THRESHOLD=2     # M of N
```

On testnet only, leaving `SUBROSA_RELAYER_PUBKEYS` unset makes the deploy script generate three
throwaway keys and write them to `.tmp/deploy/relayer-keys.json` (mode `0600`). Convenient, and
explicitly not acceptable for production.

Convert each operator's seed into the `S...` strkey the backend expects:

```bash
node -e '
  const { Keypair } = require("@stellar/stellar-sdk");
  const seed = Buffer.from(require("node:fs").readFileSync("relayer-seed.hex", "utf8").trim(), "hex");
  console.log(Keypair.fromRawEd25519Seed(seed).secret());
'
```

That value is the relayer's ed25519 identity — the same key that signs beacon attestations and
pays its own transaction fees.

---

## 2. Build and deploy the contract

```bash
# Testnet, with throwaway relayers:
make -C contracts deploy-testnet

# Testnet, with real relayers:
NETWORK=testnet SUBROSA_RELAYER_PUBKEYS="$SUBROSA_RELAYER_PUBKEYS" \
  SUBROSA_RELAYER_THRESHOLD=2 make -C contracts deploy

# Mainnet:
CONFIRM_MAINNET_DEPLOY=yes NETWORK=mainnet SUBROSA_RELAYER_PUBKEYS="$SUBROSA_RELAYER_PUBKEYS" \
  SUBROSA_RELAYER_THRESHOLD=2 make -C contracts deploy-mainnet
```

What the script does, in order:

1. builds the wasm, optionally shrinks it with `stellar contract optimize`, and records its
   sha256;
2. resolves or creates the deployer identity, and the admin / treasury / settlement token
   defaults for the chosen network;
3. uploads the wasm and deploys the contract instance;
4. invokes `initialize` with the pinned drand parameters (`quicknet`, genesis `1692803367`,
   period `3s`), `fee_bps`, relayer quorum, `assumed_ledger_seconds 5`, `margin_rounds 20`,
   `max_bids 64`, `min_bond 1000000`, `min_reveal_lead_ledgers 20`;
5. smoke-tests with `schema_version`;
6. writes `.tmp/deploy/<network>.json` and folds it into `FUNDING.json` via
   `scripts/sync-funding.mjs`.

**Settlement token.** Testnet defaults to the native XLM SAC
(`CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC`) because it needs no trustline, so
an end-to-end run can airdrop and go. To settle in testnet USDC instead:

```bash
SUBROSA_SETTLEMENT_TOKEN=CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA \
  SUBROSA_RELAYER_PUBKEYS="$SUBROSA_RELAYER_PUBKEYS" make -C contracts deploy-testnet
```

Those SAC addresses are derived, not guessed, and can be re-derived from the issuer:

```bash
node -e '
  const { Asset, Networks } = require("@stellar/stellar-sdk");
  console.log("XLM ", Asset.native().contractId(Networks.TESTNET));
  console.log("USDC", new Asset("USDC", "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5")
                              .contractId(Networks.TESTNET));
'
```

**Token decimals.** The script passes `--token_decimals 7`, which is correct for XLM and for
Circle's USDC on Stellar. If you settle in an asset with different precision, pass the right
value — the contract uses it only for off-chain display and bond-floor sanity checks, but a
wrong value makes the UI lie about amounts.

Note the deploy is gated twice: mainnet needs `CONFIRM_MAINNET_DEPLOY=yes`, and any non-testnet
network needs `SUBROSA_RELAYER_PUBKEYS` supplied explicitly.

---

## 3. Configure and start the backend

```bash
cp backend/.env.example backend/.env
```

Fill in at minimum:

```ini
SUBROSA_CONTRACT_ID=<from the deploy output>
RELAYER_SECRET_KEYS=<S... from step 1>
STELLAR_NETWORK=testnet
CORS_ORIGINS=https://your-frontend.example
DATABASE_URL=postgres://user:pass@host:5432/subrosa
ADMIN_TOKEN=<a long random string, or leave unset for a public deployment>
```

Nothing loads `.env` automatically. Either export it (`set -a; . backend/.env; set +a`) or pass
it to Node explicitly.

Apply the schema:

```bash
npm run migrate --workspace backend
```

Start it:

```bash
npm run build --workspace backend && npm start --workspace backend
# or, in development:
node --env-file=backend/.env --experimental-transform-types backend/src/index.ts
```

**Read the preflight output.** The service checks, and keeps reporting through `/healthz`:

* Soroban RPC reachable;
* the contract answers `schema_version` with a version this build understands;
* the store is healthy;
* the relayer's own key set can actually satisfy the on-chain quorum (right keys, enough of
  them, matching chain hash).

```bash
curl -s localhost:8080/healthz | jq
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" -X POST localhost:8080/v1/admin/selfcheck | jq
```

A relayer whose keys are not in the on-chain set will run, look fine, and fail every attestation
with `AttestationInvalid` hours later. The self-check exists to catch exactly that, and
`npm run worker` refuses to start at all when preflight fails rather than burning fees.

---

## 4. Split the worker out (optional)

By default one process serves the API and runs the relayer loop. Split them when the API needs
to scale horizontally:

```ini
WORKER_ENABLED=false      # on the API instances
```

```bash
npm run worker --workspace backend
```

Job leases (`JOB_LEASE_MS`) make multiple workers safe: a claimed job is invisible to the
others, and a lapsed lease returns it to the pool.

---

## 5. Deploy the frontend

```bash
cp frontend/.env.example frontend/.env.local
# NEXT_PUBLIC_SUBROSA_API_URL=https://api.your-domain.example
# NEXT_PUBLIC_SETTLEMENT_SYMBOL=USDC

npm run build --workspace frontend
npm start --workspace frontend       # or deploy the workspace to your host
```

The URL must be reachable *from the browser*, and the relayer's `CORS_ORIGINS` must list the
frontend's origin. Everything else — reads, the seal flow's hash upload, transaction assembly —
goes through that one URL.

---

## 6. Post-deploy verification

```bash
# 1. The beacon itself, independently of any SubRosa infrastructure.
npm run drand:verify --workspace backend -- --round <recent round>

# 2. The full lifecycle against the live deployment: seal, wait for the real drand round,
#    reveal, fund, settle, claim.
npm run e2e --workspace backend

# 3. Seal/decrypt round trip in isolation, against live quicknet.
npm run drand:selftest --workspace backend
```

Then walk the UI once with a real wallet, in this order, because each step depends on the
previous one having actually happened on-chain:

1. create an auction with a short sealing window;
2. seal a bid from a second account — confirm the relayer stores a ciphertext it cannot read
   (`GET /v1/auctions/:id/envelopes`);
3. wait for the reveal round. Confirm the attestation appears
   (`GET /v1/auctions/:id/attestation`) and that the amount becomes visible at the same moment
   the beacon publishes, not before;
4. escrow the revealed amount, settle, and claim the refund from the losing account.

If step 3 shows an amount *before* the round's publish time, stop and treat it as a
vulnerability rather than a bug — that is the single property the whole design exists to
provide.

---

## 7. Operating

**What to watch**

| Signal | Why |
| --- | --- |
| `/healthz` — `preflight`, `rpc`, `store` | The whole relay path in one call. |
| `/v1/auctions/:id/activity` — job statuses and `lastError` | A job stuck in `failed` means an auction will not settle itself. |
| Job attempts climbing | Usually a submission error: out of fee balance, or a key that is not in the on-chain quorum. |
| Relayer account XLM balance | The relayer pays its own fees, and sponsors user transactions. Running dry stalls reveals. |

**Manual override.** When the worker is wedged, the admin routes let a human drive the same
machinery:

```bash
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" localhost:8080/v1/admin/observe
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" localhost:8080/v1/admin/advance/42
```

`advance` chooses `attest`, `reveal`, or `settle` from current chain state — it does not force a
phase. The UI's settle button does the same thing permissionlessly, so a stuck queue is never a
reason funds are inaccessible.

**Incidents**

| Symptom | Likely cause | Action |
| --- | --- | --- |
| Attestations fail with `AttestationInvalid` | Relayer keys are not in the on-chain set, or the chain hash differs | `POST /v1/admin/selfcheck`; rotate with `set_relayers` if the key set genuinely changed |
| Attestation fails with a BLS error | drand unreachable or the beacon is not published yet | Nothing to do — the job defers and retries |
| Reveals fail with `BeaconUnavailable` | The attestation has not landed yet | Wait; the orchestrator orders attest before reveal |
| Reveals fail with `EnvelopeHashMismatch` | The stored ciphertext is not the one committed | The bidder's backup reveals it; investigate the bulletin write path |
| Reveals fail with `CommitmentMismatch` | Encoder drift between client and contract | Treat as a release blocker. `npm test` should have caught it; check the deployed contract's `hash_commitment` against the client |
| Settlement never fires | Relayer out of XLM, or the worker is disabled | Fund the account, or settle manually — it is permissionless |

---

## 8. Mainnet checklist

- [ ] `SUBROSA_RELAYER_PUBKEYS` held by independent operators, `M ≥ 2`, no operator holding ≥ M keys
- [ ] `SUBROSA_SETTLEMENT_TOKEN` re-derived locally and confirmed against a block explorer
- [ ] `SUBROSA_TREASURY` is a multisig or the protocol's own account, not a personal key
- [ ] `ADMIN_TOKEN` set to a long random value, or the admin routes left unregistered
- [ ] `DATABASE_URL` pointing at a backed-up Postgres, with connection limits sized to the worker count
- [ ] `CORS_ORIGINS` listing exact production origins, not `*`
- [ ] `NODE_ENV=production` (this is also what enforces the one-key-per-operator rule)
- [ ] `FUNDING.json` synced, and the wasm sha256 in it matches the deployed bytecode
- [ ] The offline suite and `npm run e2e` both green against mainnet
- [ ] An incident runbook that names who can call `pause` and who holds each relayer key

---

## 9. Upgrading

The contract has no in-place upgrade: a new wasm means a new contract id, and a new contract id
means the pinned `Config` (chain hash, relayer quorum, fee) is set fresh. Treat it as a
migration:

1. deploy the new contract alongside the old one and initialise it;
2. point a second backend instance at the new id (`SUBROSA_CONTRACT_ID`) and verify preflight;
3. let in-flight auctions on the old contract finish — settlement and claims are permissionless,
   so they complete without any relayer at all;
4. swing the frontend's API URL over;
5. run `scripts/sync-funding.mjs` with the new artifact so `FUNDING.json` names the live
   bytecode.

The relayer refuses to start against a contract whose `SCHEMA_VERSION` it does not expect, which
is what stops this from being done half-way by accident.

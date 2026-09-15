#!/usr/bin/env bash
#
# Deploy + initialise SubRosa Escrow, then record the resulting addresses and
# wasm hash in FUNDING.json.
#
#   NETWORK=testnet IDENTITY=subrosa-deployer ./scripts/deploy.sh
#
# Environment:
#   NETWORK                     testnet | mainnet | futurenet   (default: testnet)
#   IDENTITY                    stellar CLI identity name       (default: subrosa-deployer)
#   SUBROSA_ADMIN               address that administers the protocol (default: identity)
#   SUBROSA_TREASURY            address that receives fees        (default: admin)
#   SUBROSA_SETTLEMENT_TOKEN    SAC address of the escrow asset  (default: network USDC)
#   SUBROSA_RELAYER_PUBKEYS     comma-separated 64-char hex ed25519 relayer keys (default: 3 generated dev keys)
#   SUBROSA_RELAYER_THRESHOLD   M-of-N quorum size               (default: 2)
#   SUBROSA_FEE_BPS             protocol fee in bps              (default: 100)
#
# This script performs real, irreversible network writes. It refuses to target
# mainnet unless CONFIRM_MAINNET_DEPLOY=yes is set.

set -euo pipefail

NETWORK="${NETWORK:-testnet}"
IDENTITY="${IDENTITY:-subrosa-deployer}"
FEE_BPS="${SUBROSA_FEE_BPS:-100}"
RELAYER_THRESHOLD="${SUBROSA_RELAYER_THRESHOLD:-2}"

# drand quicknet — pinned in the contract at initialise time.
DRAND_CHAIN_HASH="52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971"
DRAND_GENESIS=1692803367
DRAND_PERIOD=3

# Settlement assets, as Soroban Asset Contract (SAC) addresses.
#
# Native XLM's SAC: needs no trustline and no issuer cooperation, which is why it is
# the testnet default — the end-to-end script can airdrop XLM and be running in
# seconds. Derived with `Asset.native().contractId(passphrase)`.
XLM_SAC_TESTNET="CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"
XLM_SAC_MAINNET="CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA"
# Circle USDC (issuer GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN).
USDC_SAC_MAINNET="CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75"
USDC_SAC_TESTNET="CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONTRACTS_DIR="$ROOT_DIR/contracts"
ARTIFACT_DIR="$ROOT_DIR/.tmp/deploy"
WASM="$CONTRACTS_DIR/target/wasm32-unknown-unknown/release/subrosa_escrow.wasm"

log()  { printf '\033[1;36m[subrosa]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[subrosa]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[subrosa]\033[0m %s\n' "$*" >&2; exit 1; }

for tool in stellar cargo sha256sum; do
  command -v "$tool" >/dev/null 2>&1 || die "missing required tool: $tool"
done

case "$NETWORK" in
  testnet)   RPC_URL="https://soroban-testnet.stellar.org"; NETWORK_PASSPHRASE="Test SDF Network ; September 2015"; DEFAULT_TOKEN="$XLM_SAC_TESTNET" ;;
  futurenet) RPC_URL="https://rpc-futurenet.stellar.org"; NETWORK_PASSPHRASE="Test SDF Future Network ; October 2022"; DEFAULT_TOKEN="$XLM_SAC_TESTNET" ;;
  mainnet)   RPC_URL="https://soroban-rpc.mainnet.stellar.gateway.fm"; NETWORK_PASSPHRASE="Public Global Stellar Network ; September 2015"; DEFAULT_TOKEN="$USDC_SAC_MAINNET" ;;
  *) die "unknown NETWORK '$NETWORK' (expected testnet, futurenet or mainnet)" ;;
esac

warn "settlement token is $DEFAULT_TOKEN"
warn "testnet defaults to the native XLM SAC so that end-to-end runs need no trustlines;"
warn "set SUBROSA_SETTLEMENT_TOKEN=$USDC_SAC_TESTNET to settle in testnet USDC instead."

if [ "$NETWORK" = "mainnet" ] && [ "${CONFIRM_MAINNET_DEPLOY:-no}" != "yes" ]; then
  die "refusing to deploy to mainnet without CONFIRM_MAINNET_DEPLOY=yes"
fi

mkdir -p "$ARTIFACT_DIR"

# --- 1. Build -----------------------------------------------------------------
log "building $WASM"
( cd "$CONTRACTS_DIR" && cargo build --target wasm32-unknown-unknown --release )
[ -f "$WASM" ] || die "build did not produce $WASM"

if stellar contract optimize --wasm "$WASM" >/dev/null 2>&1; then
  OPT="$CONTRACTS_DIR/target/wasm32-unknown-unknown/release/subrosa_escrow.optimized.wasm"
  [ -f "$OPT" ] && WASM="$OPT"
fi
WASM_SHA256="$(sha256sum "$WASM" | awk '{print $1}')"
WASM_SIZE="$(wc -c < "$WASM" | tr -d ' ')"
log "wasm sha256=$WASM_SHA256 size=${WASM_SIZE}B"

# --- 2. Resolve addresses -----------------------------------------------------
if ! stellar keys address "$IDENTITY" >/dev/null 2>&1; then
  log "creating identity '$IDENTITY'"
  stellar keys generate "$IDENTITY" --network "$NETWORK" --fund --overwrite
fi
DEPLOYER="$(stellar keys address "$IDENTITY")"

ADMIN="${SUBROSA_ADMIN:-$DEPLOYER}"
TREASURY="${SUBROSA_TREASURY:-$ADMIN}"
SETTLEMENT_TOKEN="${SUBROSA_SETTLEMENT_TOKEN:-$DEFAULT_TOKEN}"

if [ -z "${SUBROSA_RELAYER_PUBKEYS:-}" ]; then
  if [ "$NETWORK" != "testnet" ]; then
    die "SUBROSA_RELAYER_PUBKEYS is required outside testnet. The quorum is a real trust assumption; it must be keys held by independent operators."
  fi
  warn "SUBROSA_RELAYER_PUBKEYS unset: generating 3 throwaway ed25519 testnet relayers."
  warn "Production must pin keys held by independent operators."

  # A raw ed25519 public key is the trailing 32 bytes of the SPKI DER encoding and
  # a raw seed is the trailing 32 bytes of the PKCS8 encoding, both fixed-length
  # for this algorithm.
  node -e '
    const { generateKeyPairSync } = require("node:crypto");
    const keys = [];
    for (let i = 0; i < 3; i++) {
      const { publicKey, privateKey } = generateKeyPairSync("ed25519");
      keys.push({
        public: publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("hex"),
        secret: privateKey.export({ type: "pkcs8", format: "der" }).subarray(-32).toString("hex"),
      });
    }
    const fs = require("node:fs");
    const path = process.argv[1] + "/relayer-keys.json";
    fs.writeFileSync(path, JSON.stringify(keys, null, 2), { mode: 0o600 });
    process.stdout.write(keys.map((k) => k.public).join(","));
    process.stderr.write("wrote " + path + " (mode 0600)\n");
  ' "$ARTIFACT_DIR" > "$ARTIFACT_DIR/relayer-pubkeys.txt"

  SUBROSA_RELAYER_PUBKEYS="$(cat "$ARTIFACT_DIR/relayer-pubkeys.txt")"
  rm -f "$ARTIFACT_DIR/relayer-pubkeys.txt"
fi

# Build the Soroban vector argument from the comma-separated hex pubkeys.
IFS=',' read -r -a PUBKEY_ARR <<< "$SUBROSA_RELAYER_PUBKEYS"
[ "${#PUBKEY_ARR[@]}" -ge 1 ] || die "SUBROSA_RELAYER_PUBKEYS is empty"
[ "${#PUBKEY_ARR[@]}" -le 16 ] || die "at most 16 relayers are supported"
[ "$RELAYER_THRESHOLD" -le "${#PUBKEY_ARR[@]}" ] || die "threshold exceeds relayer count"

VEC="["
for i in "${!PUBKEY_ARR[@]}"; do
  KEY="$(echo "${PUBKEY_ARR[$i]}" | tr -d '[:space:]')"
  [ "${#KEY}" -eq 64 ] || die "relayer key $i must be 64 hex chars, got ${#KEY}"
  [ $i -gt 0 ] && VEC="$VEC,"
  VEC="$VEC\"$KEY\""
done
VEC="$VEC]"

log "network=$NETWORK deployer=$DEPLOYER admin=$ADMIN treasury=$TREASURY"
log "settlement_token=$SETTLEMENT_TOKEN relayers=${#PUBKEY_ARR[@]} threshold=$RELAYER_THRESHOLD"

# --- 3. Deploy ----------------------------------------------------------------
log "installing wasm"
WASM_HASH="$(stellar contract upload \
  --network "$NETWORK" --source "$IDENTITY" --wasm "$WASM")"
log "wasm hash on ledger: $WASM_HASH"

log "deploying contract instance"
CONTRACT_ID="$(stellar contract deploy \
  --network "$NETWORK" --source "$IDENTITY" --wasm-hash "$WASM_HASH")"
log "contract id: $CONTRACT_ID"

# --- 4. Initialise ------------------------------------------------------------
log "initialising"
stellar contract invoke \
  --network "$NETWORK" --source "$IDENTITY" --id "$CONTRACT_ID" \
  -- initialize \
  --admin "$ADMIN" \
  --settlement_token "$SETTLEMENT_TOKEN" \
  --treasury "$TREASURY" \
  --token_decimals 7 \
  --fee_bps "$FEE_BPS" \
  --relayer_pubkeys "$VEC" \
  --relayer_threshold "$RELAYER_THRESHOLD" \
  --chain_hash "$DRAND_CHAIN_HASH" \
  --drand_genesis "$DRAND_GENESIS" \
  --drand_period "$DRAND_PERIOD" \
  --assumed_ledger_seconds 5 \
  --margin_rounds 20 \
  --max_bids 64 \
  --min_bond 1000000 \
  --min_reveal_lead_ledgers 20

# --- 5. Verify ----------------------------------------------------------------
log "smoke-testing the deployment"
stellar contract invoke \
  --network "$NETWORK" --source "$IDENTITY" --id "$CONTRACT_ID" \
  -- schema_version

# --- 6. Record ----------------------------------------------------------------
LEDGER="$(stellar ledger latest --network "$NETWORK" 2>/dev/null | head -1 || echo 0)"

cat > "$ARTIFACT_DIR/$NETWORK.json" <<JSON
{
  "network": "$NETWORK",
  "network_passphrase": "$NETWORK_PASSPHRASE",
  "rpc_url": "$RPC_URL",
  "contract_id": "$CONTRACT_ID",
  "wasm_hash": "$WASM_HASH",
  "wasm_sha256": "$WASM_SHA256",
  "wasm_size_bytes": $WASM_SIZE,
  "settlement_token": "$SETTLEMENT_TOKEN",
  "admin": "$ADMIN",
  "treasury": "$TREASURY",
  "fee_bps": $FEE_BPS,
  "relayer_threshold": $RELAYER_THRESHOLD,
  "relayer_count": ${#PUBKEY_ARR[@]},
  "deployer": "$DEPLOYER",
  "deployed_at_ledger": $LEDGER
}
JSON

log "wrote $ARTIFACT_DIR/$NETWORK.json"

if [ -f "$ROOT_DIR/scripts/sync-funding.mjs" ]; then
  log "syncing FUNDING.json"
  node "$ROOT_DIR/scripts/sync-funding.mjs" "$ARTIFACT_DIR/$NETWORK.json"
fi

log "done. contract id: $CONTRACT_ID"

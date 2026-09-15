/**
 * The typed bindings for `subrosa_escrow`.
 *
 * Reads run through `simulateTransaction` against a null account, so they cost
 * nothing and need no funded key. Writes are returned as *arguments* rather than
 * executed, because the caller decides who signs and who pays.
 */

import { Account, BASE_FEE, Contract, TransactionBuilder, rpc, scValToNative, xdr } from '@stellar/stellar-sdk';
import { NULL_ACCOUNT } from '@stellar/stellar-sdk/contract';
import { EncodingError } from '../util/bytes.ts';
import {
  addressScVal,
  asArray,
  asBigInt,
  asBoolean,
  asBytes32,
  asEnumName,
  asNumber,
  asOption,
  asRecord,
  asString,
  bytesScVal,
  structScVal,
  u32ScVal,
  u64ScVal,
  vecScVal,
  i128ScVal,
} from './scval.ts';
import type { StellarNetwork } from './network.ts';

export const PHASES = ['Sealed', 'Reveal', 'Funding', 'Settled', 'Cancelled', 'Failed'] as const;
export type Phase = (typeof PHASES)[number];

export const TERMINAL_PHASES: readonly Phase[] = ['Settled', 'Cancelled', 'Failed'];

export class ContractCallError extends Error {
  constructor(
    readonly method: string,
    message: string,
    readonly errorCode?: number,
  ) {
    super(`subrosa_escrow.${method} failed: ${message}`);
    this.name = 'ContractCallError';
  }
}

export interface AuctionView {
  readonly id: bigint;
  readonly seller: string;
  readonly reservePrice: bigint;
  readonly bond: bigint;
  readonly sellerBond: bigint;
  readonly commitDeadline: number;
  readonly revealDeadline: number;
  readonly fundingDeadline: number;
  readonly revealRound: number;
  readonly phase: Phase;
  readonly sealedCount: number;
  readonly revealedCount: number;
  readonly escrowed: bigint;
  readonly claimed: bigint;
  readonly slashed: bigint;
  readonly cancelCompensation: bigint;
  readonly beacon: { readonly round: number; readonly randomness: string } | null;
  readonly winner: string | null;
  readonly hammerPrice: bigint;
  readonly revealed: readonly { readonly bidder: string; readonly amount: bigint }[];
}

export interface BidView {
  readonly bidder: string;
  readonly commitment: string;
  readonly envelopeHash: string;
  readonly bond: bigint;
  readonly funded: bigint;
  readonly revealed: boolean;
  readonly revealedAmount: bigint;
  readonly settled: boolean;
}

export interface ConfigView {
  readonly admin: string;
  readonly settlementToken: string;
  readonly treasury: string;
  readonly feeBps: number;
  readonly tokenDecimals: number;
  readonly relayerPubkeys: readonly string[];
  readonly relayerThreshold: number;
  readonly chainHash: string;
  readonly drandGenesis: number;
  readonly drandPeriod: number;
  readonly maxBids: number;
  readonly assumedLedgerSeconds: number;
  readonly marginRounds: number;
  readonly minBond: bigint;
  readonly minRevealLeadLedgers: number;
  readonly paused: boolean;
}

export interface CreateAuctionParams {
  readonly reservePrice: bigint;
  readonly bond: bigint;
  readonly sellerBond: bigint;
  readonly commitWindowLedgers: number;
  readonly revealWindowLedgers: number;
  readonly fundingWindowLedgers: number;
}

export interface BeaconAttestation {
  readonly signerIndex: number;
  readonly signature: Uint8Array;
}

export class SubRosaContract {
  constructor(
    private readonly server: rpc.Server,
    private readonly network: StellarNetwork,
    readonly contractId: string,
  ) {}

  // -------------------------------------------------------------------------
  // Argument builders
  // -------------------------------------------------------------------------

  private get contract(): Contract {
    return new Contract(this.contractId);
  }

  createAuctionArgs(seller: string, params: CreateAuctionParams): xdr.ScVal[] {
    return [
      addressScVal(seller),
      structScVal({
        reserve_price: i128ScVal(params.reservePrice),
        bond: i128ScVal(params.bond),
        seller_bond: i128ScVal(params.sellerBond),
        commit_window_ledgers: u32ScVal(params.commitWindowLedgers),
        reveal_window_ledgers: u32ScVal(params.revealWindowLedgers),
        funding_window_ledgers: u32ScVal(params.fundingWindowLedgers),
      }),
    ];
  }

  sealBidArgs(
    auctionId: bigint,
    bidder: string,
    commitment: Uint8Array,
    envelopeHash: Uint8Array,
  ): xdr.ScVal[] {
    return [
      u64ScVal(auctionId),
      addressScVal(bidder),
      bytesScVal(commitment),
      bytesScVal(envelopeHash),
    ];
  }

  attestBeaconArgs(
    auctionId: bigint,
    round: number,
    randomness: Uint8Array,
    attestation: readonly BeaconAttestation[],
  ): xdr.ScVal[] {
    return [
      u64ScVal(auctionId),
      u64ScVal(BigInt(round)),
      bytesScVal(randomness),
      vecScVal(
        attestation.map((entry) =>
          structScVal({
            signer_index: u32ScVal(entry.signerIndex),
            signature: bytesScVal(entry.signature),
          }),
        ),
      ),
    ];
  }

  revealBidArgs(
    auctionId: bigint,
    bidder: string,
    amount: bigint,
    salt: Uint8Array,
    envelope: string,
  ): xdr.ScVal[] {
    return [
      u64ScVal(auctionId),
      addressScVal(bidder),
      i128ScVal(amount),
      bytesScVal(salt),
      bytesScVal(new Uint8Array(Buffer.from(envelope, 'utf8'))),
    ];
  }

  fundBidArgs(auctionId: bigint, bidder: string, amount: bigint): xdr.ScVal[] {
    return [u64ScVal(auctionId), addressScVal(bidder), i128ScVal(amount)];
  }

  settleArgs(auctionId: bigint): xdr.ScVal[] {
    return [u64ScVal(auctionId)];
  }

  claimArgs(auctionId: bigint, claimant: string): xdr.ScVal[] {
    return [u64ScVal(auctionId), addressScVal(claimant)];
  }

  cancelAuctionArgs(seller: string, auctionId: bigint): xdr.ScVal[] {
    return [addressScVal(seller), u64ScVal(auctionId)];
  }

  abortAuctionArgs(admin: string, auctionId: bigint): xdr.ScVal[] {
    return [addressScVal(admin), u64ScVal(auctionId)];
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /** Simulate a read-only call and return its native return value. */
  private async simulate(method: string, args: xdr.ScVal[] = []): Promise<unknown> {
    const source = new Account(NULL_ACCOUNT, '0');
    const tx = new TransactionBuilder(source, {
      fee: BASE_FEE,
      networkPassphrase: this.network.passphrase,
    })
      .addOperation(this.contract.call(method, ...args))
      .setTimeout(30)
      .build();

    const simulation = await this.server.simulateTransaction(tx);

    if (rpc.Api.isSimulationError(simulation)) {
      throw new ContractCallError(method, simulation.error);
    }
    if (!simulation.result) {
      throw new ContractCallError(method, 'simulation returned no result value');
    }
    return scValToNative(simulation.result.retval);
  }

  private async simulateOptional(method: string, args: xdr.ScVal[]): Promise<unknown | undefined> {
    try {
      return await this.simulate(method, args);
    } catch (error) {
      // `AuctionNotFound` and `BidNotFound` are ordinary answers to "does this
      // exist?", not failures. Everything else propagates.
      if (error instanceof ContractCallError) return undefined;
      throw error;
    }
  }

  async getConfig(): Promise<ConfigView> {
    return decodeConfig(await this.simulate('get_config'));
  }

  async getAuction(auctionId: bigint): Promise<AuctionView> {
    return decodeAuction(await this.simulate('get_auction', [u64ScVal(auctionId)]));
  }

  async findAuction(auctionId: bigint): Promise<AuctionView | undefined> {
    const value = await this.simulateOptional('get_auction', [u64ScVal(auctionId)]);
    return value === undefined ? undefined : decodeAuction(value);
  }

  async listAuctions(start: bigint, limit: number): Promise<AuctionView[]> {
    const raw = await this.simulate('list_auctions', [u64ScVal(start), u32ScVal(limit)]);
    return asArray(raw, 'list_auctions').map((entry) => decodeAuction(entry));
  }

  async listBids(auctionId: bigint, start: number, limit: number): Promise<BidView[]> {
    const raw = await this.simulate('list_bids', [
      u64ScVal(auctionId),
      u32ScVal(start),
      u32ScVal(limit),
    ]);
    return asArray(raw, 'list_bids').map((entry) => decodeBid(entry));
  }

  async findBid(auctionId: bigint, bidder: string): Promise<BidView | undefined> {
    const value = await this.simulateOptional('get_bid', [u64ScVal(auctionId), addressScVal(bidder)]);
    return value === undefined ? undefined : decodeBid(value);
  }

  async currentPhase(auctionId: bigint): Promise<Phase> {
    return parsePhase(await this.simulate('current_phase', [u64ScVal(auctionId)]));
  }

  async getClaimable(auctionId: bigint, claimant: string): Promise<bigint> {
    const raw = await this.simulate('get_claimable', [u64ScVal(auctionId), addressScVal(claimant)]);
    return asBigInt(raw, 'get_claimable');
  }

  async auctionCount(): Promise<bigint> {
    return asBigInt(await this.simulate('auction_count'), 'auction_count');
  }

  async timestampForRound(round: number): Promise<bigint> {
    return asBigInt(await this.simulate('timestamp_for_round', [u64ScVal(BigInt(round))]), 'timestamp_for_round');
  }

  /** Assert the client's idea of the world matches the deployed contract. */
  async schemaVersion(): Promise<number> {
    return asNumber(await this.simulate('schema_version'), 'schema_version');
  }
}

// ---------------------------------------------------------------------------
// Decoders
// ---------------------------------------------------------------------------

export function parsePhase(value: unknown): Phase {
  const name = asEnumName(value, 'phase');
  const match = PHASES.find((phase) => phase === name);
  if (!match) {
    throw new EncodingError(`unknown auction phase "${name}"`);
  }
  return match;
}

export function isTerminal(phase: Phase): boolean {
  return TERMINAL_PHASES.includes(phase);
}

function decodeAuction(raw: unknown): AuctionView {
  const record = asRecord(raw, 'auction');
  const beacon = asOption<unknown>(record['beacon']);

  return {
    id: asBigInt(record['id'], 'auction.id'),
    seller: asString(record['seller'], 'auction.seller'),
    reservePrice: asBigInt(record['reserve_price'], 'auction.reserve_price'),
    bond: asBigInt(record['bond'], 'auction.bond'),
    sellerBond: asBigInt(record['seller_bond'], 'auction.seller_bond'),
    commitDeadline: asNumber(record['commit_deadline'], 'auction.commit_deadline'),
    revealDeadline: asNumber(record['reveal_deadline'], 'auction.reveal_deadline'),
    fundingDeadline: asNumber(record['funding_deadline'], 'auction.funding_deadline'),
    revealRound: asNumber(record['reveal_round'], 'auction.reveal_round'),
    phase: parsePhase(record['phase']),
    sealedCount: asNumber(record['sealed_count'], 'auction.sealed_count'),
    revealedCount: asNumber(record['revealed_count'], 'auction.revealed_count'),
    escrowed: asBigInt(record['escrowed'], 'auction.escrowed'),
    claimed: asBigInt(record['claimed'], 'auction.claimed'),
    slashed: asBigInt(record['slashed'], 'auction.slashed'),
    cancelCompensation: asBigInt(record['cancel_compensation'], 'auction.cancel_compensation'),
    beacon:
      beacon === undefined
        ? null
        : {
            round: asNumber(asRecord(beacon, 'beacon')['round'], 'beacon.round'),
            randomness: Buffer.from(
              asBytes32(asRecord(beacon, 'beacon')['randomness'], 'beacon.randomness'),
            ).toString('hex'),
          },
    winner: asOption<string>(record['winner']) ?? null,
    hammerPrice: asBigInt(record['hammer_price'], 'auction.hammer_price'),
    revealed: asArray(record['revealed'], 'auction.revealed').map((entry) => {
      const row = asRecord(entry, 'auction.revealed[]');
      return {
        bidder: asString(row['bidder'], 'revealed.bidder'),
        amount: asBigInt(row['amount'], 'revealed.amount'),
      };
    }),
  };
}

function decodeBid(raw: unknown): BidView {
  const record = asRecord(raw, 'bid');
  return {
    bidder: asString(record['bidder'], 'bid.bidder'),
    commitment: Buffer.from(asBytes32(record['commitment'], 'bid.commitment')).toString('hex'),
    envelopeHash: Buffer.from(asBytes32(record['envelope_hash'], 'bid.envelope_hash')).toString('hex'),
    bond: asBigInt(record['bond'], 'bid.bond'),
    funded: asBigInt(record['funded'], 'bid.funded'),
    revealed: asBoolean(record['revealed'], 'bid.revealed'),
    revealedAmount: asBigInt(record['revealed_amount'], 'bid.revealed_amount'),
    settled: asBoolean(record['settled'], 'bid.settled'),
  };
}

function decodeConfig(raw: unknown): ConfigView {
  const record = asRecord(raw, 'config');
  return {
    admin: asString(record['admin'], 'config.admin'),
    settlementToken: asString(record['settlement_token'], 'config.settlement_token'),
    treasury: asString(record['treasury'], 'config.treasury'),
    feeBps: asNumber(record['fee_bps'], 'config.fee_bps'),
    tokenDecimals: asNumber(record['token_decimals'], 'config.token_decimals'),
    relayerPubkeys: asArray(record['relayer_pubkeys'], 'config.relayer_pubkeys').map((entry) =>
      Buffer.from(asBytes32(entry, 'relayer_pubkeys[]')).toString('hex'),
    ),
    relayerThreshold: asNumber(record['relayer_threshold'], 'config.relayer_threshold'),
    chainHash: Buffer.from(asBytes32(record['chain_hash'], 'config.chain_hash')).toString('hex'),
    drandGenesis: asNumber(record['drand_genesis'], 'config.drand_genesis'),
    drandPeriod: asNumber(record['drand_period'], 'config.drand_period'),
    maxBids: asNumber(record['max_bids'], 'config.max_bids'),
    assumedLedgerSeconds: asNumber(record['assumed_ledger_seconds'], 'config.assumed_ledger_seconds'),
    marginRounds: asNumber(record['margin_rounds'], 'config.margin_rounds'),
    minBond: asBigInt(record['min_bond'], 'config.min_bond'),
    minRevealLeadLedgers: asNumber(record['min_reveal_lead_ledgers'], 'config.min_reveal_lead_ledgers'),
    paused: asBoolean(record['paused'], 'config.paused'),
  };
}

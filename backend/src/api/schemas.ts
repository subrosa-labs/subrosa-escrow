/** Request validation. Every body is parsed before it reaches the orchestrator. */

import { z } from 'zod';

/** A Stellar strkey address: `G...` for accounts, `C...` for contracts. */
export const strkey = z
  .string()
  .regex(/^[GC][A-Z2-7]{55}$/, 'must be a Stellar G... account or C... contract address');

/** A `u64` or `i128` carried as a decimal string, so JSON precision never bites. */
export const decimalString = z
  .string()
  .regex(/^\d+$/, 'must be a non-negative decimal integer string');

export const hex32 = z.string().regex(/^[0-9a-f]{64}$/i, 'must be 32 bytes of hex');

export const hex64 = z.string().regex(/^[0-9a-f]{128}$/i, 'must be 64 bytes of hex');

export const publishEnvelopeSchema = z.object({
  bidder: strkey,
  envelope: z
    .string()
    .min(1, 'envelope is required')
    .max(16_384, 'envelope is implausibly large for a tlock payload'),
  commitment: hex32,
  envelopeHash: hex32,
});

export const prepareSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('create_auction'),
    seller: strkey,
    reservePrice: decimalString,
    bond: decimalString,
    sellerBond: decimalString,
    commitWindowLedgers: z.number().int().positive(),
    revealWindowLedgers: z.number().int().positive(),
    fundingWindowLedgers: z.number().int().positive(),
  }),
  z.object({
    action: z.literal('seal_bid'),
    bidder: strkey,
    auctionId: decimalString,
    commitment: hex32,
    envelopeHash: hex32,
  }),
  z.object({
    action: z.literal('fund_bid'),
    bidder: strkey,
    auctionId: decimalString,
    amount: decimalString,
  }),
  z.object({
    action: z.literal('reveal_bid'),
    bidder: strkey,
    auctionId: decimalString,
    amount: decimalString,
    salt: hex32,
    /** The age-armored ciphertext, which the contract hashes and compares. */
    envelope: z.string().min(1),
  }),
  z.object({
    action: z.literal('settle'),
    /** Any account may trigger settlement; it only needs to pay the fee. */
    source: strkey,
    auctionId: decimalString,
  }),
  z.object({
    action: z.literal('claim'),
    claimant: strkey,
    auctionId: decimalString,
  }),
  z.object({
    action: z.literal('cancel_auction'),
    seller: strkey,
    auctionId: decimalString,
  }),
]);

export type PrepareRequest = z.infer<typeof prepareSchema>;

export const submitSchema = z.object({
  /** Base64 transaction envelope XDR, already signed by the actor. */
  xdr: z.string().min(1),
  /**
   * Ask the relayer to pay the fee via a fee-bump wrapper.
   *
   * The inner transaction still needs a sequence number from the actor's account, so
   * the account must exist — but it needs no XLM, which is what makes a fresh
   * bidder's first sealed bid possible.
   */
  sponsor: z.boolean().default(false),
});

export type SubmitRequest = z.infer<typeof submitSchema>;

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export const auctionIdParam = z.object({
  id: z.coerce.bigint().nonnegative(),
});

/**
 * Query for the auction detail route.
 *
 * `claimant` is optional because reads must work without a wallet. When it is
 * present it has to be a real strkey: passing an arbitrary string through to the
 * contract produces a 502 `chain_read_failed`, which reads like an outage rather
 * than a bad request.
 */
export const auctionDetailQuery = z.object({
  claimant: strkey.optional(),
});

/**
 * Query for the bid list.
 *
 * `start` is a bid index within the auction, not a ledger sequence. Both bounds
 * are enforced here so a `limit=abc` or negative `start` cannot become `NaN` and
 * reach the contract simulation.
 */
export const bidPageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(50),
  start: z.coerce.number().int().min(0).default(0),
});

export const bidderParam = z.object({
  id: z.coerce.bigint().nonnegative(),
  bidder: strkey,
});

/**
 * The read/relay HTTP API.
 *
 * Split of responsibility:
 *
 * * **Reads** answer from the chain (authoritative) with targeted simulations, plus
 *   the auction cache for listing. Nothing here can contradict on-chain state.
 * * **Envelope routes** are the bulletin board: a bidder publishes a sealed ciphertext
 *   and its hashes. The plaintext is never accepted, because the client encrypts
 *   before it ever reaches us.
 * * **Transaction routes** let the frontend hand us a *commitment* and get back an
 *   unsigned invoke XDR. This is the important one for privacy: the browser computes
 *   the commitment and the ciphertext locally, so the only thing that crosses the
 *   wire before the reveal round is a hash and a ciphertext we cannot read.
 *
 * Notably absent: any endpoint that accepts a bid amount in plaintext, or that signs
 * on a user's behalf. The relayer only ever signs its own administrative calls.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import type { App } from '../app.ts';
import { childLogger } from '../logger.ts';
import { msUntilRound, roundAt, roundTime } from '../drand/chain.ts';
import { BulletinError } from '../services/bulletin.ts';
import { OrchestratorError } from '../services/orchestrator.ts';
import { ContractCallError, isTerminal, type AuctionView, type BidView } from '../stellar/contract.ts';
import { SubmissionError, contractErrorName } from '../stellar/errors.ts';
import {
  auctionIdParam,
  bidderParam,
  paginationSchema,
  prepareSchema,
  publishEnvelopeSchema,
  submitSchema,
} from './schemas.ts';

export function buildServer(app: App): FastifyInstance {
  const log = childLogger('api');
  const server = Fastify({ logger: app.log, trustProxy: true, bodyLimit: 256 * 1024 });

  // -- CORS ---------------------------------------------------------------
  server.addHook('onRequest', (request, reply, done) => {
    const origin = request.headers.origin;
    const allowed = app.config.corsOrigins;
    const permit =
      allowed === '*' || (typeof origin === 'string' && allowed.includes(origin));
    if (permit) {
      reply.header('Access-Control-Allow-Origin', allowed === '*' ? '*' : (origin ?? '*'));
      reply.header('Vary', 'Origin');
      reply.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      reply.header('Access-Control-Allow-Headers', 'content-type,authorization');
      reply.header('Access-Control-Max-Age', '86400');
    }
    if (request.method === 'OPTIONS') {
      reply.code(204).send();
      return;
    }
    done();
  });

  // -- Errors -------------------------------------------------------------
  server.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      reply.code(400).send({
        error: 'invalid_request',
        message: 'request failed validation',
        issues: error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
      return;
    }
    if (error instanceof BulletinError) {
      reply.code(error.statusCode).send({ error: 'bulletin_rejected', message: error.message });
      return;
    }
    if (error instanceof SubmissionError) {
      reply.code(502).send({
        error: 'chain_error',
        message: error.message,
        contractErrorCode: error.detail.contractErrorCode ?? null,
        contractErrorName: error.detail.contractErrorName ?? null,
      });
      return;
    }
    if (error instanceof ContractCallError) {
      reply.code(502).send({ error: 'chain_read_failed', message: error.message });
      return;
    }
    if (error instanceof OrchestratorError) {
      reply.code(503).send({ error: 'relayer_unavailable', message: error.message });
      return;
    }
    log.error({ err: error, url: request.url }, 'unhandled request error');
    reply.code(500).send({ error: 'internal_error', message: 'unexpected server error' });
  });

  server.setNotFoundHandler((request, reply) => {
    reply.code(404).send({ error: 'not_found', message: `no route for ${request.method} ${request.url}` });
  });

  // -----------------------------------------------------------------------
  // Health and metadata
  // -----------------------------------------------------------------------

  server.get('/healthz', async (_request, reply) => {
    const storeHealth = await app.store.health();
    let ledger: number | null = null;
    let rpcOk = true;
    try {
      ledger = (await app.server.getLatestLedger()).sequence;
    } catch {
      rpcOk = false;
    }

    const ok = storeHealth.ok && rpcOk && app.preflight.length === 0;
    reply.code(ok ? 200 : 503);
    return {
      ok,
      network: app.network.name,
      // The passphrase the relayer builds transactions against. The frontend needs it
      // to detect a wallet pointed at the wrong network *before* the user signs, rather
      // than after the network rejects the envelope.
      networkPassphrase: app.network.passphrase,
      contractId: app.config.SUBROSA_CONTRACT_ID ?? null,
      ledger,
      store: storeHealth,
      rpc: rpcOk ? 'ok' : 'unreachable',
      chain: app.chain.beaconId,
      preflight: app.preflight,
    };
  });

  server.get('/v1/drand/info', async () => {
    const now = Date.now();
    const latestRound = roundAt(now / 1000, app.chain);
    const nextPublishMs = msUntilRound(latestRound + 1, app.chain, now);

    return {
      beaconId: app.chain.beaconId,
      chainHash: app.chain.chainHash,
      publicKey: app.chain.publicKey,
      schemeId: app.chain.schemeId,
      periodSeconds: app.chain.periodSeconds,
      genesisTime: app.chain.genesisTime,
      latestRound,
      nextRound: latestRound + 1,
      nextRoundInMs: nextPublishMs,
      // The contract's pinned parameters, so a client can confirm they agree.
      contract: {
        genesis: await app.contract.timestampForRound(1).then(Number).catch(() => null),
      },
      verification: {
        command: 'npm run drand:verify --workspace backend -- --round <n>',
        note: 'Every beacon this service uses is BLS-verified by drand-client against the pinned public key before it is signed into an attestation.',
      },
    };
  });

  server.get('/v1/config', async () => {
    const config = await app.orchestrator.onChain();
    return {
      admin: config.admin,
      settlementToken: config.settlementToken,
      treasury: config.treasury,
      feeBps: config.feeBps,
      tokenDecimals: config.tokenDecimals,
      relayerThreshold: config.relayerThreshold,
      relayerCommitteeSize: config.relayerPubkeys.length,
      chainHash: config.chainHash,
      drandGenesis: config.drandGenesis,
      drandPeriod: config.drandPeriod,
      maxBids: config.maxBids,
      assumedLedgerSeconds: config.assumedLedgerSeconds,
      marginRounds: config.marginRounds,
      minBond: config.minBond.toString(),
      minRevealLeadLedgers: config.minRevealLeadLedgers,
      paused: config.paused,
    };
  });

  // -----------------------------------------------------------------------
  // Auctions
  // -----------------------------------------------------------------------

  server.get('/v1/auctions', async (request) => {
    const { limit, offset } = paginationSchema.parse(request.query);

    // Refresh straight from the chain for the newest auctions, then fall back to the
    // cache for older pages so a deep pagination does not fan out into simulations.
    let auctions: AuctionView[] = [];
    try {
      const count = Number(await app.contract.auctionCount());
      const start = Math.max(0, count - offset - limit);
      if (start < count) {
        auctions = await app.contract.listAuctions(BigInt(start), limit);
        for (const auction of auctions) await app.orchestrator.cacheAuction(auction);
      }
    } catch (error) {
      request.log.warn({ err: error }, 'live auction listing failed; serving the cache');
    }

    if (auctions.length > 0) {
      return { auctions: auctions.map(auctionJson).reverse(), source: 'chain' };
    }

    const cached = await app.store.listAuctionCache(limit, offset);
    return {
      auctions: cached.map((row) => ({
        id: row.auctionId,
        seller: row.seller,
        phase: row.phase,
        reservePrice: row.reservePrice,
        bond: row.bond,
        commitDeadline: row.commitDeadline,
        revealDeadline: row.revealDeadline,
        fundingDeadline: row.fundingDeadline,
        revealRound: row.revealRound,
        sealedCount: row.sealedCount,
        revealedCount: row.revealedCount,
        winner: row.winner,
        hammerPrice: row.hammerPrice,
        escrowed: row.escrowed,
        updatedAt: row.updatedAt,
      })),
      source: 'cache',
    };
  });

  server.get('/v1/auctions/:id', async (request, reply) => {
    const { id } = auctionIdParam.parse(request.params);
    const query = request.query as Record<string, string | undefined>;

    const auction = await app.contract.findAuction(id);
    if (!auction) {
      reply.code(404);
      return { error: 'auction_not_found', message: `no auction with id ${id}` };
    }

    const now = Date.now();
    const [envelopeCount, attestation, currentLedger] = await Promise.all([
      app.bulletin.list(id).then((rows) => rows.length),
      app.orchestrator.attestationFor(id),
      // Auction deadlines are ledger sequences. A client cannot tell whether a window is
      // open without knowing where the chain is, so we send the current sequence and let
      // it compare — rather than guessing on its own clock.
      app.server
        .getLatestLedger()
        .then((latest) => latest.sequence)
        .catch(() => null),
    ]);

    const claimable =
      typeof query['claimant'] === 'string'
        ? (await app.contract.getClaimable(id, query['claimant'])).toString()
        : null;

    return {
      auction: auctionJson(auction),
      envelopes: envelopeCount,
      attestation: attestation
        ? {
            round: attestation.round,
            randomness: attestation.randomness,
            signers: attestation.signerIndexes,
            committeeSize: attestation.committeeSize,
            threshold: attestation.threshold,
            createdAt: attestation.createdAt,
          }
        : null,
      claimable,
      timing: {
        now,
        currentLedger,
        commitClosesInMs: msUntilRound(auction.revealRound, app.chain),
        revealRoundPublishesAt: roundTime(auction.revealRound, app.chain) * 1000,
        revealRoundAvailable: roundTime(auction.revealRound, app.chain) * 1000 <= now,
        /** Ledgers left in each window; negative once the window has closed. */
        commitLedgersRemaining: currentLedger === null ? null : auction.commitDeadline - currentLedger,
        revealLedgersRemaining: currentLedger === null ? null : auction.revealDeadline - currentLedger,
        fundingLedgersRemaining: currentLedger === null ? null : auction.fundingDeadline - currentLedger,
        terminal: isTerminal(auction.phase),
      },
    };
  });

  server.get('/v1/auctions/:id/bids', async (request, reply) => {
    const { id } = auctionIdParam.parse(request.params);
    const query = request.query as Record<string, string | undefined>;
    const limit = Math.min(Number(query['limit'] ?? 50), 50);
    const start = Number(query['start'] ?? 0);

    const auction = await app.contract.findAuction(id);
    if (!auction) {
      reply.code(404);
      return { error: 'auction_not_found', message: `no auction with id ${id}` };
    }

    const bids = await app.contract.listBids(id, start, limit);
    return { auctionId: id.toString(), bids: bids.map(bidJson) };
  });

  // -----------------------------------------------------------------------
  // Envelope bulletin
  // -----------------------------------------------------------------------

  server.post('/v1/auctions/:id/envelopes', async (request, reply) => {
    const { id } = auctionIdParam.parse(request.params);
    const body = publishEnvelopeSchema.parse(request.body);

    const auction = await app.contract.findAuction(id);
    if (!auction) {
      reply.code(404);
      return { error: 'auction_not_found', message: `no auction with id ${id}` };
    }

    const record = await app.bulletin.publish({
      auctionId: id,
      bidder: body.bidder,
      envelope: body.envelope,
      commitment: body.commitment,
      envelopeHash: body.envelopeHash,
    });

    // Schedule the reveal for the instant the round goes live.
    await app.store.upsertJob({
      auctionId: id.toString(),
      kind: 'reveal',
      runAfter: new Date(roundTime(auction.revealRound, app.chain) * 1000),
    });

    reply.code(201);
    return {
      auctionId: record.auctionId,
      bidder: record.bidder,
      envelopeHash: record.envelopeHash,
      commitment: record.commitment,
      createdAt: record.createdAt,
      revealRound: auction.revealRound,
      revealRoundPublishesAt: roundTime(auction.revealRound, app.chain) * 1000,
    };
  });

  server.get('/v1/auctions/:id/envelopes', async (request) => {
    const { id } = auctionIdParam.parse(request.params);
    const rows = await app.bulletin.list(id);
    return {
      auctionId: id.toString(),
      envelopes: rows.map((row) => ({
        bidder: row.bidder,
        commitment: row.commitment,
        envelopeHash: row.envelopeHash,
        envelope: row.envelope,
        createdAt: row.createdAt,
      })),
    };
  });

  server.get('/v1/auctions/:id/envelopes/:bidder', async (request, reply) => {
    const { id, bidder } = bidderParam.parse(request.params);
    const row = await app.bulletin.get(id, bidder);
    if (!row) {
      reply.code(404);
      return { error: 'envelope_not_found', message: `no envelope for ${bidder} on auction ${id}` };
    }
    return {
      bidder: row.bidder,
      commitment: row.commitment,
      envelopeHash: row.envelopeHash,
      envelope: row.envelope,
      createdAt: row.createdAt,
    };
  });

  server.get('/v1/auctions/:id/attestation', async (request, reply) => {
    const { id } = auctionIdParam.parse(request.params);
    const record = await app.orchestrator.attestationFor(id);
    if (!record) {
      reply.code(404);
      return {
        error: 'attestation_not_found',
        message:
          'no attestation recorded yet; it is produced once the reveal round beacon is published and BLS-verified',
      };
    }
    return {
      auctionId: record.auctionId,
      round: record.round,
      randomness: record.randomness,
      committeeSize: record.committeeSize,
      threshold: record.threshold,
      signers: record.signerIndexes.map((index, position) => ({
        signerIndex: index,
        signature: record.signatures[position] ?? null,
      })),
      createdAt: record.createdAt,
      verify: 'npm run drand:verify --workspace backend -- --round <round>',
    };
  });

  server.get('/v1/auctions/:id/activity', async (request) => {
    const { id } = auctionIdParam.parse(request.params);
    const submissions = await app.store.listSubmissions(id.toString(), 50);
    const jobs = await app.store.listJobs(id.toString());
    return {
      auctionId: id.toString(),
      submissions,
      jobs: jobs.map((job) => ({
        kind: job.kind,
        status: job.status,
        attempts: job.attempts,
        runAfter: job.runAfter,
        lastError: job.lastError,
      })),
    };
  });

  // -----------------------------------------------------------------------
  // Transaction relaying
  // -----------------------------------------------------------------------

  /**
   * Build an unsigned invoke transaction for the caller to sign.
   *
   * This is the endpoint the browser uses to seal a bid. Note the shape of the
   * request: `commitment` and `envelopeHash` — hashes only. The amount and the salt
   * stay in the browser, inside the ciphertext, which is why the relayer can run this
   * endpoint without ever learning a bid.
   */
  server.post('/v1/tx/prepare', async (request) => {
    const body = prepareSchema.parse(request.body);
    const contract = app.contract;

    const prepared = await (async () => {
      switch (body.action) {
        case 'create_auction':
          return app.relayer.prepare(
            body.seller,
            'create_auction',
            contract.createAuctionArgs(body.seller, {
              reservePrice: BigInt(body.reservePrice),
              bond: BigInt(body.bond),
              sellerBond: BigInt(body.sellerBond),
              commitWindowLedgers: body.commitWindowLedgers,
              revealWindowLedgers: body.revealWindowLedgers,
              fundingWindowLedgers: body.fundingWindowLedgers,
            }),
          );

        case 'seal_bid':
          return app.relayer.prepare(
            body.bidder,
            'seal_bid',
            contract.sealBidArgs(
              BigInt(body.auctionId),
              body.bidder,
              Buffer.from(body.commitment, 'hex'),
              Buffer.from(body.envelopeHash, 'hex'),
            ),
          );

        case 'fund_bid':
          return app.relayer.prepare(
            body.bidder,
            'fund_bid',
            contract.fundBidArgs(BigInt(body.auctionId), body.bidder, BigInt(body.amount)),
          );

        case 'reveal_bid':
          return app.relayer.prepare(
            body.bidder,
            'reveal_bid',
            contract.revealBidArgs(
              BigInt(body.auctionId),
              body.bidder,
              BigInt(body.amount),
              Buffer.from(body.salt, 'hex'),
              body.envelope,
            ),
          );

        case 'settle':
          // Settlement is permissionless, so any funded account can pay for it. The
          // relayer exposes it here so a frontend can offer a "release escrow" button.
          return app.relayer.prepare(
            body.source,
            'settle',
            contract.settleArgs(BigInt(body.auctionId)),
          );

        case 'claim':
          return app.relayer.prepare(
            body.claimant,
            'claim',
            contract.claimArgs(BigInt(body.auctionId), body.claimant),
          );

        case 'cancel_auction':
          return app.relayer.prepare(
            body.seller,
            'cancel_auction',
            contract.cancelAuctionArgs(body.seller, BigInt(body.auctionId)),
          );
      }
    })();

    return {
      action: body.action,
      xdr: prepared.xdr,
      source: prepared.source,
      contractId: prepared.contractId,
      minResourceFee: prepared.minResourceFee.toString(),
      latestLedger: prepared.latestLedger,
      networkPassphrase: app.network.passphrase,
      instructions: 'sign with the actor account, then POST the signed envelope to /v1/tx/submit',
    };
  });

  /**
   * Broadcast a signed envelope, optionally with the relayer paying the fee.
   *
   * Sponsorship is what lets a brand-new bidder seal a bid: their account needs a
   * sequence number but no XLM, because the relayer wraps their transaction in a fee
   * bump. The relayer cannot alter the inner transaction, so it can only pay for it,
   * never change what it does.
   */
  server.post('/v1/tx/submit', async (request, reply) => {
    const body = submitSchema.parse(request.body);

    let submitted = body.xdr;
    let sponsored = false;
    if (body.sponsor) {
      if (!app.relayer.canSponsor) {
        reply.code(409);
        return {
          error: 'sponsorship_unavailable',
          message: 'this relayer has no fee source configured; submit without sponsor',
        };
      }
      submitted = app.relayer.buildFeeBump(body.xdr);
      sponsored = true;
    }

    const result = await app.relayer.submit(submitted, body.sponsor ? 'sponsored transaction' : 'transaction');
    await app.store.recordSubmission({
      auctionId: null,
      method: body.sponsor ? 'submit_sponsored' : 'submit',
      status: 'confirmed',
      hash: result.hash,
      ledger: result.ledger,
      error: null,
    });

    return {
      hash: result.hash,
      ledger: result.ledger,
      sponsored,
      returnValueXdr: result.returnValueXdr ?? null,
      explorerUrl: result.explorerUrl,
    };
  });

  // -----------------------------------------------------------------------
  // Admin
  // -----------------------------------------------------------------------

  if (app.config.ADMIN_TOKEN) {
    const token = app.config.ADMIN_TOKEN;

    server.addHook('onRequest', (request, reply, done) => {
      if (!request.url.startsWith('/v1/admin/')) return done();
      const header = request.headers.authorization ?? '';
      const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
      if (presented !== token) {
        reply.code(401).send({ error: 'unauthorized', message: 'missing or invalid admin token' });
        return;
      }
      done();
    });

    server.post('/v1/admin/observe', async () => {
      const summary = await app.orchestrator.observe();
      return {
        scanned: summary.scanned.toString(),
        scheduled: summary.scheduled.map((entry) => ({
          ...entry,
          runAfter: new Date(Date.now() + entry.runAfterMs).toISOString(),
        })),
      };
    });

    server.post('/v1/admin/advance/:id', async (request) => {
      const { id } = auctionIdParam.parse(request.params);
      const auction = await app.contract.findAuction(id);
      if (!auction) return { error: 'auction_not_found' };
      const kind = auction.beacon ? (isTerminal(auction.phase) ? 'settle' : 'reveal') : 'attest';
      const result = await app.orchestrator.advance({
        id: `manual-${id}`,
        auctionId: id.toString(),
        kind,
        status: 'leased',
        attempts: 0,
        runAfter: new Date().toISOString(),
        leaseUntil: null,
        lastError: null,
        payload: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      return result;
    });

    server.post('/v1/admin/selfcheck', async () => {
      const check = await app.orchestrator.selfCheck();
      const values = await app.contract.getConfig();
      return {
        ...check,
        contract: {
          chainHash: values.chainHash,
          relayerThreshold: values.relayerThreshold,
          relayerCommitteeSize: values.relayerPubkeys.length,
          paused: values.paused,
        },
        holdsPublicKeys: app.config.relayerPublicKeys.map((key) => key.slice(0, 8) + '…'),
      };
    });
  }

  return server;
}

// ---------------------------------------------------------------------------
// Serialisers: bigint never reaches JSON
// ---------------------------------------------------------------------------

function auctionJson(auction: AuctionView) {
  return {
    id: auction.id.toString(),
    seller: auction.seller,
    reservePrice: auction.reservePrice.toString(),
    bond: auction.bond.toString(),
    sellerBond: auction.sellerBond.toString(),
    commitDeadline: auction.commitDeadline,
    revealDeadline: auction.revealDeadline,
    fundingDeadline: auction.fundingDeadline,
    revealRound: auction.revealRound,
    phase: auction.phase,
    sealedCount: auction.sealedCount,
    revealedCount: auction.revealedCount,
    escrowed: auction.escrowed.toString(),
    claimed: auction.claimed.toString(),
    slashed: auction.slashed.toString(),
    cancelCompensation: auction.cancelCompensation.toString(),
    beacon: auction.beacon,
    winner: auction.winner,
    hammerPrice: auction.hammerPrice.toString(),
    // Revealed amounts are public chain state; they become visible only after the
    // commit deadline, when they can no longer influence anyone's bid.
    revealed: auction.revealed.map((entry) => ({
      bidder: entry.bidder,
      amount: entry.amount.toString(),
    })),
  };
}

function bidJson(bid: BidView) {
  return {
    bidder: bid.bidder,
    commitment: bid.commitment,
    envelopeHash: bid.envelopeHash,
    bond: bid.bond.toString(),
    funded: bid.funded.toString(),
    revealed: bid.revealed,
    revealedAmount: bid.revealedAmount.toString(),
    settled: bid.settled,
    // Derived so every client agrees on the slashing rule without re-implementing it.
    disqualified: bid.revealed && bid.funded < bid.revealedAmount,
  };
}

export { contractErrorName };

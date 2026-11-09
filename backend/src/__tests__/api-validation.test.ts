/**
 * API input validation.
 *
 * These are the boundary checks the handlers own, exercised through Fastify's
 * inject() so the status code and error shape are what a client actually sees.
 * Anything that reaches the contract with `NaN` or a malformed address surfaces
 * as a 502 chain error, which looks like an outage instead of a bad request.
 */

import { describe, expect, it } from 'vitest';
import type { App } from '../app.ts';
import { buildServer } from '../api/server.ts';
import { initLogger } from '../logger.ts';
import { QUICKNET } from '../drand/chain.ts';

/**
 * Only the fields the routes touch before validation are real. Every case below
 * fails or returns before a chain read, so a stub contract is honest here.
 */
function stubApp(): App {
  return {
    config: { corsOrigins: '*', ADMIN_TOKEN: undefined },
    log: initLogger('error'),
    store: {},
    server: {},
    chain: QUICKNET,
    contract: {
      findAuction: async () => null,
      listBids: async () => [],
      getClaimable: async () => 0n,
    },
    relayer: {},
    orchestrator: {},
    network: { name: 'testnet', passphrase: 'Test SDF Network ; September 2015' },
    bulletin: {},
    preflight: [],
    close: async () => undefined,
  } as unknown as App;
}

describe('GET /v1/auctions/:id/bids validation', () => {
  const server = buildServer(stubApp());

  it.each(['abc', '0', '51', '-1', '1.5'])('rejects limit=%s with 400', async (limit) => {
    const response = await server.inject({
      method: 'GET',
      url: `/v1/auctions/1/bids?limit=${limit}`,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'invalid_request' });
  });

  it.each(['abc', '-1', '2.5'])('rejects start=%s with 400', async (start) => {
    const response = await server.inject({
      method: 'GET',
      url: `/v1/auctions/1/bids?start=${start}`,
    });
    expect(response.statusCode).toBe(400);
  });

  it('accepts the documented defaults and reaches the auction lookup', async () => {
    const response = await server.inject({ method: 'GET', url: '/v1/auctions/1/bids' });
    // The stub has no auction, so a 404 proves the query parsed.
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: 'auction_not_found' });
  });
});

describe('GET /v1/auctions/:id claimant validation', () => {
  const server = buildServer(stubApp());

  it('rejects a malformed claimant with 400', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/v1/auctions/1?claimant=not-an-address',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'invalid_request' });
  });

  it('accepts an omitted claimant', async () => {
    const response = await server.inject({ method: 'GET', url: '/v1/auctions/1' });
    expect(response.statusCode).toBe(404);
  });
});

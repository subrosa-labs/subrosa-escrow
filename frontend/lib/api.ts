/**
 * Relayer API client.
 *
 * Used from server components for reads (so the first paint has real data and the
 * contract address is not hard-coded into the bundle) and from client components for
 * the seal flow.
 *
 * The seal flow is the only place the browser sends anything about a bid, and what it
 * sends is a hash plus a ciphertext. No endpoint here accepts a plaintext amount, and
 * that is not an accident of the current implementation — it is the interface.
 */

import type {
  ApiErrorBody,
  AttestationDto,
  AuctionDetailDto,
  AuctionDto,
  BidDto,
  ConfigDto,
  DrandInfoDto,
  EnvelopeDto,
  HealthDto,
  PrepareResponseDto,
  SubmitResponseDto,
} from './types.ts';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiErrorBody | null,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** True when the relayer told us the request itself was wrong. */
  get isClientError(): boolean {
    return this.status >= 400 && this.status < 500;
  }

  /** True when the chain rejected the call, with the contract's own reason. */
  get isChainError(): boolean {
    return this.body?.error === 'chain_error';
  }
}

/**
 * Base URL of the relayer.
 *
 * Client-side reads need a publicly reachable URL; server-side reads can use an
 * internal one. Both fall back to localhost so a fresh clone runs.
 */
export function apiBase(): string {
  const fromEnv = process.env.NEXT_PUBLIC_SUBROSA_API_URL;
  return (fromEnv && fromEnv.replace(/\/$/, '')) || 'http://localhost:8080';
}

interface RequestOptions {
  readonly method?: 'GET' | 'POST';
  readonly body?: unknown;
  /** Seconds before the request is abandoned. Reads through RPC can be slow. */
  readonly timeoutMs?: number;
  readonly revalidateSeconds?: number;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);

  try {
    const response = await fetch(`${apiBase()}${path}`, {
      method: options.method ?? 'GET',
      headers: options.body ? { 'content-type': 'application/json' } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
      ...(options.revalidateSeconds !== undefined
        ? { next: { revalidate: options.revalidateSeconds } }
        : { cache: 'no-store' as RequestCache }),
    });

    const text = await response.text();
    const parsed: unknown = text.length > 0 ? JSON.parse(text) : null;

    if (!response.ok) {
      const body = parsed as ApiErrorBody | null;
      throw new ApiError(
        response.status,
        body,
        body?.message ?? `the relayer returned ${response.status}`,
      );
    }

    return parsed as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new ApiError(0, null, 'the relayer did not respond in time');
    }
    throw new ApiError(
      0,
      null,
      `could not reach the relayer at ${apiBase()} (${
        error instanceof Error ? error.message : String(error)
      })`,
    );
  } finally {
    clearTimeout(timeout);
  }
}

export const api = {
  async health(): Promise<HealthDto> {
    return request('/healthz', { timeoutMs: 8_000 });
  },

  /** Just the fields the wallet banner needs, tolerant of an unreachable relayer. */
  async networkPassphrase(): Promise<string | null> {
    try {
      const health = await request<HealthDto>('/healthz', { timeoutMs: 6_000 });
      return health.networkPassphrase ?? null;
    } catch {
      return null;
    }
  },

  async config(): Promise<ConfigDto> {
    return request('/v1/config', { revalidateSeconds: 60 });
  },

  async drandInfo(): Promise<DrandInfoDto> {
    return request('/v1/drand/info', { revalidateSeconds: 5 });
  },

  async auctions(limit = 20, offset = 0): Promise<{ auctions: AuctionDto[]; source: string }> {
    return request(`/v1/auctions?limit=${limit}&offset=${offset}`, { revalidateSeconds: 10 });
  },

  async auction(id: string, claimant?: string): Promise<AuctionDetailDto> {
    const suffix = claimant ? `?claimant=${encodeURIComponent(claimant)}` : '';
    return request(`/v1/auctions/${id}${suffix}`, { timeoutMs: 20_000 });
  },

  async bids(id: string, start = 0, limit = 50): Promise<{ bids: BidDto[] }> {
    return request(`/v1/auctions/${id}/bids?start=${start}&limit=${limit}`, { timeoutMs: 20_000 });
  },

  async envelopes(id: string): Promise<{ envelopes: EnvelopeDto[] }> {
    return request(`/v1/auctions/${id}/envelopes`);
  },

  /** One bidder's ciphertext, used by the reveal flow. */
  async envelopeFor(id: string, bidder: string): Promise<EnvelopeDto> {
    return request(`/v1/auctions/${id}/envelopes/${encodeURIComponent(bidder)}`);
  },

  async attestation(id: string): Promise<AttestationDto> {
    return request(`/v1/auctions/${id}/attestation`);
  },

  /**
   * Publish a sealed envelope.
   *
   * Note the shape: a ciphertext and two hashes. This is the only bid-related payload
   * the browser ever sends, and it is unreadable to the recipient.
   */
  async publishEnvelope(input: {
    auctionId: string;
    bidder: string;
    envelope: string;
    commitment: string;
    envelopeHash: string;
  }): Promise<EnvelopeDto & { revealRound: number }> {
    return request(`/v1/auctions/${input.auctionId}/envelopes`, {
      method: 'POST',
      body: {
        bidder: input.bidder,
        envelope: input.envelope,
        commitment: input.commitment,
        envelopeHash: input.envelopeHash,
      },
      timeoutMs: 20_000,
    });
  },

  /** Build an unsigned invoke transaction for the wallet to sign. */
  async prepare(body: Record<string, unknown>): Promise<PrepareResponseDto> {
    return request('/v1/tx/prepare', { method: 'POST', body, timeoutMs: 30_000 });
  },

  /** Broadcast a signed envelope, optionally with the relayer paying the fee. */
  async submit(xdr: string, sponsor: boolean): Promise<SubmitResponseDto> {
    return request('/v1/tx/submit', {
      method: 'POST',
      body: { xdr, sponsor },
      timeoutMs: 60_000,
    });
  },
};

export type { PrepareResponseDto, SubmitResponseDto, HealthDto };

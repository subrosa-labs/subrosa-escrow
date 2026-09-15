-- SubRosa relayer schema.
--
-- Only off-chain facts live here. Auction state, escrow and outcomes are read from
-- the chain; this database stores the sealed envelopes the chain only holds a hash
-- of, the job queue, relayer attestations, a submission audit trail, and a
-- read-through cache so listing auctions does not fan out into N simulations.

CREATE TABLE IF NOT EXISTS envelopes (
    auction_id     NUMERIC(20, 0) NOT NULL,
    bidder         TEXT           NOT NULL,
    envelope       TEXT           NOT NULL,
    commitment     CHAR(64)       NOT NULL,
    envelope_hash  CHAR(64)       NOT NULL,
    created_at     TIMESTAMPTZ    NOT NULL DEFAULT now(),
    PRIMARY KEY (auction_id, bidder)
);

-- Reveal-time lookup is by auction in insertion order.
CREATE INDEX IF NOT EXISTS envelopes_auction_created_idx
    ON envelopes (auction_id, created_at);

-- Envelope hashes must be unique per auction: two different envelopes cannot share
-- an anchored hash, and a duplicate is a client bug worth surfacing.
CREATE UNIQUE INDEX IF NOT EXISTS envelopes_auction_hash_idx
    ON envelopes (auction_id, envelope_hash);

CREATE TABLE IF NOT EXISTS jobs (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    auction_id   NUMERIC(20, 0) NOT NULL,
    kind         TEXT           NOT NULL CHECK (kind IN ('attest', 'reveal', 'settle')),
    status       TEXT           NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending', 'leased', 'done', 'failed')),
    attempts     INTEGER        NOT NULL DEFAULT 0,
    run_after    TIMESTAMPTZ    NOT NULL DEFAULT now(),
    lease_until  TIMESTAMPTZ,
    last_error   TEXT,
    payload      JSONB          NOT NULL DEFAULT '{}'::jsonb,
    created_at   TIMESTAMPTZ    NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ    NOT NULL DEFAULT now(),
    -- One live job per (auction, kind): the worker is idempotent by construction
    -- rather than by hoping it never runs twice.
    UNIQUE (auction_id, kind)
);

CREATE INDEX IF NOT EXISTS jobs_claimable_idx
    ON jobs (kind, run_after)
    WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS attestations (
    auction_id     NUMERIC(20, 0) PRIMARY KEY,
    round          BIGINT        NOT NULL,
    randomness     CHAR(64)      NOT NULL,
    committee_size INTEGER       NOT NULL,
    threshold      INTEGER       NOT NULL,
    signer_indexes INTEGER[]     NOT NULL,
    signatures     TEXT[]        NOT NULL,
    created_at     TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS submissions (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    auction_id NUMERIC(20, 0),
    method     TEXT        NOT NULL,
    status     TEXT        NOT NULL CHECK (status IN ('submitted', 'confirmed', 'failed')),
    hash       TEXT,
    ledger     BIGINT,
    error      TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS submissions_auction_idx
    ON submissions (auction_id, created_at DESC);

CREATE TABLE IF NOT EXISTS auctions_cache (
    auction_id       NUMERIC(20, 0) PRIMARY KEY,
    seller           TEXT        NOT NULL,
    phase            TEXT        NOT NULL,
    reserve_price    NUMERIC(38, 0) NOT NULL,
    bond             NUMERIC(38, 0) NOT NULL,
    commit_deadline  BIGINT      NOT NULL,
    reveal_deadline  BIGINT      NOT NULL,
    funding_deadline BIGINT      NOT NULL,
    reveal_round     BIGINT      NOT NULL,
    sealed_count     INTEGER     NOT NULL,
    revealed_count   INTEGER     NOT NULL,
    winner           TEXT,
    hammer_price     NUMERIC(38, 0) NOT NULL,
    escrowed         NUMERIC(38, 0) NOT NULL,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS auctions_cache_updated_idx
    ON auctions_cache (updated_at DESC);

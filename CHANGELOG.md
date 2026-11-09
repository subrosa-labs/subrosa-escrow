# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
The contract's `SCHEMA_VERSION` is versioned separately from the package version.

## [Unreleased]

### Added

- ESLint and Prettier configuration for both workspaces, with `lint`, `format`
  and `format:check` scripts.
- `.nvmrc` (Node 22.7) and `rust-toolchain.toml` (Rust 1.81 with the
  `wasm32-unknown-unknown` target).
- Dependabot updates for npm and cargo, weekly.
- CI workflow: npm and cargo caching, lint, format check, both test suites,
  typecheck, frontend build, contract checks, and a non-blocking production
  dependency audit.
- `CODEOWNERS` template with placeholder handles (`REPLACE_ME`).
- Multi-stage backend `Dockerfile` and a `docker-compose.yml` with Postgres for
  local development, plus `.dockerignore`.
- `CHANGELOG.md`.
- Input validation for the bid-list pagination and the `claimant` query on the
  auction detail route, with route-level tests.

### Changed

- Both `.env.example` files document the purpose, default and whether each
  variable is required. The stray `[TEMPLATE]` line was removed.
- README gains CI and license badges, a table of contents and a
  known-limitations section sourced from `SECURITY.md`.
- The README clone URL now points at `subrosa-labs/subrosa-escrow`.

### Fixed

- `npm run build --workspace backend` now copies `src/store/schema.sql` into
  `dist/store/`, so a compiled relayer can apply the Postgres schema.
- The HTTP API now boots. Fastify 5 rejects a pino instance passed as `logger`;
  the existing instance is passed as `loggerInstance`.
- The frontend lint error on an unescaped apostrophe.
- `GET /v1/auctions/:id/bids` no longer lets a non-numeric `limit` or a negative
  `start` reach the contract simulation as `NaN`.

### Security

- No contract, commitment, beacon-digest, attestation or golden-vector
  behaviour was changed in this release.

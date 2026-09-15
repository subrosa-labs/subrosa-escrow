#!/usr/bin/env node
/**
 * Fold a deployment artifact into FUNDING.json.
 *
 *   node scripts/sync-funding.mjs .tmp/deploy/testnet.json
 *
 * Called automatically at the end of `contracts/scripts/deploy.sh`. The policy is
 * stated in FUNDING.json itself: human-authored fields are never overwritten, and the
 * script only writes the machine-derived blocks — contract addresses, wasm hash and
 * size, deployer, ledger, and the pinned toolchain.
 *
 * Keeping this mechanical matters for a grant or audit review: "which bytecode is at
 * this address" should be answerable from the repository, not from someone's memory.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FUNDING_PATH = `${ROOT}/FUNDING.json`;

const artifactPath = process.argv[2];
if (!artifactPath) {
  console.error('usage: sync-funding.mjs <deployment-artifact.json>');
  process.exit(2);
}

const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
const funding = JSON.parse(readFileSync(FUNDING_PATH, 'utf8'));

const deployment = funding.protocol.deployments.find((entry) => entry.network === artifact.network);
if (!deployment) {
  console.error(`FUNDING.json has no deployment entry for network "${artifact.network}"`);
  process.exit(1);
}

deployment.contracts.subrosa_escrow = artifact.contract_id;
if (artifact.settlement_token) {
  deployment.contracts.settlement_token = artifact.settlement_token;
}
deployment.deployed_at_ledger = artifact.deployed_at_ledger;
deployment.deployer = artifact.deployer;
deployment.wasm_hash = artifact.wasm_hash;
deployment.last_synced = new Date().toISOString();

funding.protocol.artifacts.wasm.sha256 = artifact.wasm_sha256;
funding.protocol.artifacts.wasm.size_bytes = artifact.wasm_size_bytes;
funding.protocol.artifacts.source_commit = gitHead();

// Record what actually produced the bytecode, not what we hoped would.
const toolchain = funding.protocol.artifacts.toolchain;
toolchain.rust = tryCommand('rustc', ['--version']) ?? toolchain.rust;
toolchain.soroban_cli = tryCommand('stellar', ['--version']) ?? toolchain.soroban_cli;
toolchain.node = process.version.replace(/^v/, '');

// Sanity-check the recorded wasm hash against the artifact if the file is still around.
if (artifact.wasm_sha256 && funding.protocol.artifacts.wasm.sha256 !== artifact.wasm_sha256) {
  console.error('refusing to write: the recorded wasm sha256 does not match the artifact');
  process.exit(1);
}

writeFileSync(FUNDING_PATH, `${JSON.stringify(funding, null, 2)}\n`);

console.log(`updated FUNDING.json`);
console.log(`  network      ${artifact.network}`);
console.log(`  contract     ${artifact.contract_id}`);
console.log(`  wasm sha256  ${artifact.wasm_sha256}`);
console.log(`  commit       ${funding.protocol.artifacts.source_commit ?? '(none)'}`);

function gitHead() {
  return tryCommand('git', ['rev-parse', 'HEAD']);
}

function tryCommand(command, args) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

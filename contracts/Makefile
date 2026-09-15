# SubRosa Escrow — contract toolchain
#
# Requires: rustup target `wasm32-unknown-unknown`, the `stellar` CLI, and a
# `stellar` identity funded on the target network for the deploy targets.

SHELL := /bin/bash
NETWORK ?= testnet
IDENTITY ?= subrosa-deployer
WASM := target/wasm32-unknown-unknown/release/subrosa_escrow.wasm
OPT_WASM := target/wasm32-unknown-unknown/release/subrosa_escrow.optimized.wasm

.PHONY: help
help:
	@echo "make build          compile the contract to wasm"
	@echo "make test           run the Rust test suite"
	@echo "make fmt lint       format / clippy"
	@echo "make optimize       shrink the wasm with soroban contract optimize"
	@echo "make wasm-hash      sha256 of the built wasm (goes into FUNDING.json)"
	@echo "make deploy         deploy to \$$NETWORK using \$$IDENTITY"
	@echo "make verify         build + test + wasm-hash, the audit one-liner"

.PHONY: build
build:
	cargo build --target wasm32-unknown-unknown --release
	@ls -la $(WASM)

.PHONY: test
test:
	cargo test --features testutils

.PHONY: test-verbose
test-verbose:
	cargo test --features testutils -- --nocapture

.PHONY: fmt
fmt:
	cargo fmt --all

.PHONY: lint
lint:
	cargo clippy --all-targets --features testutils -- -D warnings

.PHONY: optimize
optimize: build
	stellar contract optimize --wasm $(WASM)

.PHONY: wasm-hash
wasm-hash:
	@if [ ! -f "$(WASM)" ]; then echo "build first: make build"; exit 1; fi
	@sha256sum $(WASM) | awk '{print $$1}'

.PHONY: verify
verify: test build wasm-hash

.PHONY: clean
clean:
	cargo clean

# Deploys and initialises, then folds the resulting addresses and wasm hash back
# into FUNDING.json via the sync script at the repo root.
.PHONY: deploy
deploy:
	@NETWORK=$(NETWORK) IDENTITY=$(IDENTITY) ./scripts/deploy.sh

deploy-testnet:
	@$(MAKE) deploy NETWORK=testnet

deploy-mainnet:
	@$(MAKE) deploy NETWORK=mainnet

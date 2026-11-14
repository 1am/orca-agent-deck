SD_DIR   := packages/streamdeck-plugin/pl.1am.orca-agent-deck.sdPlugin
VERSION  := $(shell node -p "require('./package.json').version")
SD_PKG   := dist/orca-agent-deck-$(VERSION).streamDeckPlugin
ORCA_DIR := orca-plugin
ORCA_PKG := dist/orca-agent-deck-orca-plugin-$(VERSION).zip

.PHONY: all build package package-sd package-orca test contract replay replay-a replay-b replay-e2e check clean

all: build

# Build and check both plugins into dist/.
build: package

package: package-sd package-orca
	cp scripts/collect-diagnostics.mjs dist/
	@pnpm release:validate
	@pnpm release:notes
	@pnpm release:checksums

# Contract tests need a running Orca, so they are not part of test (CI and the release have none).
test:
	pnpm test
	pnpm test:integration

contract:
	pnpm test:contract

# Replay scenarios in test/replay (see docs/replay.md); ARGS="--update" rewrites snapshots.
replay:
	pnpm replay $(ARGS)

# Plugin A scenarios on Orca's own test kit: local only, needs Orca >= 1.4.251 installed.
replay-a:
	pnpm replay-a

# Plugin B (the built bin/plugin.js) in a fake Stream Deck host, per host profile that can run on this OS; no Orca needed.
replay-b: 
	pnpm sd:build
	REPLAY_NODE="$(NODE)" pnpm replay-b

replay-e2e:
	pnpm sd:build
	pnpm replay-e2e

check:
	pnpm typecheck
	$(MAKE) test

package-sd: check
	pnpm sd:build
	pnpm sd:validate
	mkdir -p dist
	@# A packed build must not open the Node inspector port: pack without Nodejs.Debug, then put the
	@# dev manifest back (this also undoes pack's reformatting of manifest.json)
	cp $(SD_DIR)/manifest.json dist/manifest.dev.json
	node --experimental-strip-types scripts/release.ts strip-debug
	pnpm exec streamdeck pack $(SD_DIR) -o dist -f || { mv dist/manifest.dev.json $(SD_DIR)/manifest.json; exit 1; }
	mv dist/manifest.dev.json $(SD_DIR)/manifest.json
	mv dist/pl.1am.orca-agent-deck.streamDeckPlugin $(SD_PKG)
	@echo "Built $(SD_PKG) - double-click it on the target machine to install"

package-orca:
	mkdir -p dist
	rm -f $(ORCA_PKG)
	cd $(ORCA_DIR) && zip -qr ../$(ORCA_PKG) . -x '*.DS_Store'
	@echo "Built $(ORCA_PKG)"

clean:
	rm -rf dist

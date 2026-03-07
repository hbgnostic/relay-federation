# Phase 2: Security Layer + SPV Independence — Completion Checklist

**Goal:** Production-grade bridge software. Real operators can fund, stake, register on-chain without depending on Indelible or WoC. Mesh enforces identity, rejects bad actors, scores peers, and maintains healthy topology.

**Date started:** March 5, 2026
**Last updated:** March 6, 2026

---

## Done

- [x] **2.1 Peer scoring engine** — Composite scoring: 30% uptime + 20% response_time + 40% data_accuracy + 10% stake_age. Rolling windows. (`bridge/lib/peer-scorer.js`)
- [x] **2.2 Score-based auto-disconnect** — Auto-disconnect < 0.3, auto-blacklist < 0.1 for 24h. (`bridge/lib/score-actions.js`)
- [x] **2.3 Pubkey challenge-response handshake** — 2-round-trip crypto handshake with nonce exchange and ECDSA signatures. (`bridge/lib/handshake.js`)
- [x] **2.4 Version negotiation** — Highest mutual version selected during handshake. (`bridge/lib/handshake.js`)
- [x] **2.5 Data accuracy validation** — Validates headers (PoW, linkage, timestamps), txs (format, txid integrity via double-SHA256). Feeds accuracy into scorer. (`bridge/lib/data-validator.js`)
- [x] **2.6 Inactive detection (7-day)** — Peers unreachable for 7+ days flagged as inactive. (`bridge/lib/peer-health.js`)
- [x] **2.7 Grace period (24h)** — New disconnections get 24h grace before scoring impact. (`bridge/lib/peer-health.js`)
- [x] **2.8 Anchor bridge config** — Hardcoded anchor list, min 2 connections enforced, auto-reconnect every 30s. (`bridge/lib/anchor-manager.js`)
- [x] **2.15 Gossip-based peer discovery** — P2P peer exchange between connected bridges. (`bridge/lib/gossip.js`)
- [x] **2.16 Peer tie-breaker** — Duplicate connection resolution by pubkey comparison. (`bridge/lib/peer-manager.js`)
- [x] **2.17 Ping/pong latency measurement** — 60s interval, feeds response_time into scorer. (`bridge/cli.js`)
- [x] **2.18 Federation dashboard** — Bubble map visualization with live health data from all bridges. (`dashboard/index.html`)

## TODO — P2P Transaction Capability (SPV Independence)

These items give the bridge its own transaction capability via BSV P2P, eliminating dependency on Indelible's gateway and WoC. This is the foundation — everything else builds on it.

**Implementation plan:** [`plans/p2p-tx-capability-plan.md`](plans/p2p-tx-capability-plan.md)

- [x] **2.19 `getdata MSG_TX` in bsv-node-client** — `getTx(txid)` sends `getdata` with `MSG_TX` (type 1), returns Promise, 10s timeout, handles `notfound`. 5 tests. (`bridge/lib/bsv-node-client.js`)
- [x] **2.20 `tx` message parsing in bsv-node-client** — `_onTx` parses incoming tx, computes txid, emits `'tx'` event with `{ txid, rawHex }`, resolves pending `getTx` requests. 1 test. (`bridge/lib/bsv-node-client.js`)
- [x] **2.21 `inv`/`getdata`/`tx` broadcast in bsv-node-client** — `broadcastTx(rawTxHex)` sends tx directly, caches 60s for `getdata` serving. `_onGetdata` serves cached txs. `_onInv` emits `'tx:inv'` for MSG_TX. 5 tests. (`bridge/lib/bsv-node-client.js`)
- [x] **2.22 Self-sufficient registration** — `cmdRegister` and `cmdDeregister` now use `PersistentStore.getUnspentUtxos()` for local UTXOs and `BSVNodeClient.broadcastTx()` for P2P broadcast. No gateway, no apiKey. (`bridge/cli.js`)
- [x] **2.23 Self-sufficient funding** — `relay-bridge init` now shows wallet address. Address stored in config. Next steps updated (no apiKey, shows address, includes fund step). (`bridge/cli.js`, `bridge/lib/config.js`)
- [x] **2.24 Beacon address watching** — Beacon address added to AddressWatcher in `cmdStart`. `addressToHash160()` utility added to output-parser. On beacon UTXO received, parses OP_RETURN, adds new registrations to gossip directory, logs deregistrations. (`bridge/cli.js`, `bridge/lib/output-parser.js`)
- [x] **2.25 Remove `network.js` dependency from CLI** — `network.js` import removed from `cli.js`. Zero references to `common/lib/network.js` remain in the bridge package. Bridge operates independently.

## TODO — Security Layer

- [x] **2.9 Wire stake bond into `relay-bridge register`** — Real stake bond: `buildStakeBondTx()` creates P2PKH output with MIN_STAKE_SATS (100M sats / 1 BSV) to bridge's own address. Broadcast via P2P, then use txid in registration. CLTV dropped (disabled on BSV since Genesis). (`registry/lib/stake-bond.js`, `bridge/cli.js`, `common/lib/protocol.js`)
- [x] **2.10 Stake bond validation in scanner** — `validateStakeBond()` fetches stake tx, verifies output with >= MIN_STAKE_SATS to registrant's pubkey. `scanRegistry()` adds `stakeValid: true/false` to each entry. (`registry/lib/scanner.js`)
- [x] **2.11 Registry check in handshake** — `registeredPubkeys` Set created from self + seed peers, updated by beacon watcher (register adds, deregister removes). Passed to `handleHello` (inbound) and `handleChallengeResponse` (outbound). Unregistered pubkeys rejected with `not_registered`. (`bridge/cli.js`, `bridge/lib/peer-manager.js`)
- [x] **2.12 Endpoint reachability probe** — `probeEndpoint(endpoint, timeoutMs)` opens WebSocket, waits for open (5s default), closes. `peer:discovered` handler probes before connecting. 4 tests. (`bridge/lib/endpoint-probe.js`, `bridge/cli.js`)
- [x] **2.13 IP diversity rules** — `extractSubnet`, `getSubnets`, `checkIpDiversity` enforce min 3 /16 subnets. Blocks >50% from same subnet when diversity is low. 13 tests. (`bridge/lib/ip-diversity.js`, `bridge/cli.js`)
- [x] **2.14 Periodic peer refresh** — 10-minute `requestPeersFromAll()` interval catches registrations missed during downtime. Replaces chain rescan — beacon watching (2.24) handles real-time, gossip refresh handles gaps. (`bridge/cli.js`)

## TODO — Status & Visibility

- [x] **2.26 BSV P2P node info in status server** — `bsvNodeClient` passed to StatusServer. `/status` JSON includes `bsvNode: { connected, host, height }`. Dashboard shows BSV Node card with status dot, host, height. CLI `relay-bridge status` shows BSV Node section. (`bridge/lib/status-server.js`, `bridge/cli.js`)
- [x] **2.27 Wallet balance in status** — `store` (PersistentStore) passed to StatusServer. `getStatus()` now async, calls `store.getBalance()`. Dashboard shows Wallet card with balance in sats. CLI shows Wallet section. (`bridge/lib/status-server.js`, `bridge/cli.js`)

---

## Phase 2 Checkpoint (from roadmap)

These are the acceptance criteria from `relay-federation-roadmap.md`:

- [x] Bridges compute and display peer scores via `relay-bridge status`
- [x] Low-scoring peers are auto-disconnected
- [x] Handshake rejects connections from unregistered pubkeys *(2.11)*
- [x] Version mismatch produces clean error
- [x] Anchor connections are maintained (auto-reconnect)
- [x] Unreachable bridges are locally flagged as inactive after 7 days

---

---

## Reference: What exists today

| Module | Status | Notes |
|---|---|---|
| `bsv-node-client.js` | Headers + Transactions | P2P connect, handshake, getheaders, ping/pong, `getTx`, `broadcastTx`, `_onTx`, `_onNotfound`, `_onGetdata`, `tx:inv`. 11 tests. |
| `network.js` (common) | Gateway dependency | `fetchUtxos`, `broadcastTx`, `fetchTxHex`, `fetchAddressHistory` all call Indelible gateway. WoC fallback on `fetchTxHex`. |
| `stake-bond.js` (registry) | Code complete, tested | `buildStakeBondTx()` builds real CLTV output. Not wired into CLI. |
| `registration.js` (registry) | Code complete, tested | `buildRegistrationTx()` and `buildDeregistrationTx()` work. Use `network.js` for broadcast. |
| `scanner.js` (registry) | Works but no stake validation | Scans beacon address history, parses CBOR. Doesn't verify stake UTXOs. |
| `AddressWatcher` (bridge) | Works for own address | Watches txs, tracks UTXOs in LevelDB. Already running on live bridges. |
| `PersistentStore` (bridge) | Works | LevelDB store for headers, txs, UTXOs, balance. |
| Indelible `p2p.js` + `spv-client.js` | Reference code | Full P2P tx capability exists in Indelible codebase. Can reference for 2.19-2.21. |

## Notes

- Stake bond builder code exists and is tested (`registry/lib/stake-bond.js`, `registry/test/stake-bond.test.js`) — just not wired into CLI
- Registration and deregistration tx builders exist and are tested (`registry/lib/registration.js`)
- CBOR encoding/decoding exists and is tested (`registry/lib/cbor.js`)
- Chain scanner exists and is tested (`registry/lib/scanner.js`) — needs stake validation added
- All 278 existing tests pass (0 failures)
- Current deployed version: v0.1.9
- Live nodes: federation-gateway (144.202.48.217), indelible-app (45.63.77.31)
- Indelible bridge code at `C:/Indelible-main/server/` has full P2P tx implementation — reference for bsv-node-client upgrades
- WoC is used in ONE place: `common/lib/network.js` line 97 — fallback in `fetchTxHex()`. Eliminated when 2.25 is complete.

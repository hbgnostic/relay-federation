# Bridge Fork Notes

**Fork:** `github.com/HBGnostic/relay-federation`
**Upstream:** `github.com/zcoolz/relay-federation`
**Last Updated:** March 2026

---

## What Relay Federation Is Trying To Do

Relay Federation is a **federated mesh of bridges** that give apps direct access to BSV without depending on centralized API providers.

### The Problem

Most BSV apps today depend on services like WhatsOnChain or JungleBus:
- If those services go down, rate-limit you, or shut off access — your app breaks
- You're asking permission to read a public blockchain
- Single points of failure undermine the decentralization thesis

### The Solution

- Bridges connect directly to BSV nodes via P2P protocol (MSG_TX, MSG_BLOCK, MSG_HEADERS)
- Bridges gossip with each other (headers, peer discovery, transaction relay)
- Apps connect to any bridge in the mesh
- No API keys, no rate limits from third parties, no gatekeepers

### The Thesis

The blockchain is a public record. You shouldn't need a company's permission to read it.

---

## What This Fork Adds

This fork extends Relay Federation from "transaction relay infrastructure" into **block-level data access and analysis**.

### 1. Full Block Fetching via P2P

**Endpoint:** `GET /block/:height/transactions`

Fetches and parses entire blocks directly from BSV P2P peers:
- Returns all transactions with parsed inputs and outputs
- Script type detection (P2PKH, P2PK, OP_RETURN, ordinal envelopes, multisig)
- Protocol detection (MAP, B://, AIP, TreeChat, Twetch, RUN, etc.)
- Pure P2P — no WhatsOnChain fallback

```json
{
  "height": 877833,
  "hash": "0000000000000000068579e4f305a691d6259eedb1305e8b844505d5fd181681",
  "txCount": 74577,
  "transactions": [...]
}
```

### 2. Block Scanning & Taxonomy

**Endpoint:** `GET /block/:height/scan`

Analyzes blocks with a three-layer taxonomy system:

| Layer | Question | Examples |
|-------|----------|----------|
| **Purpose** | Why does this output exist? | Payment, Data Publication, Contracts |
| **Structure** | How is the script constructed? | P2PKH, OP_RETURN, Ordinal Envelope, Multisig |
| **Protocol** | What application created this? | MAP, B://, TreeChat, Twetch, RUN |

Also includes:
- Whale detection (transactions > 100 BSV)
- Miner identification from coinbase
- Script of the Day (SOTD) samples

Powers the daily BSV Intel Report.

### 3. Header Service Integration

**Config:** `headerServiceUrl` in config.json

When local headers aren't synced to a requested block height, the bridge queries an external header service (e.g., traceport block-headers-service) to resolve height → hash.

```json
{
  "headerServiceUrl": "http://localhost:8090"
}
```

This enables access to the **full chain history**, not just blocks within the synced header range. The block is still fetched via P2P — only the hash lookup uses the header service.

### 4. Rate Limiting

Protects expensive endpoints from abuse while keeping public dashboards open:

| Endpoint Type | Limit | Examples |
|---------------|-------|----------|
| Heavy | 2/min | `/block/:height/transactions`, `/block/:height/scan`, `/tx/:txid` |
| Light | Unlimited | `/status`, `/`, `/mempool`, `/logs` |

Operators bypass rate limiting with `Authorization: Bearer <statusSecret>`.

### 5. Mempool History

**Endpoint:** `GET /mempool/history?hours=24`

Stores mempool depth samples every 10 minutes for 24-hour trend visualization. Data persists across restarts in LevelDB.

---

## Architecture Summary

```
                              BSV P2P Network
                                    |
                              [MSG_BLOCK]
                              [MSG_HEADERS]
                                    |
                                    v
+-----------------+    hash?    +------------------+
| Header Service  | <---------- |   Relay Bridge   |
| (traceport)     |             |   (this fork)    |
+-----------------+             +------------------+
  localhost:8090                   :8333 (P2P)
                                   :9333 (HTTP)
                                        |
                                        v
                                 Apps / Scanners
                                 (BSV Intel, etc.)
```

**Data flow for historical block access:**
1. App requests `/block/877833/transactions`
2. Bridge checks local headers — not synced that far back
3. Bridge queries header service for hash at height 877833
4. Header service returns: `0000000000000000068579e4f305a691d6259eedb1305e8b844505d5fd181681`
5. Bridge sends `getdata` to P2P peer for that hash
6. Peer delivers full block via P2P
7. Bridge parses and returns transactions

No WhatsOnChain. No third-party APIs. Your infrastructure, your data.

---

## Key Files Modified

| File | Changes |
|------|---------|
| `lib/status-server.js` | Added `/block/:height/transactions`, `/block/:height/scan`, header service fallback, rate limiting |
| `lib/config.js` | Added `headerServiceUrl` config option |
| `lib/header-relay.js` | Added `getHashAtHeight()` method |
| `lib/block-scanner.js` | New file — taxonomy classification, whale detection, miner ID |
| `lib/output-parser.js` | New file — transaction parsing with script analysis |

---

## Deployment

The fork is deployed at `/opt/relay-federation` on the VM. See `BSV-INTEL-INFRASTRUCTURE.md` for full deployment procedures.

Quick deploy:
```bash
gcloud compute ssh openclaw-agent --zone=us-central1-a --command \
  "cd /opt/relay-federation && sudo -u bridget git pull && \
   cd packages/bridge && sudo npm install && sudo npm link && \
   sudo systemctl restart relay-bridge"
```

---

## The Extended Thesis

**Original Relay Federation:** Apps can relay transactions without centralized APIs.

**This fork:** Apps can read and analyze the entire blockchain — every block, every transaction, the full historical record — using their own infrastructure, with no third parties.

The blockchain is a public record. Your bridge is your lens.

# BSV Intel Infrastructure Documentation

**Last Updated:** March 17, 2026
**Author:** Infrastructure notes compiled from development sessions

---

## Executive Summary

The BSV Intel Report system is a self-hosted, peer-to-peer blockchain intelligence platform that generates daily network health reports by scanning BSV blocks directly via the Bitcoin P2P protocol. Unlike traditional approaches that depend on centralized APIs (WhatsOnChain, JungleBus), this infrastructure connects directly to the BSV network through a federated bridge system.

The system runs entirely on a single GCP Compute Engine VM:
- **Compute Engine VM** (`openclaw-agent`): Runs the Relay Federation bridge, BSV scanner, n8n workflows, and Telegram bots

Previously the scanner ran on Cloud Run, but was migrated to the VM on March 15, 2026 for simpler architecture and lower latency.

---

## Architecture Overview

```
                                    BSV P2P Network
                                          |
                                    [MSG_BLOCK]
                                    [MSG_HEADERS]
                                          |
                                          v
                              +-------------------------+
                              |     Compute VM          |
                              |     openclaw-agent      |
                              |     34.122.254.59       |
                              |                         |
                              |  - relay-bridge (:8333) |
                              |  - bsv-scanner (:8085)  |
                              |  - n8n (:5678)          |
                              |  - openclaw (bots)      |
                              +-------------------------+
                                    |           |
                                    v           v
                             [HTML Report]  [Federation Mesh]
                                    |           |
                                    v           v
                              Telegraph.ph   Other Bridges
                                    |        (bridge-alpha,
                                    v         bridge-sendbsv)
                              Telegram Bot
                              @bsv_intel_bot
```

---

## Component Details

### 1. Compute Engine VM: `openclaw-agent`

**Location:** `us-central1-a`
**Machine Type:** e2-medium (2 vCPU, 4 GB RAM)
**OS:** Ubuntu 24.04 LTS
**External IP:** 34.122.254.59
**Cost:** ~$25/month

#### Services Running:

| Service | Port | Description |
|---------|------|-------------|
| `relay-bridge` | 8333 (WSS), 9333 (HTTP) | Federation bridge with P2P block scanning |
| `bsv-scanner` | 8085 | Block scanner and HTML report generator |
| `n8n` | 5678 | Workflow automation for daily reports |
| `openclaw` | - | Telegram bot gateway (@bsv_intel_bot, @traceport_scout_bot) |

#### Relay Federation Bridge (Forked)

**Repository:** `github.com/HBGnostic/relay-federation` (fork of `zcoolz/relay-federation`)
**VM Path:** `/opt/relay-federation` (permanent location, survives reboots)
**Linked via:** `npm link` from `/opt/relay-federation/packages/bridge/`
**Config:** `/home/bridget/.relay-bridge/config.json`
**Data:** `/home/bridget/.relay-bridge/data/` (LevelDB)

> **IMPORTANT:** Always use your fork, NOT the npm package `@relay-federation/bridge`. The fork has custom endpoints (`/block/:height/transactions`, etc.) that the scanner requires.

**Custom Modifications:**

1. **`block-scanner.js`** (new file)
   - Script taxonomy classification (PURPOSE: Payment/Data Publication/Contracts)
   - Structure detection (P2PKH, OP_RETURN, ORDINAL_ENVELOPE, MULTISIG, etc.)
   - Protocol detection (MAP, B://, AIP, TreeChat, Twetch, RUN, etc.)
   - Whale detection (transactions > 100 BSV)
   - Miner identification from coinbase
   - Script of the Day (SOTD) sample collection

2. **`status-server.js`** (modified)
   - Added `/block/:height/scan` endpoint for block scanning
   - Added `/block/:height/transactions` endpoint for raw tx data
   - Removed WhatsOnChain fallback - pure P2P block fetching
   - Added rate limiting (heavy endpoints only: 2 req/min)
   - Dashboard and status endpoints remain unlimited
   - Auth bypass via `Authorization: Bearer <secret>` header

3. **`header-relay.js`** (modified)
   - Added `getHashAtHeight(height)` method for P2P header lookup
   - Enables block hash resolution without external API calls

4. **`output-parser.js`** (new file)
   - Transaction parsing with input/output extraction
   - Script hex preservation for analysis

**Rate Limiting Configuration:**
```javascript
{
  windowMs: 60 * 1000,           // 1 minute window
  maxRequests: 10,               // General requests (not enforced for light endpoints)
  maxHeavyRequests: 2,           // /block/:height/scan, /transactions
  blockDurationMs: 15 * 60 * 1000  // 15 minute block for abuse
}
```

**Heavy Endpoints (rate limited):**
- `/block/:height/scan`
- `/block/:height/transactions`
- `/block/:height/txids`
- `/tx/:txid`
- `/tx/:txid/status`
- `/address/:addr/history`

**Light Endpoints (unlimited):**
- `/` (dashboard)
- `/status`
- `/logs`
- `/mempool`
- `/mempool/history?hours=24` (24h mempool depth samples, stored in LevelDB)

**Rate Limiting Bypass Secret:**
```
BRIDGE_STATUS_SECRET=873b43b5a41ce6307e122de05f8f67226599b6157ffbc8795493971c42c4a432
```
Internal processes (scanner, n8n) bypass rate limiting by including this header:
```
Authorization: Bearer 873b43b5a41ce6307e122de05f8f67226599b6157ffbc8795493971c42c4a432
```

#### Mempool History Storage

The bridge stores mempool snapshots for the 24-hour rolling chart:

| Setting | Value |
|---------|-------|
| Sample interval | Every 10 minutes |
| Retention | 24 hours (older samples auto-pruned) |
| Storage | LevelDB in `/home/bridget/.relay-bridge/data/` |
| Initial sample | Taken immediately on startup |

**Behavior on restart:**
- Historical samples (pre-restart) are preserved in LevelDB
- New sampling begins immediately after restart
- Mempool count starts at 0 until peers relay transactions
- Full peer connectivity typically restored within 1-2 minutes
- Normal mempool levels return as transactions are broadcast

**API:** `GET /mempool/history?hours=24` returns:
```json
{
  "hours": 24,
  "count": 144,
  "samples": [{"ts": 1773699033826, "size": 91, "bytes": 0}, ...]
}
```

#### n8n Workflow Automation

**Service:** `n8n.service`
**Port:** 5678
**Data:** `/home/n8n/.n8n/`

**Daily Report Workflow:**
1. Triggers at scheduled time (daily)
2. Calls Cloud Run scanner with block count (144 = ~24 hours)
3. Receives HTML report
4. Publishes to Telegraph.ph
5. Sends notification via Telegram to subscribers

#### OpenClaw Telegram Gateway

**Service:** `openclaw.service`
**Bots:**
- `@bsv_intel_bot` - BSV network intelligence queries
- `@traceport_scout_bot` - Scout agent for research

**Note:** Stopping OpenClaw has zero impact on daily reports. It only affects interactive bot conversations.

---

### 2. BSV Scanner (VM Service)

**Service:** `bsv-scanner.service`
**Port:** 8085
**Source:** `/home/hummingbird/bsv-scanner/`

> **Note:** Previously ran on Cloud Run (`bsv-scanner-dnev6xbilq-uc.a.run.app`). Migrated to VM on March 15, 2026. Cloud Run service decommissioned.

**Environment Variables (set in systemd service):**
```
PORT=8085
BRIDGE_URL=http://localhost:9333
BRIDGE_STATUS_SECRET=873b43b5a41ce6307e122de05f8f67226599b6157ffbc8795493971c42c4a432
SCANNER_API_KEY=U2x4Tp01ZTi4RmoNGu5dIvYR/QMyF4vw6MoUlALegHI=
```

The scanner connects to the bridge on localhost (both services on same VM), using the secret to bypass rate limiting.

#### Scanner Components:

**`scanner-bridge.js`**
- Entry point for report generation
- Iterates through block range (e.g., 144 blocks)
- Calls bridge `/block/:height/scan` for each block (localhost)
- Aggregates results across all blocks

**`generate-report.js`**
- Takes aggregated scan data
- Generates styled HTML report with:
  - Chain health metrics
  - Block timing analysis (Poisson distribution)
  - Capital flow monitor (whale transactions)
  - Script usage taxonomy (purpose/structure/protocol)
  - Script of the Day educational section
  - Mining distribution charts
  - Mempool history sparkline (24h trend)
  - AI network analysis (via Gemini)
- Dark theme, responsive design

**`server.js`**
- Express server exposing `/scan` and `/generate-report` endpoints
- Listens on port 8085

---

## Data Flow: Daily Report Generation

```
1. n8n Trigger (6:15 AM Central)
         |
         v
2. HTTP Request to local scanner
   POST http://localhost:8085/scan?blocks=144
         |
         v
3. scanner-bridge.js
   For each block height:
         |
         v
4. GET http://localhost:9333/block/{height}/scan
         |
         v
5. Bridge: status-server.js
   - headerRelay.getHashAtHeight(height) -> block hash
   - bsvNodeClient.getBlock(hash) via P2P MSG_BLOCK
   - parseTx() for each transaction
   - scanBlock() for taxonomy/whales/miner
         |
         v
6. Return JSON scan result
   {height, hash, source:"p2p", miner, whales, taxonomy, ...}
         |
         v
7. Aggregate all blocks + fetch /mempool/history
         |
         v
8. generate-report.js -> HTML (with mempool sparkline)
         |
         v
9. Return to n8n
         |
         v
10. Publish to Telegraph.ph
          |
          v
11. Register with Hummingbox paywall
          |
          v
12. Send Telegram notification
```

---

## Script Taxonomy System

The scanner classifies every transaction output into a three-layer taxonomy:

### Layer 1: Purpose (Why does this output exist?)

| Purpose | Description |
|---------|-------------|
| PAYMENT | Transferring value to be spent later |
| DATA_PUBLICATION | Storing/publishing data on-chain |
| CONTRACTS | Programmable conditions beyond simple signatures |

### Layer 2: Structure (How is the script constructed?)

| Structure | Pattern | Purpose |
|-----------|---------|---------|
| P2PKH | `OP_DUP OP_HASH160 <hash> OP_EQUALVERIFY OP_CHECKSIG` | Payment |
| P2PK | `<pubkey> OP_CHECKSIG` | Payment |
| MULTISIG | `OP_n <keys> OP_m OP_CHECKMULTISIG` | Payment |
| OP_RETURN | `OP_RETURN <data>` or `OP_FALSE OP_RETURN <data>` | Data |
| ORDINAL_ENVELOPE | `OP_FALSE OP_IF 6f7264 ... OP_ENDIF` | Data |
| SPENDABLE_METADATA | `<sig check> ... OP_DROP <data>` | Data |
| CUSTOM | Complex scripts with advanced opcodes | Contracts |

### Layer 3: Protocol (What application created this?)

| Protocol | Hex Marker | Description |
|----------|------------|-------------|
| MAP | `3150755161374b36...` | Magic Attribute Protocol (metadata) |
| B:// | `31394878696756...` | File storage protocol |
| AIP | `313550636948473...` | Author Identity Protocol |
| BCAT | `3170726f745647...` | Chunked file protocol |
| TreeChat | `7472656563686174` | Social/messaging |
| Twetch | `7477657463682e636f6d` | Social platform |
| RUN | `72756e` | Token protocol |
| DATA_CARRIER | (fallback) | Generic OP_RETURN |

---

## Miner Identification

The scanner extracts miner identity from the coinbase transaction's scriptSig:

```javascript
const poolPatterns = [
  { pattern: /taal\.com/i, name: 'taal.com' },
  { pattern: /GorillaPool/i, name: 'GorillaPool' },
  { pattern: /Mining-Dutch/i, name: 'Mining-Dutch' },
  { pattern: /molepool\.com/i, name: 'molepool.com' },
  { pattern: /qdlnk/i, name: 'qdlnk' },
  { pattern: /CUVVE/i, name: 'CUVVE' },
  { pattern: /SA100/i, name: 'SA100' },
  // ... more patterns
];
```

Unknown miners return `"unknown"` rather than displaying garbage ASCII from the coinbase.

---

## Federation Mesh

The bridge participates in the Relay Federation mesh network:

**Identity:**
- Mesh ID: `70016`
- Public Key: `031e6ebdfb0be8b1cea0c500755632a2d867fd92ad3a2b9f4ec2c5e0f21f5972d6`
- Endpoint: `ws://34.122.254.59:8333`

**Connected Peers:**
- `bridge-alpha` (Ryan's primary)
- `bridge-sendbsv`
- Others via gossip discovery

**Federation Features Used:**
- Header gossip (sync chain tip across peers)
- Peer discovery via gossip
- Cryptographic handshake (BRC-78 style)

**Federation Features Not Yet Used:**
- Block gossip (sharing full blocks between peers)
- Scan result gossip (sharing analysis without re-scanning)
- Distributed scanning (splitting work across peers)

---

## Security Considerations

### Secrets Management

| Secret | Value/Storage | Used By |
|--------|---------------|---------|
| `BRIDGE_STATUS_SECRET` | `873b43b5a41ce6307e122de05f8f67226599b6157ffbc8795493971c42c4a432` | Scanner, n8n to bypass rate limiting |
| `SCANNER_API_KEY` | `U2x4Tp01ZTi4RmoNGu5dIvYR/QMyF4vw6MoUlALegHI=` | Scanner auth (if needed) |
| `WALLET_SEED` | 1Password (`op://`) | CLI wallet operations |
| Bridge `statusSecret` | Same as BRIDGE_STATUS_SECRET | In `/home/bridget/.relay-bridge/config.json` |
| Bridge private key (WIF) | In config.json | Federation identity |

### Network Security

- Bridge WSS (8333): Open for federation peers
- Bridge HTTP (9333): Open but rate-limited
- n8n (5678): Localhost only
- SSH: Key-based auth only

### Rate Limiting

Protects against:
- Scraping block data to build competing services
- DoS via expensive block scanning
- Freeloading on P2P infrastructure

Does not restrict:
- Dashboard viewing (transparency)
- Status checks (federation health)
- Authenticated scanner requests

---

## Cost Summary

| Component | Monthly Cost |
|-----------|--------------|
| Compute Engine VM (e2-medium) | ~$25 |
| Static IP reservation | ~$3 |
| Cloud SQL (if used) | ~$10 |
| Egress/networking | ~$5 |
| **Total** | **~$43/month** |

> Cloud Run scanner decommissioned March 15, 2026 — saves ~$5/month.

---

## Deployment Procedures

### Deploying Bridge Changes

The bridge uses your fork at `github.com/HBGnostic/relay-federation`, installed at `/opt/relay-federation`.

```bash
# Option 1: Pull latest from GitHub
gcloud compute ssh openclaw-agent --zone=us-central1-a --command \
  "cd /opt/relay-federation && sudo -u bridget git pull && \
   cd packages/bridge && sudo npm install && sudo npm link && \
   sudo systemctl restart relay-bridge"

# Option 2: Copy specific files (for testing)
gcloud compute scp /path/to/file.js openclaw-agent:/tmp/ --zone=us-central1-a
gcloud compute ssh openclaw-agent --zone=us-central1-a --command \
  "sudo cp /tmp/file.js /opt/relay-federation/packages/bridge/lib/ && \
   sudo systemctl restart relay-bridge"

# Verify
gcloud compute ssh openclaw-agent --zone=us-central1-a --command \
  "curl -s http://localhost:9333/status | jq .bridge.name"
# Should return: "bridge-hummingbird"
```

### Deploying Scanner Changes

```bash
# Copy scanner files to VM
gcloud compute scp \
  /Users/hummingbird/bsv-intel-scanner/test-scanner/block-scanner.js \
  /Users/hummingbird/bsv-intel-scanner/test-scanner/scanner-bridge.js \
  /Users/hummingbird/bsv-intel-scanner/test-scanner/server.js \
  /Users/hummingbird/bsv-intel-scanner/test-scanner/generate-report.js \
  /Users/hummingbird/bsv-intel-scanner/test-scanner/faq.html \
  openclaw-agent:/home/hummingbird/bsv-scanner/ --zone=us-central1-a

# Restart scanner service
gcloud compute ssh openclaw-agent --zone=us-central1-a --command \
  "sudo systemctl restart bsv-scanner"

# Verify health
gcloud compute ssh openclaw-agent --zone=us-central1-a --command \
  "curl -s http://localhost:8085/health"
# Should return: {"status":"ok"}

# Test a scan
gcloud compute ssh openclaw-agent --zone=us-central1-a --command \
  "curl -s 'http://localhost:8085/scan?blocks=2' | jq .scanMeta"
```

### Checking Logs

```bash
# Bridge logs
gcloud compute ssh openclaw-agent --zone=us-central1-a --command \
  "sudo journalctl -u relay-bridge -f"

# n8n logs
gcloud compute ssh openclaw-agent --zone=us-central1-a --command \
  "sudo journalctl -u n8n -f"

# Cloud Run logs
gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=bsv-scanner" --limit=50
```

---

## Future Considerations

### Scaling for Large Blocks

As BSV blocks grow beyond 1GB, current infrastructure will need upgrades:

| Block Size | Challenge | Mitigation |
|------------|-----------|------------|
| 100 MB | None | Current setup works |
| 500 MB | Memory pressure | Increase VM to 8GB RAM |
| 1 GB | Timeout issues | Increase to 5-min timeout |
| 4+ GB | OOM crashes | Run local BSV node |

### Federation-Native Solutions

Rather than depending on external APIs, the federation could:

1. **Gossip scan results**: Bridge-alpha scans block, shares 2KB result instead of 100MB block
2. **Distributed scanning**: Split block range across federation members
3. **Shared block cache**: Federation peers serve blocks to each other
4. **Collective BSV nodes**: Some members run full nodes, others query them

This would make the federation self-sufficient - its own JungleBus, owned by no one.

### Ordinal/Inscription Handling

Current approach skips inscription content to avoid memory bloat. Future options:
- Stream-parse inscriptions without buffering
- Store inscription metadata only (content hash, size, type)
- Dedicated inscription indexer as separate service

---

## Appendix: File Locations

### Local Development

| Path | Contents |
|------|----------|
| GitHub: `HBGnostic/relay-federation` | Your forked relay-federation repo |
| `/Users/hummingbird/bsv-intel-scanner/test-scanner/` | Scanner code (deployed to VM) |
| `/Users/hummingbird/brida/` | Documentation and workflows |
| `/Users/hummingbird/hummingbox/` | Wallet, payment gate, and this doc |

### VM Paths

| Path | Contents |
|------|----------|
| `/opt/relay-federation/` | Your fork of relay-federation (git repo) |
| `/opt/relay-federation/packages/bridge/` | Bridge package (npm linked) |
| `/home/bridget/.relay-bridge/` | Bridge data (LevelDB, config) |
| `/home/bridget/.relay-bridge/config.json` | Bridge identity, peers, settings |
| `/home/hummingbird/bsv-scanner/` | Scanner code |
| `/home/n8n/.n8n/` | n8n data and workflows |

### Systemd Services

| Service | Config File |
|---------|-------------|
| `relay-bridge` | `/etc/systemd/system/relay-bridge.service` |
| `bsv-scanner` | `/etc/systemd/system/bsv-scanner.service` |
| `n8n` | `/etc/systemd/system/n8n.service` |
| `openclaw` | `/etc/systemd/system/openclaw.service` |

---

## Appendix: Key API Endpoints

### Bridge Status Server (port 9333)

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/` | GET | No | HTML dashboard |
| `/status` | GET | No | JSON bridge status |
| `/logs` | GET | No | Recent log entries |
| `/mempool` | GET | No | Mempool transactions |
| `/mempool/history` | GET | No | 24h mempool depth samples |
| `/block/:height/scan` | GET | Rate limited | Scan block for taxonomy/whales |
| `/block/:height/transactions` | GET | Rate limited | Full parsed transactions |
| `/block/:height/txids` | GET | Rate limited | List of txids (WoC) |
| `/tx/:txid` | GET | Rate limited | Single transaction |
| `/address/:addr/history` | GET | Rate limited | Address history |

### BSV Scanner (port 8085)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Health check |
| `/scan?blocks=N` | GET | Run scan for N blocks, return JSON |
| `/generate-report` | POST | Generate HTML from scan data + chain data |

---

*Document generated from infrastructure development sessions, March 2026*
*Last updated: March 17, 2026 — Added fork location, mempool history details, rate limiting secret, scanner env vars*

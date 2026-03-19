# Block Scanner Architecture & P2P Migration

## Overview

This document describes the block scanning infrastructure, the migration from WhatsOnChain to direct P2P, and the backpressure fix that made 24-hour block reports possible.

---

## The Processing Chain

```
n8n                    →  Just triggers, no processing
    ↓
server.js              →  HTTP routing only (receives /scan request)
    ↓
scanner-bridge.js      →  Fetches raw data from bridge, loops through blocks
    ↓
block-scanner.js       →  ⭐ THE ACTUAL PROCESSING ⭐
    ↓
generate-report.js     →  Turns processed data into HTML
```

### Component Breakdown

| File | Port | What It Does |
|------|------|--------------|
| **n8n** | 5678 | Cron job that calls `/scan?blocks=144` once a day. No logic. |
| **server.js** | 8085 | Express server. Routes `/scan` → `runScan()`. That's it. |
| **scanner-bridge.js** | - | Loops through blocks, calls bridge for raw tx data, passes to `scanBlock()` |
| **block-scanner.js** | - | Does all the work: whale detection, script taxonomy (P2PKH, OP_RETURN, ordinals), protocol detection (MAP, B://, TreeChat), miner ID extraction |
| **generate-report.js** | - | Takes the processed JSON and builds the HTML report |
| **relay-bridge** | 9333 | Fetches blocks from BSV P2P network, streams as NDJSON |

**The Answer:** Your JavaScript in `block-scanner.js` does all the real processing. n8n is just a scheduler. The bridge just fetches raw block bytes from P2P peers and parses them into JSON. All the intelligence (taxonomy, whale detection, protocol classification) lives in `block-scanner.js`.

---

## Architecture: Before vs After

### Old Approach (WhatsOnChain WebSocket)

**File:** `test-scanner.js`

1. Called WhatsOnChain API to get the current chain height
2. Opened a WebSocket connection to WhatsOnChain:
   ```
   wss://socket-v2.whatsonchain.com/websocket/block/transactions?from=X&to=Y
   ```
3. WhatsOnChain streamed every transaction in those blocks over the WebSocket
4. Scanner parsed and analyzed each transaction as it arrived

| Pros | Cons |
|------|------|
| Simple, no infrastructure needed | Dependent on WhatsOnChain's servers |
| | Rate limits |
| | Potential downtime |

### New Approach (Relay Bridge / P2P)

**File:** `scanner-bridge.js`

1. Connect to your own bridge at `http://localhost:9333`
2. Bridge connects to BSV peers via the Bitcoin P2P protocol (MSG_BLOCK messages)
3. Request blocks directly: `GET /block/:height/transactions`
4. Bridge fetches from peers, parses, and returns NDJSON stream

| Pros | Cons |
|------|------|
| You own the infrastructure | You run the relay-bridge yourself |
| No external API dependencies | |
| Connect directly to the BSV network | |

### The Core Change

```
┌───────────────────────────────────────┬──────────────────────────────────────────────────┐
│                Before                 │                      After                       │
├───────────────────────────────────────┼──────────────────────────────────────────────────┤
│ WhatsOnChain WebSocket → Your scanner │ BSV P2P Network → Your bridge → Your scanner     │
├───────────────────────────────────────┼──────────────────────────────────────────────────┤
│ Centralized service                   │ Peer-to-peer, decentralized                      │
├───────────────────────────────────────┼──────────────────────────────────────────────────┤
│ wss://socket-v2.whatsonchain.com/...  │ http://localhost:9333/block/:height/transactions │
└───────────────────────────────────────┴──────────────────────────────────────────────────┘
```

**Key insight:** You cut out the middleman. Instead of asking WhatsOnChain "give me all transactions in block X," your bridge asks BSV peers directly via the raw Bitcoin protocol.

---

## The Backpressure Fix

### The Problem

When streaming large blocks (10,000+ transactions), the relay-bridge was writing data faster than the client (N8N/scanner) could consume it.

**Before (broken):**
```javascript
for (const tx of block.transactions) {
  res.write(data)  // Blast data as fast as possible, ignore if client is overwhelmed
}
```

Node.js buffers writes internally. When the buffer fills up, `res.write()` returns `false` as a signal to stop. The old code ignored this signal and kept blasting data. Eventually the connection would fail.

### The Solution

**After (working):**
```javascript
for (const tx of block.transactions) {
  const canContinue = res.write(data)  // Check if buffer is full
  if (!canContinue) {
    await new Promise(resolve => res.once('drain', resolve))  // Wait for client to catch up
  }
}
```

The fix makes the server pause and wait whenever the client says "hold on, I'm still processing." Once the client catches up and the pipe drains, the server continues.

### Location

**File:** `packages/bridge/lib/status-server.js` (lines 1003-1007)

```javascript
// Handle backpressure: if buffer is full, wait for drain
const canContinue = res.write(data)
if (!canContinue) {
  await new Promise(resolve => res.once('drain', resolve))
}
```

---

## System Capacity Analysis

### Current VM Specs

- **Machine type:** e2-medium (Google Cloud Economy tier)
- **vCPUs:** 2 (shared/burstable)
- **RAM:** 4 GB total, ~1.6 GB available
- **Disk:** 30 GB

### How Memory Is Used During Block Processing

```
_onBlock (payload) {
  // payload = ENTIRE BLOCK in memory (raw bytes)

  const transactions = []

  for (let i = 0; i < txCount; i++) {
    const txBuf = payload.subarray(txStart, offset)
    const rawHex = txBuf.toString('hex')  // Converts to hex STRING (2x size!)
    transactions.push({ txid, rawHex })   // Stores in array
  }

  // Returns the ENTIRE array of ALL transactions
  pending.resolve({ blockHash, header, transactions })
}
```

**Memory multiplier for a block:**
1. Raw block arrives: X bytes
2. Hex conversion (2x): 2X bytes
3. Object overhead + JSON: ~1X bytes
4. **Total: ~4X the raw block size**

### Observed Block Sizes

| Block | Transactions | Actual Size | Memory Usage |
|-------|-------------|-------------|--------------|
| 940834 | 11,132 | 8.2 MB | ~33 MB |
| 940970 | 10,827 | 7.0 MB | ~28 MB |
| 940894 | 21,318 | 18.9 MB | ~70 MB |

### Capacity Limits

| Block Size | Your System (1.6 GB RAM) |
|------------|--------------------------|
| 18 MB (current max seen) | ~70 MB RAM (4%) |
| 100 MB | ~400 MB RAM (25%) |
| 400 MB | ~1.6 GB RAM (100%) |
| 638 MB | Would crash |
| 3.8 GB | Would definitely crash |

### Historical Largest BSV Blocks

| Date | Block Size | Transactions |
|------|-----------|--------------|
| Mar 2019 | 128 MB | - |
| May 2020 | 369 MB | 1.3 million |
| Mar 2021 | 638 MB | - |
| Aug 2021 | 1.247 GB | - |
| Feb 2024 | **3.8 GB** | 188,101 |

**Note:** The 3.8 GB block only had 188,101 transactions - it was full of large data (files, images), not typical payment transactions.

### Current BSV Usage

- Current TPS: ~18 transactions/second
- Average block: ~4,400 transactions
- Largest seen in 6 hours: 21,318 transactions (18.9 MB)
- **You're using ~4% of your system's capacity**

### Upgrade Path

To handle 500+ MB blocks (future-proofing for BSV growth):
- Upgrade to **e2-standard-8** (32 GB RAM) = ~20x current capacity
- Or implement true streaming (parse and send transactions without buffering the full block)

---

## Data Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              FULL DATA FLOW                                      │
└─────────────────────────────────────────────────────────────────────────────────┘

  ┌─────────┐      ┌─────────────┐      ┌──────────────┐      ┌─────────────────┐
  │  n8n    │      │  server.js  │      │ scanner-     │      │  relay-bridge   │
  │  :5678  │ ───► │    :8085    │ ───► │ bridge.js    │ ───► │     :9333       │
  │         │      │             │      │              │      │                 │
  │  Cron   │      │  Express    │      │  Block loop  │      │  P2P client     │
  │  trigger│      │  routing    │      │  orchestrator│      │  NDJSON stream  │
  └─────────┘      └─────────────┘      └──────────────┘      └────────┬────────┘
                                               │                       │
                                               │                       ▼
                                               │               ┌───────────────┐
                                               │               │  BSV P2P      │
                                               │               │  Network      │
                                               │               │  (MSG_BLOCK)  │
                                               │               └───────────────┘
                                               ▼
                                       ┌──────────────┐
                                       │ block-       │
                                       │ scanner.js   │
                                       │              │
                                       │ • Whale      │
                                       │   detection  │
                                       │ • Script     │
                                       │   taxonomy   │
                                       │ • Protocol   │
                                       │   detection  │
                                       └──────┬───────┘
                                               │
                                               ▼
                                       ┌──────────────┐
                                       │ generate-    │
                                       │ report.js    │
                                       │              │
                                       │ JSON → HTML  │
                                       └──────┬───────┘
                                               │
                                               ▼
                                       ┌──────────────┐
                                       │  AI Summary  │
                                       │  (Claude)    │
                                       │              │
                                       │  Natural     │
                                       │  language    │
                                       │  analysis    │
                                       └──────────────┘
```

---

## Language Stack

| Component | Language |
|-----------|----------|
| relay-bridge | JavaScript (Node.js) |
| scanner-bridge.js | JavaScript (Node.js) |
| block-scanner.js | JavaScript (Node.js) |
| generate-report.js | JavaScript (Node.js) |
| server.js | JavaScript (Node.js/Express) |
| n8n workflow | Visual (no code) |
| AI summarization | Natural language prompt |

**It's JavaScript all the way down until you hit the AI part.**

---

## Key Files Location

```
/home/hummingbird/                          # VM (openclaw-agent)
├── server.js                               # Scanner HTTP server
├── scanner-bridge.js                       # Bridge client, block loop
├── block-scanner.js                        # Core processing logic
└── generate-report.js                      # HTML report generation

/usr/lib/node_modules/@relay-federation/bridge/
└── lib/
    ├── status-server.js                    # Bridge HTTP endpoints (backpressure fix here)
    └── bsv-peer.js                         # P2P protocol implementation
```

---

## Summary

1. **You cut out the middleman** - Direct P2P instead of WhatsOnChain
2. **Backpressure fix** - Three lines of code to respect flow control
3. **Current capacity** - Handling ~4% of max, plenty of headroom
4. **All JavaScript** - From P2P protocol to HTML reports
5. **n8n is just a cron** - All intelligence lives in block-scanner.js

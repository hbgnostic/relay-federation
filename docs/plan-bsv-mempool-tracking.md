# Plan: BSV P2P Mempool Tracking

## Problem

The current mempool tracking in the bridge shows **federation relay activity** (6-30 txs), not the **actual BSV network mempool** (thousands of txs).

- `txRelay.mempool` = transactions relayed between federation peers
- What we want = transactions announced by BSV P2P nodes

The report's mempool section (big number + sparkline) is showing the wrong data.

---

## Solution

Add mempool tracking to `bsv-peer.js` by listening for `inv` messages with `MSG_TX` type.

### How BSV P2P Mempool Works

1. When a new transaction enters a BSV node's mempool, it sends an `inv` message to peers
2. `inv` message format: `count (varint) + entries[]`
3. Each entry: `type (4 bytes) + hash (32 bytes)`
4. Type 1 = `MSG_TX` (transaction announcement)
5. When a block is mined, those txids leave the mempool

---

## Code Changes

### File 1: `packages/bridge/lib/bsv-peer.js`

**Add mempool tracking state (in constructor):**
```javascript
/** @type {Set<string>} txids currently in mempool */
this._mempoolTxids = new Set()
```

**Add getter for mempool size:**
```javascript
/** Current mempool size (txids seen but not yet confirmed) */
get mempoolSize () { return this._mempoolTxids.size }

/** Get all mempool txids */
get mempoolTxids () { return this._mempoolTxids }
```

**Modify `_onInv()` to handle MSG_TX:**
```javascript
_onInv (payload) {
  const count = readVarInt(payload, 0)
  let offset = count.size

  for (let i = 0; i < count.value; i++) {
    const type = payload.readUInt32LE(offset)
    const hash = payload.subarray(offset + 4, offset + 36)
    const hashHex = internalToHash(hash)
    offset += 36

    if (type === 1) {
      // MSG_TX — new mempool transaction
      if (!this._mempoolTxids.has(hashHex)) {
        this._mempoolTxids.add(hashHex)
        this.emit('mempool:tx', { txid: hashHex })
      }
    } else if (type === 2) {
      // MSG_BLOCK — existing handling
      this.emit('inv:block', { blockHash: hashHex })
    }
  }
}
```

**Modify `_onBlock()` to clear confirmed txids:**
```javascript
_onBlock (payload) {
  // ... existing parsing code ...

  // Remove confirmed transactions from mempool tracking
  for (const tx of transactions) {
    this._mempoolTxids.delete(tx.txid)
  }

  // ... rest of existing code ...
}
```

**Add periodic cleanup (optional, prevent unbounded growth):**
```javascript
// In constructor, add cleanup timer
this._mempoolCleanupTimer = setInterval(() => {
  // If mempool grows too large, trim oldest entries
  // (Simple approach: clear if over 100k, let it rebuild)
  if (this._mempoolTxids.size > 100000) {
    this._mempoolTxids.clear()
  }
}, 60000)
```

---

### File 2: `packages/bridge/lib/bsv-node-client.js`

**Add aggregated mempool size getter:**
```javascript
/**
 * Get total mempool size across all connected BSV peers.
 * Uses a Set to dedupe txids seen by multiple peers.
 */
get mempoolSize () {
  const allTxids = new Set()
  for (const peer of this._peers.values()) {
    for (const txid of peer.mempoolTxids) {
      allTxids.add(txid)
    }
  }
  return allTxids.size
}
```

---

### File 3: `packages/bridge/cli.js`

**Change mempool sampling source (around line 510):**
```javascript
// BEFORE:
const size = txRelay.mempool.size
await store.putMempoolSample(size)

// AFTER:
const size = bsvNodeClient.mempoolSize
await store.putMempoolSample(size)
```

---

### File 4: `packages/bridge/lib/status-server.js`

**Update status endpoint to show BSV mempool (around line 151):**
```javascript
// BEFORE:
mempool: this._txRelay ? this._txRelay.mempool.size : 0,

// AFTER (add both):
federationMempool: this._txRelay ? this._txRelay.mempool.size : 0,
bsvMempool: this._bsvNodeClient ? this._bsvNodeClient.mempoolSize : 0,
```

---

## Estimated Effort

| File | Changes | Lines |
|------|---------|-------|
| bsv-peer.js | Add mempool tracking, modify _onInv, modify _onBlock | ~40 lines |
| bsv-node-client.js | Add aggregated getter | ~10 lines |
| cli.js | Change sampling source | ~2 lines |
| status-server.js | Add bsvMempool to status | ~5 lines |
| **Total** | | **~60 lines** |

---

## Caveats

1. **Not 100% of network mempool** — You only see txids announced by your connected peers (currently 15). This is a representative sample, not exhaustive.

2. **Memory usage** — At high TPS, the Set could grow large. The cleanup timer prevents unbounded growth.

3. **Txids only, not full txs** — We're tracking txid count, not fetching full transaction data. This is intentional for efficiency.

4. **Block confirmation lag** — Txids are only removed when you receive the full block. There may be a brief lag where a confirmed tx is still counted.

---

## Testing

1. Start bridge, watch `mempoolSize` grow as inv messages arrive
2. When a block is mined, verify `mempoolSize` decreases
3. Check `/mempool/history` shows realistic numbers (hundreds to thousands, not 6-30)
4. Compare against WhatsOnChain mempool count for sanity check

---

## Future Enhancements

- Track mempool bytes (would require fetching tx sizes)
- Emit events for mempool threshold alerts
- Add `/mempool/txids` endpoint to list current mempool
- Track fee rates for fee estimation

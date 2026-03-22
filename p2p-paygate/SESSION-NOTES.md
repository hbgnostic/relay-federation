# P2P Paygate Session Notes — March 20, 2026

## Summary

Got the P2P Paygate working with relay bridge payment detection. Fixed several bugs in the bridge's address history caching and WoC fallback.

## What We Built

**p2p-paygate** — A pay-per-view content gate that:
1. Generates unique BSV addresses per session (HMAC-SHA256 derived from seed)
2. Polls the relay bridge for payment detection
3. Unlocks gated content when payment is found
4. Can sweep funds to a collection address via P2P broadcast

## Bugs Fixed

### 1. Bridge returns `hash160` not `address` in tx outputs
**File:** `lib/bridge.js`
**Fix:** Added `_addressToHash160()` helper to convert address to hash160 for matching

### 2. Bridge caches empty address history results
**File:** `packages/bridge/lib/status-server.js` (remote)
**Problem:** If paygate polls before payment arrives, bridge caches `[]` for 60 seconds
**Fix:** Only cache non-empty results:
```javascript
if (history.length > 0) {
  this._addressCache.set(cacheKey, { data: history, time: Date.now() })
}
```

### 3. Bridge only fetches confirmed history from WoC
**File:** `packages/bridge/lib/status-server.js` (remote)
**Problem:** Was using `/confirmed/history` which excludes mempool txs
**Fix:** Changed to `/history` which includes mempool (height: -1)
```javascript
// Before:
'/address/' + addr + '/confirmed/history'
// After:
'/address/' + addr + '/history'
```

## Payments Made (Need Recovery)

Session addresses with funds — derive keys using seed from `config.js`:

| Address | Satoshis | TxID | Status |
|---------|----------|------|--------|
| 1C5K9eBqou4JrPiMeZGfqyyjoZ5125E1Dj | 1000 | 59ef5bcc349d02ba6a0ef1d5e2e060115ccfb2e0cb3d08336db77e7ac11f3f6d | Confirmed (block 941262) |
| 1Dgb5XxMgUxwL3JnXyJFS42cBvmyF5nz8h | 1000 | 22900c15f45c60fa38953effde2c1d200fa2bf95b72b9ee7e4fcec80e4a20912 | Mempool |

**Note:** You may have made additional payments. Check your wallet history.

## Key Derivation Scheme

**NOT BRC-42** — Uses simple HMAC-SHA256:

```javascript
privateKey = HMAC-SHA256(seed, "p2p-paygate:{sessionId}")
```

Where:
- `seed` is the 64-char hex string from `config.js`
- `sessionId` is the 32-char hex session ID shown in the gate UI

## How to Recover Funds

Run this script to sweep all funds to your wallet:

```javascript
// recover-funds.js
import { PrivateKey, Hash, P2PKH, Transaction, SatoshisPerKilobyte } from '@bsv/sdk'

// Your seed from config.js
const SEED = 'YOUR_SEED_HEX_HERE'

// Where to send the recovered funds
const DESTINATION = 'YOUR_BSV_ADDRESS_HERE'

// Sessions that received payments (sessionId → { txid, vout, satoshis })
const SESSIONS = [
  // Add your sessions here - you'll need the session IDs from server logs
  // or derive them by checking addresses
]

function deriveKey(seedHex, label) {
  const seedBuf = Buffer.from(seedHex, 'hex')
  const hmac = Hash.sha256hmac(Buffer.from(label, 'utf8'), seedBuf)
  return PrivateKey.fromString(Buffer.from(hmac).toString('hex'), 'hex')
}

async function recoverSession(sessionId, txid, vout, satoshis) {
  const privateKey = deriveKey(SEED, `p2p-paygate:${sessionId}`)

  // Fetch raw tx from bridge
  const resp = await fetch(`http://34.122.254.59:9333/tx/${txid}/hex`)
  const rawHex = await resp.text()
  const sourceTx = Transaction.fromHex(rawHex)

  const tx = new Transaction()
  tx.addInput({
    sourceTransaction: sourceTx,
    sourceOutputIndex: vout,
    unlockingScriptTemplate: new P2PKH().unlock(privateKey),
  })
  tx.addOutput({
    lockingScript: new P2PKH().lock(DESTINATION),
    change: true,
  })
  tx.fee(new SatoshisPerKilobyte(1))
  tx.sign()

  // Broadcast via bridge
  const broadcast = await fetch('http://34.122.254.59:9333/broadcast', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rawHex: tx.toHex() })
  })

  console.log(`Swept ${satoshis} sats from session ${sessionId}`)
  console.log(`TxID: ${tx.id('hex')}`)
}
```

**Problem:** Session IDs are ephemeral (in-memory). If the server restarted, you lost the mapping.

**Alternative recovery:** Brute-force derive addresses and check balances:

```javascript
// brute-force-recover.js
// If you know approximately when payments were made, generate session IDs
// and check which addresses have funds

import crypto from 'crypto'

function deriveAddress(seed, sessionId) {
  // ... derive and return address
}

// Generate candidate session IDs and check each one against WoC
```

## P2P vs WoC Fallback

**Current state:** Payment detection uses WoC fallback because:
1. Wallet broadcasts directly to BSV network, not through mesh
2. Bridge's local mempool only has txs that came through mesh
3. `?p2p=true` mode only scans local mempool

**For true P2P detection:**
- Option A: Wallet broadcasts through bridge `/broadcast` endpoint
- Option B: Add mesh `mempool_scan` protocol (bridges query each other by address)

## Files Modified

### Local (p2p-paygate/)
- `lib/bridge.js` — Added hash160 matching, removed `?p2p=true`

### Remote (openclaw-agent bridge)
- `/opt/relay-federation/packages/bridge/lib/status-server.js`
  - Don't cache empty address history results
  - Use `/history` instead of `/confirmed/history` for WoC fallback

## Next Steps

1. **Set collection address** in `config.js` for auto-sweep
2. **Recover test payments** using session IDs (if you have them)
3. **Consider Hummingbox integration** — add custom broadcast endpoint option
4. **True P2P detection** — implement mesh `mempool_scan` protocol

## Commands Reference

```bash
# Start paygate locally
node server.js

# Check address history on bridge
curl "http://34.122.254.59:9333/address/ADDRESS/history"

# Check mempool
curl "http://34.122.254.59:9333/mempool"

# Restart remote bridge
gcloud compute ssh openclaw-agent --zone=us-central1-a --command="sudo systemctl restart relay-bridge"

# Deploy status-server.js update
gcloud compute scp ../packages/bridge/lib/status-server.js openclaw-agent:~/status-server.js --zone=us-central1-a
gcloud compute ssh openclaw-agent --zone=us-central1-a --command="sudo mv ~/status-server.js /opt/relay-federation/packages/bridge/lib/status-server.js && sudo chmod 644 /opt/relay-federation/packages/bridge/lib/status-server.js && sudo systemctl restart relay-bridge"
```

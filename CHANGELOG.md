# Changelog

## 2026-03-21

### P2P Paygate
- Added standalone P2P payment gateway (`p2p-paygate/`)
- Session persistence to `sessions.json` - survives server restarts and crashes
- Auto-sweep: payments automatically move from session addresses to collection address
- Pure P2P payment detection via bridge mempool scanning (no WhatsOnChain dependency)
- Deterministic address derivation from seed using HMAC-SHA256
- Fund recovery tools (`recover-funds.js`)

### Bridge Fixes
- Fixed address history caching: empty results no longer cached (retry immediately)
- Fixed WoC fallback endpoint (`/history` instead of `/confirmed/history`)
- Added `signHash` import to data-relay

### Dashboard
- Added whale/capital flow visualization styles to onchain explorer

---

## 2026-03-20

### v0.3.15 Merge
- Merged upstream v0.3.15: network improvements + payment middleware
- **Critical fix**: Relay flag in BSV P2P handshake now set to 1 (was 0)
  - Bridge was telling BSV nodes "don't send me transaction announcements"
  - Now receives all mempool tx announcements via INV messages
- Dashboard: network activity display
- Dashboard: system stats card, RSS sparkline, poll lock

### P2P Mempool Scanning
- Added `?p2p=true` parameter to address history endpoint
- Scans live mempool for transactions to watched addresses
- Enables instant payment detection without WoC

---

## Earlier

### v0.3.14
- Shared header store with O(1) reverse hash lookup
- Backpressure handling for large block streaming
- Stream block transactions as NDJSON for memory efficiency
- Retry logic and load distribution for P2P block/tx fetching

### SDK v0.2.0
- Session, raw tx, and UTXO methods
- Header service URL config for traceport integration

---

## Architecture Notes

### P2P Payment Flow
```
User pays → BSV network → Bridge sees INV → tracks txid in "known"
                                ↓
                        Address history scan finds tx in mempool
                                ↓
                        Paygate detects payment, grants access
                                ↓
                        Auto-sweep to collection address
```

### Mempool Sharing (Mesh)
- Bridges share transactions via `tx_announce` → `tx_request` → `tx`
- `known` = txids seen via BSV P2P INV (lightweight, 32 bytes each)
- `mempool` = full transactions from user broadcasts or mesh peers
- Not the entire chain mempool - only relevant transactions

/**
 * Relay Bridge Client
 * Talks to a relay bridge HTTP API for P2P payment detection and Merkle proofs.
 * No WhatsOnChain. No ARC. Just the bridge.
 */

export class BridgeClient {
  constructor(baseUrl, authSecret) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.authSecret = authSecret || null
  }

  async _fetch(path) {
    const url = `${this.baseUrl}${path}`
    const headers = { 'Accept': 'application/json' }
    // Auth header bypasses rate limiting on the bridge
    if (this.authSecret) {
      headers['Authorization'] = `Bearer ${this.authSecret}`
    }
    const resp = await fetch(url, { headers, signal: AbortSignal.timeout(10000) })
    if (!resp.ok) {
      const body = await resp.text().catch(() => '')
      throw new Error(`Bridge ${resp.status}: ${body}`)
    }
    return resp.json()
  }

  /** Bridge status: peers, headers, mempool */
  async getStatus() {
    return this._fetch('/status')
  }

  /**
   * Address history from the bridge — pure P2P, no WoC fallback.
   * Returns { address, history: [{ tx_hash, height }], cached, p2p: true }
   */
  async getAddressHistory(address) {
    return this._fetch(`/address/${address}/history`)
  }

  /**
   * Full parsed transaction.
   * Returns { txid, inputs, outputs, ... } where outputs have { address, satoshis, ... }
   */
  async getTx(txid) {
    return this._fetch(`/tx/${txid}`)
  }

  /**
   * Transaction lifecycle status.
   * Returns { txid, state: 'mempool'|'confirmed'|..., block?: { height, hash } }
   */
  async getTxStatus(txid) {
    return this._fetch(`/tx/${txid}/status`)
  }

  /**
   * Merkle proof for a confirmed transaction.
   * Returns { txid, blockHash, height, proof: { nodes[], index } }
   */
  async getProof(txid) {
    return this._fetch(`/proof/${txid}`)
  }

  /**
   * Check if address received payment >= minSats.
   * Polls bridge address history and inspects tx outputs.
   * Returns { found, txid?, satoshis?, height? }
   */
  async checkPayment(address, minSats) {
    try {
      // Convert address to hash160 for matching
      const addressHash160 = this._addressToHash160(address)

      const data = await this.getAddressHistory(address)
      const history = data.history || data
      if (!Array.isArray(history) || history.length === 0) {
        return { found: false }
      }

      for (const entry of history) {
        const txid = entry.tx_hash || entry.txid
        if (!txid) continue

        try {
          const tx = await this.getTx(txid)
          if (!tx || !tx.outputs) continue

          for (const out of tx.outputs) {
            // Match by hash160 (bridge returns hash160, not address)
            const match = out.hash160 === addressHash160 || out.address === address
            if (match && out.satoshis >= minSats) {
              return {
                found: true,
                txid,
                satoshis: out.satoshis,
                height: entry.height > 0 ? entry.height : null
              }
            }
          }
        } catch {
          continue
        }
      }

      return { found: false }
    } catch {
      return { found: false }
    }
  }

  /** Convert a base58check address to hash160 hex */
  _addressToHash160(address) {
    const bs58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
    let num = 0n
    for (const c of address) num = num * 58n + BigInt(bs58.indexOf(c))
    const hex = num.toString(16).padStart(50, '0')
    return hex.slice(2, 42)
  }
}

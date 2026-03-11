/**
 * @relay-federation/sdk — JavaScript client for the Federated SPV Relay Mesh.
 *
 * Connect to any bridge and query transactions, inscriptions, mempool,
 * broadcast raw transactions, and discover other bridges on the mesh.
 *
 * Usage:
 *   import { RelayBridge } from '@relay-federation/sdk'
 *   const bridge = new RelayBridge('http://144.202.48.217:9333')
 *   const tx = await bridge.getTx('abc123...')
 */

export class RelayBridge {
  /**
   * Create a bridge client.
   *
   * @param {string} baseUrl — Bridge status server URL (e.g. "http://144.202.48.217:9333")
   * @param {object} [opts]
   * @param {string} [opts.auth] — Operator statusSecret for authenticated endpoints
   * @param {number} [opts.timeout=10000] — Request timeout in ms
   */
  constructor (baseUrl, opts = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this._auth = opts.auth || null
    this._timeout = opts.timeout || 10000
  }

  // ─── Public Endpoints ───────────────────────────────────────

  /**
   * Get bridge status (peers, headers, mempool stats, BSV node info).
   * Returns operator fields (wallet, address) when authenticated.
   *
   * @returns {Promise<object>}
   */
  async getStatus () {
    return this._get('/status')
  }

  /**
   * Get all transactions in the bridge mempool, parsed with protocol support.
   *
   * @returns {Promise<{ count: number, txs: Array }>}
   */
  async getMempool () {
    return this._get('/mempool')
  }

  /**
   * Fetch and parse a transaction by txid.
   * Checks mempool → BSV P2P → WhatsOnChain fallback.
   *
   * @param {string} txid — 64-character hex transaction ID
   * @returns {Promise<{ txid: string, source: string, size: number, inputs: Array, outputs: Array }>}
   */
  async getTx (txid) {
    if (!txid || txid.length !== 64) {
      throw new Error('txid must be a 64-character hex string')
    }
    return this._get(`/tx/${txid}`)
  }

  /**
   * Broadcast a raw transaction to all connected mesh peers.
   *
   * @param {string} rawHex — Raw transaction hex
   * @returns {Promise<{ txid: string, peers: number }>}
   */
  async broadcast (rawHex) {
    if (!rawHex || typeof rawHex !== 'string') {
      throw new Error('rawHex is required')
    }
    return this._post('/broadcast', { rawHex })
  }

  /**
   * Query indexed on-chain inscriptions.
   *
   * @param {object} [filters]
   * @param {string} [filters.mime] — Filter by content type (e.g. "image/png")
   * @param {string} [filters.address] — Filter by receiving address
   * @param {number} [filters.limit=50] — Max results (capped at 200)
   * @returns {Promise<{ total: number, count: number, inscriptions: Array, filters: object }>}
   */
  async getInscriptions (filters = {}) {
    const params = new URLSearchParams()
    if (filters.mime) params.set('mime', filters.mime)
    if (filters.address) params.set('address', filters.address)
    if (filters.limit) params.set('limit', String(filters.limit))
    const qs = params.toString()
    return this._get('/inscriptions' + (qs ? '?' + qs : ''))
  }

  /**
   * Get raw inscription content as an ArrayBuffer.
   *
   * @param {string} txid — Transaction ID containing the inscription
   * @param {number} vout — Output index
   * @returns {Promise<{ data: ArrayBuffer, contentType: string }>}
   */
  async getInscriptionContent (txid, vout) {
    const res = await this._fetch(`/inscription/${txid}/${vout}/content`)
    if (!res.ok) {
      throw new BridgeError(res.status, await res.text())
    }
    return {
      data: await res.arrayBuffer(),
      contentType: res.headers.get('content-type') || 'application/octet-stream'
    }
  }

  /**
   * Get transaction history for a BSV address.
   *
   * @param {string} address — Base58 BSV address
   * @returns {Promise<{ address: string, history: Array, cached: boolean }>}
   */
  async getAddressHistory (address) {
    if (!address || address.length < 25 || address.length > 35) {
      throw new Error('Invalid BSV address')
    }
    return this._get(`/address/${address}/history`)
  }

  /**
   * Discover all bridges known to this node (self + gossip directory).
   *
   * @returns {Promise<{ count: number, bridges: Array<{ pubkeyHex: string, endpoint: string, meshId: string, statusUrl: string }> }>}
   */
  async discover () {
    return this._get('/discover')
  }

  /**
   * Get health, SSL, and usage data for apps configured on this bridge.
   *
   * @returns {Promise<{ apps: Array }>}
   */
  async getApps () {
    return this._get('/apps')
  }

  // ─── Operator Endpoints (require auth) ──────────────────────

  /**
   * Start on-chain bridge registration. Returns a job ID for progress tracking.
   * Requires authentication.
   *
   * @returns {Promise<{ jobId: string, stream: string }>}
   */
  async register () {
    return this._post('/register', {}, true)
  }

  /**
   * Start on-chain bridge deregistration. Returns a job ID.
   * Requires authentication.
   *
   * @param {string} [reason='shutdown'] — Reason for deregistration
   * @returns {Promise<{ jobId: string, stream: string }>}
   */
  async deregister (reason = 'shutdown') {
    return this._post('/deregister', { reason }, true)
  }

  /**
   * Store a funding transaction. Parses outputs paying to the bridge address.
   * Requires authentication.
   *
   * @param {string} rawHex — Raw funding transaction hex
   * @returns {Promise<{ stored: number, balance: number }>}
   */
  async fund (rawHex) {
    if (!rawHex || typeof rawHex !== 'string') {
      throw new Error('rawHex is required')
    }
    return this._post('/fund', { rawHex }, true)
  }

  /**
   * Connect to a peer endpoint and perform cryptographic handshake.
   * Requires authentication.
   *
   * @param {string} endpoint — WebSocket endpoint (e.g. "ws://45.63.77.31:8333")
   * @returns {Promise<{ endpoint: string, status: string }>}
   */
  async connect (endpoint) {
    if (!endpoint) {
      throw new Error('endpoint is required')
    }
    return this._post('/connect', { endpoint }, true)
  }

  /**
   * Send BSV from the bridge wallet.
   * Requires authentication.
   *
   * @param {string} toAddress — Destination BSV address
   * @param {number} amount — Amount in satoshis (minimum 546)
   * @returns {Promise<{ jobId: string, stream: string }>}
   */
  async send (toAddress, amount) {
    if (!toAddress) throw new Error('toAddress is required')
    if (!amount || amount < 546) throw new Error('amount must be at least 546 satoshis')
    return this._post('/send', { toAddress, amount }, true)
  }

  /**
   * Scan a BSV address for inscriptions. Returns when complete.
   * Requires authentication.
   *
   * @param {string} address — BSV address to scan
   * @param {function} [onProgress] — Optional callback for progress events
   * @returns {Promise<{ scanned: number, found: number, indexed: number }>}
   */
  async scanAddress (address, onProgress) {
    if (!address) throw new Error('address is required')

    const res = await this._fetch('/scan-address', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address })
    })

    if (!res.ok) {
      const body = await res.text()
      throw new BridgeError(res.status, body)
    }

    // Parse SSE stream
    const text = await res.text()
    const lines = text.split('\n')
    let result = null

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      try {
        const event = JSON.parse(line.slice(6))
        if (event.phase === 'complete') {
          result = event.result
        } else if (onProgress) {
          onProgress(event)
        }
      } catch {}
    }

    return result
  }

  /**
   * Rebuild inscription secondary indexes.
   * Requires authentication.
   *
   * @returns {Promise<{ rebuilt: number }>}
   */
  async rebuildInscriptionIndex () {
    return this._post('/rebuild-inscription-index', {}, true)
  }

  /**
   * Get job progress (for register, deregister, send).
   *
   * @param {string} jobId — Job ID from an async operation
   * @returns {Promise<Array<{ type: string, message: string, timestamp: number }>>}
   */
  async getJob (jobId) {
    const res = await this._fetch(`/jobs/${jobId}`)
    if (!res.ok) {
      throw new BridgeError(res.status, await res.text())
    }
    // Parse SSE stream into events array
    const text = await res.text()
    const events = []
    for (const line of text.split('\n')) {
      if (!line.startsWith('data: ')) continue
      try { events.push(JSON.parse(line.slice(6))) } catch {}
    }
    return events
  }

  // ─── Internal ───────────────────────────────────────────────

  /**
   * Build full URL with optional auth.
   * @param {string} path
   * @param {boolean} [requireAuth=false]
   * @returns {string}
   */
  _buildUrl (path, requireAuth = false) {
    const url = new URL(path, this.baseUrl)
    if (requireAuth || this._auth) {
      if (!this._auth) throw new Error('Authentication required. Pass auth in constructor options.')
      url.searchParams.set('auth', this._auth)
    }
    return url.toString()
  }

  /**
   * Raw fetch with timeout.
   * @param {string} path
   * @param {object} [init]
   * @returns {Promise<Response>}
   */
  async _fetch (path, init = {}) {
    const url = this._buildUrl(path, false)
    return fetch(url, { ...init, signal: AbortSignal.timeout(this._timeout) })
  }

  /**
   * GET request returning parsed JSON.
   * @param {string} path
   * @param {boolean} [requireAuth=false]
   * @returns {Promise<object>}
   */
  async _get (path, requireAuth = false) {
    const url = this._buildUrl(path, requireAuth)
    const res = await fetch(url, { signal: AbortSignal.timeout(this._timeout) })
    if (!res.ok) {
      const body = await res.text()
      throw new BridgeError(res.status, body)
    }
    return res.json()
  }

  /**
   * POST request returning parsed JSON.
   * @param {string} path
   * @param {object} body
   * @param {boolean} [requireAuth=false]
   * @returns {Promise<object>}
   */
  async _post (path, body, requireAuth = false) {
    const url = this._buildUrl(path, requireAuth)
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this._timeout)
    })
    if (!res.ok) {
      const text = await res.text()
      throw new BridgeError(res.status, text)
    }
    return res.json()
  }
}

/**
 * Error thrown when the bridge returns a non-OK HTTP response.
 */
export class BridgeError extends Error {
  /**
   * @param {number} status — HTTP status code
   * @param {string} body — Response body
   */
  constructor (status, body) {
    let message = `Bridge returned ${status}`
    try {
      const parsed = JSON.parse(body)
      if (parsed.error) message = parsed.error
    } catch {
      if (body) message = body
    }
    super(message)
    this.name = 'BridgeError'
    this.status = status
  }
}

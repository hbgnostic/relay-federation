import { EventEmitter } from 'node:events'

/**
 * SessionRelay — syncs Indelible session metadata between peers.
 *
 * Uses the PeerManager's message infrastructure to:
 * - Announce session counts per address to new peers (triggered by hello)
 * - Request missing sessions from peers that have more
 * - Respond to session requests with batches
 * - Re-announce to all peers after syncing new sessions
 *
 * Message types:
 *   sessions_announce — { type, summaries: [{ address, count, latest }] }
 *   sessions_request  — { type, address, beforeTimestamp, limit }
 *   sessions          — { type, address, sessions: [...], hasMore }
 *
 * Events:
 *   'sessions:sync'  — { pubkeyHex, address, added, total }
 */
export class SessionRelay extends EventEmitter {
  /**
   * @param {import('./peer-manager.js').PeerManager} peerManager
   * @param {import('./persistent-store.js').PersistentStore} store
   * @param {object} [opts]
   * @param {number} [opts.maxBatch=500] — Max sessions per response
   */
  constructor (peerManager, store, opts = {}) {
    super()
    this.peerManager = peerManager
    this.store = store
    this._maxBatch = opts.maxBatch || 500
    this._syncing = new Set() // track in-progress syncs: "pubkey:address"

    this.peerManager.on('peer:message', ({ pubkeyHex, message }) => {
      this._handleMessage(pubkeyHex, message)
    })
  }

  /** @private */
  async _announceToPeer (pubkeyHex) {
    const conn = this.peerManager.peers.get(pubkeyHex)
    if (!conn) return
    try {
      const summaries = await this.store.getSessionAddresses()
      conn.send({ type: 'sessions_announce', summaries })
    } catch (err) {
      // Store not ready yet — skip announce
    }
  }

  /** @private */
  _handleMessage (pubkeyHex, message) {
    switch (message.type) {
      case 'hello':
        this._announceToPeer(pubkeyHex)
        break
      case 'sessions_announce':
        this._onSessionsAnnounce(pubkeyHex, message)
        break
      case 'sessions_request':
        this._onSessionsRequest(pubkeyHex, message)
        break
      case 'sessions':
        this._onSessions(pubkeyHex, message)
        break
    }
  }

  /** @private */
  async _onSessionsAnnounce (pubkeyHex, msg) {
    if (!Array.isArray(msg.summaries)) return
    const ourSummaries = await this.store.getSessionAddresses()
    const ourMap = new Map(ourSummaries.map(s => [s.address, s]))

    for (const remote of msg.summaries) {
      const local = ourMap.get(remote.address)
      const ourCount = local ? local.count : 0

      if (remote.count > ourCount) {
        // Peer has more sessions for this address — request what we're missing
        const syncKey = `${pubkeyHex}:${remote.address}`
        if (this._syncing.has(syncKey)) continue // already syncing
        this._syncing.add(syncKey)

        const conn = this.peerManager.peers.get(pubkeyHex)
        if (conn) {
          conn.send({
            type: 'sessions_request',
            address: remote.address,
            beforeTimestamp: '',
            limit: this._maxBatch
          })
        }
      } else if (remote.count < ourCount) {
        // We have more — announce back so they can sync from us
        this._announceToPeer(pubkeyHex)
        break // one announce covers all addresses
      }
    }
  }

  /** @private */
  async _onSessionsRequest (pubkeyHex, msg) {
    if (!msg.address) return
    const limit = Math.min(msg.limit || this._maxBatch, this._maxBatch)
    const allSessions = await this.store.getSessions(msg.address, 5000)

    // Filter: getSessions returns newest-first, so paginate by "before" timestamp
    let sessions = allSessions
    if (msg.beforeTimestamp) {
      sessions = allSessions.filter(s => s.timestamp < msg.beforeTimestamp)
    }

    // Paginate
    const batch = sessions.slice(0, limit)
    const hasMore = sessions.length > limit

    const conn = this.peerManager.peers.get(pubkeyHex)
    if (conn) {
      conn.send({
        type: 'sessions',
        address: msg.address,
        sessions: batch,
        hasMore
      })
    }
  }

  /** @private */
  async _onSessions (pubkeyHex, msg) {
    if (!msg.address || !Array.isArray(msg.sessions)) return
    const syncKey = `${pubkeyHex}:${msg.address}`

    // Deduplicate: only import sessions we don't already have
    const existing = await this.store.getSessions(msg.address, 5000)
    const existingTxIds = new Set(existing.map(s => s.txId))
    const newSessions = msg.sessions.filter(s => !existingTxIds.has(s.txId))

    let added = 0
    if (newSessions.length > 0) {
      added = await this.store.putSessionsBatch(newSessions)
    }

    if (added > 0) {
      const total = existing.length + added
      this.emit('sessions:sync', {
        pubkeyHex,
        address: msg.address,
        added,
        total
      })

      // Re-announce to all peers except the source
      const summaries = await this.store.getSessionAddresses()
      this.peerManager.broadcast({
        type: 'sessions_announce',
        summaries
      }, pubkeyHex)
    }

    // If peer has more, request next batch (oldest from current batch = cursor)
    if (msg.hasMore && msg.sessions.length > 0) {
      const oldest = msg.sessions.reduce((min, s) =>
        !min || s.timestamp < min ? s.timestamp : min, ''
      )
      const conn = this.peerManager.peers.get(pubkeyHex)
      if (conn) {
        conn.send({
          type: 'sessions_request',
          address: msg.address,
          beforeTimestamp: oldest,
          limit: this._maxBatch
        })
      }
    } else {
      this._syncing.delete(syncKey)
    }
  }
}

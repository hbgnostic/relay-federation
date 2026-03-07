import WebSocket from 'ws'

/**
 * Probe a WebSocket endpoint for reachability.
 *
 * Opens a WebSocket connection, waits for the 'open' event,
 * then immediately closes. Returns true if reachable, false
 * if the connection fails or times out.
 *
 * @param {string} endpoint — WebSocket URL (ws:// or wss://)
 * @param {number} [timeoutMs=5000] — Probe timeout in milliseconds
 * @returns {Promise<boolean>} true if endpoint is reachable
 */
export async function probeEndpoint (endpoint, timeoutMs = 5000) {
  return new Promise((resolve) => {
    let settled = false

    const ws = new WebSocket(endpoint, {
      handshakeTimeout: timeoutMs
    })

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { ws.close() } catch {}
      resolve(false)
    }, timeoutMs)

    ws.on('open', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { ws.close() } catch {}
      resolve(true)
    })

    ws.on('error', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { ws.close() } catch {}
      resolve(false)
    })
  })
}

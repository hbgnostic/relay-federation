import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocketServer } from 'ws'
import { probeEndpoint } from '../lib/endpoint-probe.js'

describe('probeEndpoint', () => {
  let wss = null

  afterEach(() => {
    if (wss) {
      wss.close()
      wss = null
    }
  })

  it('returns true for a reachable WebSocket endpoint', async () => {
    wss = new WebSocketServer({ port: 0 })
    const port = wss.address().port

    const result = await probeEndpoint(`ws://127.0.0.1:${port}`)
    assert.equal(result, true)
  })

  it('returns false for an unreachable endpoint', async () => {
    // Port 1 is almost certainly not running a WebSocket server
    const result = await probeEndpoint('ws://127.0.0.1:1', 1000)
    assert.equal(result, false)
  })

  it('returns false on timeout', async () => {
    // Create a TCP server that accepts but never upgrades to WebSocket
    const net = await import('node:net')
    const server = net.createServer((socket) => {
      // Accept connection but do nothing — no HTTP upgrade
      // This will cause the WebSocket handshake to hang
    })
    await new Promise(resolve => server.listen(0, resolve))
    const port = server.address().port

    const start = Date.now()
    const result = await probeEndpoint(`ws://127.0.0.1:${port}`, 500)
    const elapsed = Date.now() - start

    assert.equal(result, false)
    assert.ok(elapsed >= 400, `should have waited ~500ms, got ${elapsed}ms`)
    assert.ok(elapsed < 2000, `should not wait too long, got ${elapsed}ms`)

    server.close()
  })

  it('returns false for invalid URL', async () => {
    const result = await probeEndpoint('ws://this-host-does-not-exist.invalid:9999', 1000)
    assert.equal(result, false)
  })
})

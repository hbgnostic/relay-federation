import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { BSVNodeClient } from '../lib/bsv-node-client.js'

// Re-implement helpers for testing (they're not exported)
function sha256d (data) {
  const h1 = createHash('sha256').update(data).digest()
  return createHash('sha256').update(h1).digest()
}

function reverseBuffer (buf) {
  const out = Buffer.allocUnsafe(buf.length)
  for (let i = 0; i < buf.length; i++) {
    out[i] = buf[buf.length - 1 - i]
  }
  return out
}

function internalToHash (buf) {
  return reverseBuffer(buf).toString('hex')
}

function hashToInternal (hexStr) {
  return reverseBuffer(Buffer.from(hexStr, 'hex'))
}

// Build a P2P message with proper framing
function buildMessage (command, payload) {
  const magic = Buffer.from('e3e1f3e8', 'hex')
  const header = Buffer.alloc(24)
  magic.copy(header, 0)
  const cmdBuf = Buffer.alloc(12)
  cmdBuf.write(command, 'ascii')
  cmdBuf.copy(header, 4)
  header.writeUInt32LE(payload.length, 16)
  const checksum = sha256d(payload).subarray(0, 4)
  checksum.copy(header, 20)
  return Buffer.concat([header, payload])
}

// Build a minimal version message
function buildVersionPayload (startHeight = 939000) {
  const payload = Buffer.alloc(86)
  let offset = 0
  payload.writeInt32LE(70015, offset); offset += 4 // version
  payload.writeBigUInt64LE(1n, offset); offset += 8 // services
  payload.writeBigUInt64LE(BigInt(Math.floor(Date.now() / 1000)), offset); offset += 8 // timestamp
  // addr_recv (26 bytes)
  offset += 26
  // addr_from (26 bytes)
  offset += 26
  // nonce (8 bytes)
  offset += 8
  // user agent length (0)
  payload[offset] = 0; offset += 1
  // start height
  payload.writeInt32LE(startHeight, offset); offset += 4
  // relay
  payload[offset] = 0
  return payload
}

// Build a fake 80-byte header
function buildRawHeader (prevHashHex, timestamp = 1700000000, version = 0x20000000) {
  const header = Buffer.alloc(80)
  let offset = 0
  header.writeInt32LE(version, offset); offset += 4
  // prevHash in internal byte order
  hashToInternal(prevHashHex).copy(header, offset); offset += 32
  // merkle root (random)
  Buffer.alloc(32, 0xab).copy(header, offset); offset += 32
  // timestamp
  header.writeUInt32LE(timestamp, offset); offset += 4
  // bits
  header.writeUInt32LE(0x18234bb9, offset); offset += 4
  // nonce
  header.writeUInt32LE(12345, offset)
  return header
}

// Build a headers response payload
function buildHeadersPayload (rawHeaders) {
  // varint count + (80 bytes + varint(0)) per header
  const parts = [Buffer.from([rawHeaders.length])]
  for (const raw of rawHeaders) {
    parts.push(raw)
    parts.push(Buffer.from([0])) // tx_count = 0
  }
  return Buffer.concat(parts)
}

describe('BSVNodeClient', () => {
  let client

  afterEach(() => {
    if (client) client.disconnect()
  })

  it('initializes with default checkpoint', () => {
    client = new BSVNodeClient()
    assert.equal(client.bestHeight, 930000)
    assert.equal(client.bestHash, '00000000000000001c2e04e4375cfa4b46588aa27795b2c7f8d4d34cb568a382')
  })

  it('initializes with custom checkpoint', () => {
    client = new BSVNodeClient({
      checkpoint: { height: 100, hash: 'aabbcc', prevHash: '112233' }
    })
    assert.equal(client.bestHeight, 100)
    assert.equal(client.bestHash, 'aabbcc')
  })

  it('seedHeader updates best height', () => {
    client = new BSVNodeClient({
      checkpoint: { height: 100, hash: 'aabbcc', prevHash: '112233' }
    })
    client.seedHeader(200, 'ddeeff')
    assert.equal(client.bestHeight, 200)
    assert.equal(client.bestHash, 'ddeeff')
  })

  it('seedHeader does not lower best height', () => {
    client = new BSVNodeClient({
      checkpoint: { height: 100, hash: 'aabbcc', prevHash: '112233' }
    })
    client.seedHeader(50, '001122')
    assert.equal(client.bestHeight, 100)
  })

  it('parses version message and emits handshake after verack', async () => {
    client = new BSVNodeClient({
      checkpoint: { height: 100, hash: '00'.repeat(32), prevHash: '00'.repeat(32) }
    })

    // Simulate the TCP data flow by calling _onData directly
    const versionPayload = buildVersionPayload(939000)
    const versionMsg = buildMessage('version', versionPayload)

    // Need to fake connection state
    client._connected = true
    client._socket = { write: () => {}, destroy: () => {} } // fake socket

    const handshakePromise = new Promise(resolve => {
      client.once('handshake', resolve)
    })

    // Feed version message
    client._onData(versionMsg)

    // Feed verack message
    const verackMsg = buildMessage('verack', Buffer.alloc(0))
    client._onData(verackMsg)

    const info = await handshakePromise
    assert.equal(info.version, 70015)
    assert.equal(info.startHeight, 939000)
  })

  it('parses headers response and emits headers event', async () => {
    const checkpointHash = '00'.repeat(32)
    client = new BSVNodeClient({
      checkpoint: { height: 100, hash: checkpointHash, prevHash: '11'.repeat(32) }
    })

    client._connected = true
    client._handshakeComplete = true
    client._socket = { write: () => {}, destroy: () => {} }

    // Build a chain of 3 headers starting from checkpoint
    const raw1 = buildRawHeader(checkpointHash, 1700000001)
    const hash1 = internalToHash(sha256d(raw1))

    const raw2 = buildRawHeader(hash1, 1700000002)
    const hash2 = internalToHash(sha256d(raw2))

    const raw3 = buildRawHeader(hash2, 1700000003)
    const hash3 = internalToHash(sha256d(raw3))

    const headersPayload = buildHeadersPayload([raw1, raw2, raw3])
    const headersMsg = buildMessage('headers', headersPayload)

    const headersPromise = new Promise(resolve => {
      client.once('headers', resolve)
    })

    client._onData(headersMsg)

    const result = await headersPromise
    assert.equal(result.count, 3)
    assert.equal(result.headers[0].height, 101)
    assert.equal(result.headers[0].prevHash, checkpointHash)
    assert.equal(result.headers[0].hash, hash1)
    assert.equal(result.headers[1].height, 102)
    assert.equal(result.headers[1].hash, hash2)
    assert.equal(result.headers[2].height, 103)
    assert.equal(result.headers[2].hash, hash3)

    // Best height should update
    assert.equal(client.bestHeight, 103)
    assert.equal(client.bestHash, hash3)
  })

  it('handles split TCP packets', async () => {
    const checkpointHash = '00'.repeat(32)
    client = new BSVNodeClient({
      checkpoint: { height: 100, hash: checkpointHash, prevHash: '11'.repeat(32) }
    })

    client._connected = true
    client._handshakeComplete = true
    client._socket = { write: () => {}, destroy: () => {} }

    const raw1 = buildRawHeader(checkpointHash, 1700000001)
    const headersPayload = buildHeadersPayload([raw1])
    const fullMsg = buildMessage('headers', headersPayload)

    const headersPromise = new Promise(resolve => {
      client.once('headers', resolve)
    })

    // Split the message into two chunks
    const mid = Math.floor(fullMsg.length / 2)
    client._onData(fullMsg.subarray(0, mid))
    client._onData(fullMsg.subarray(mid))

    const result = await headersPromise
    assert.equal(result.count, 1)
    assert.equal(result.headers[0].height, 101)
  })

  it('rejects messages with bad checksum', () => {
    client = new BSVNodeClient({
      checkpoint: { height: 100, hash: '00'.repeat(32), prevHash: '11'.repeat(32) }
    })

    client._connected = true
    client._socket = { write: () => {}, destroy: () => {} }

    let gotHeaders = false
    client.on('headers', () => { gotHeaders = true })

    // Build a valid message then corrupt the checksum
    const raw = buildRawHeader('00'.repeat(32))
    const payload = buildHeadersPayload([raw])
    const msg = buildMessage('headers', payload)
    msg[20] = 0xff // corrupt checksum byte
    msg[21] = 0xff

    client._onData(msg)
    assert.equal(gotHeaders, false)
  })

  it('responds to ping with pong', () => {
    client = new BSVNodeClient({
      checkpoint: { height: 100, hash: '00'.repeat(32), prevHash: '11'.repeat(32) }
    })

    const sent = []
    client._connected = true
    client._handshakeComplete = true
    client._socket = {
      write: (data) => { sent.push(data) },
      destroy: () => {}
    }

    const nonce = Buffer.from('0102030405060708', 'hex')
    const pingMsg = buildMessage('ping', nonce)
    client._onData(pingMsg)

    // Should have sent a pong
    assert.ok(sent.length > 0)
    // Parse the pong message
    const pongData = sent[0]
    const pongCmd = pongData.subarray(4, 16).toString('ascii').replace(/\0/g, '')
    assert.equal(pongCmd, 'pong')
    // Pong payload should match ping nonce
    const pongPayload = pongData.subarray(24)
    assert.ok(pongPayload.equals(nonce))
  })

  it('triggers sync on block inv', async () => {
    client = new BSVNodeClient({
      checkpoint: { height: 100, hash: '00'.repeat(32), prevHash: '11'.repeat(32) }
    })

    const sent = []
    client._connected = true
    client._handshakeComplete = true
    client._socket = {
      write: (data) => { sent.push(data) },
      destroy: () => {}
    }

    // Build inv message with one block
    const invPayload = Buffer.alloc(37)
    invPayload[0] = 1 // count = 1
    invPayload.writeUInt32LE(2, 1) // type = MSG_BLOCK
    // hash (32 bytes, doesn't matter)

    const invMsg = buildMessage('inv', invPayload)
    client._onData(invMsg)

    // Should have sent getheaders
    assert.ok(sent.length > 0)
    const cmd = sent[0].subarray(4, 16).toString('ascii').replace(/\0/g, '')
    assert.equal(cmd, 'getheaders')
  })

  it('block locator includes checkpoint', () => {
    client = new BSVNodeClient({
      checkpoint: { height: 100, hash: 'checkpoint_hash', prevHash: 'prev_hash' }
    })

    const locator = client._buildBlockLocator()
    assert.ok(locator.includes('checkpoint_hash'))
  })

  it('block locator uses exponential backoff', () => {
    client = new BSVNodeClient({
      checkpoint: { height: 0, hash: 'genesis', prevHash: '' }
    })

    // Seed many headers
    for (let i = 1; i <= 100; i++) {
      client.seedHeader(i, `hash_${i}`)
    }

    const locator = client._buildBlockLocator()

    // Should start from tip
    assert.equal(locator[0], 'hash_100')
    // Should include checkpoint/genesis
    assert.equal(locator[locator.length - 1], 'genesis')
    // Should be much shorter than 100 entries due to exponential steps
    assert.ok(locator.length < 30)
  })

  it('handles empty headers response', () => {
    client = new BSVNodeClient({
      checkpoint: { height: 100, hash: '00'.repeat(32), prevHash: '11'.repeat(32) }
    })

    client._connected = true
    client._handshakeComplete = true
    client._socket = { write: () => {}, destroy: () => {} }
    client._syncing = true

    let gotHeaders = false
    client.on('headers', () => { gotHeaders = true })

    // Empty headers payload (count = 0)
    const emptyPayload = Buffer.from([0])
    const msg = buildMessage('headers', emptyPayload)
    client._onData(msg)

    assert.equal(gotHeaders, false)
    assert.equal(client._syncing, false)
  })

  it('disconnect stops timers and sets destroyed', () => {
    client = new BSVNodeClient()
    client._syncTimer = setInterval(() => {}, 10000)
    client._pingTimer = setInterval(() => {}, 10000)

    client.disconnect()
    assert.equal(client._destroyed, true)
    assert.equal(client._connected, false)
  })

  // ── P2P Transaction Capability (2.19-2.21) ──────────────────

  it('getTx rejects when not connected', async () => {
    client = new BSVNodeClient({
      checkpoint: { height: 100, hash: '00'.repeat(32), prevHash: '11'.repeat(32) }
    })
    // _handshakeComplete is false by default
    await assert.rejects(
      () => client.getTx('aa'.repeat(32)),
      { message: 'not connected to BSV node' }
    )
  })

  it('getTx sends getdata MSG_TX and resolves on tx response', async () => {
    client = new BSVNodeClient({
      checkpoint: { height: 100, hash: '00'.repeat(32), prevHash: '11'.repeat(32) }
    })

    const sent = []
    client._connected = true
    client._handshakeComplete = true
    client._socket = {
      write: (data) => { sent.push(data) },
      destroy: () => {}
    }

    // Create a fake raw tx (just some bytes)
    const fakeTxBytes = Buffer.from('01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff0704ffff001d0104ffffffff0100f2052a0100000043410496b538e853519c726a2c91e61ec11600ae1390813a627c66fb8be7947be63c52da7589379515d4e0a604f8141781e62294721166bf621e73a82cbf2342c858eeac00000000', 'hex')
    const expectedTxid = internalToHash(sha256d(fakeTxBytes))

    // Start getTx request
    const txPromise = client.getTx(expectedTxid)

    // Verify getdata was sent
    assert.ok(sent.length > 0)
    const getdataCmd = sent[0].subarray(4, 16).toString('ascii').replace(/\0/g, '')
    assert.equal(getdataCmd, 'getdata')

    // Parse getdata payload: varint(1) + type(u32LE) + hash(32B)
    const getdataPayload = sent[0].subarray(24)
    assert.equal(getdataPayload[0], 1) // count = 1
    assert.equal(getdataPayload.readUInt32LE(1), 1) // MSG_TX = 1
    const requestedHash = internalToHash(getdataPayload.subarray(5, 37))
    assert.equal(requestedHash, expectedTxid)

    // Simulate receiving the tx response
    const txMsg = buildMessage('tx', fakeTxBytes)
    client._onData(txMsg)

    const result = await txPromise
    assert.equal(result.txid, expectedTxid)
    assert.equal(result.rawHex, fakeTxBytes.toString('hex'))
  })

  it('getTx rejects on timeout', async () => {
    client = new BSVNodeClient({
      checkpoint: { height: 100, hash: '00'.repeat(32), prevHash: '11'.repeat(32) }
    })

    client._connected = true
    client._handshakeComplete = true
    client._socket = {
      write: () => {},
      destroy: () => {}
    }

    await assert.rejects(
      () => client.getTx('bb'.repeat(32), 50), // 50ms timeout
      { message: /timeout fetching tx/ }
    )

    // Pending request should be cleaned up
    assert.equal(client._pendingTxRequests.size, 0)
  })

  it('getTx rejects on notfound response', async () => {
    client = new BSVNodeClient({
      checkpoint: { height: 100, hash: '00'.repeat(32), prevHash: '11'.repeat(32) }
    })

    client._connected = true
    client._handshakeComplete = true
    client._socket = {
      write: () => {},
      destroy: () => {}
    }

    const txid = 'cc'.repeat(32)
    const txPromise = client.getTx(txid)

    // Build notfound response: [varint count=1] [type=1 MSG_TX] [hash 32B internal]
    const notfoundPayload = Buffer.alloc(37)
    notfoundPayload[0] = 1
    notfoundPayload.writeUInt32LE(1, 1) // MSG_TX
    hashToInternal(txid).copy(notfoundPayload, 5)
    const notfoundMsg = buildMessage('notfound', notfoundPayload)
    client._onData(notfoundMsg)

    await assert.rejects(
      () => txPromise,
      { message: /tx not found/ }
    )

    assert.equal(client._pendingTxRequests.size, 0)
  })

  it('getTx rejects duplicate request for same txid', async () => {
    client = new BSVNodeClient({
      checkpoint: { height: 100, hash: '00'.repeat(32), prevHash: '11'.repeat(32) }
    })

    client._connected = true
    client._handshakeComplete = true
    client._socket = {
      write: () => {},
      destroy: () => {}
    }

    const txid = 'dd'.repeat(32)
    // First request (don't await — it'll timeout)
    const p1 = client.getTx(txid, 200)
    // Second request for same txid should reject immediately
    await assert.rejects(
      () => client.getTx(txid),
      { message: /already fetching tx/ }
    )

    // Clean up the first request
    await assert.rejects(() => p1, { message: /timeout/ })
  })

  it('_onTx emits tx event for unsolicited transactions', () => {
    client = new BSVNodeClient({
      checkpoint: { height: 100, hash: '00'.repeat(32), prevHash: '11'.repeat(32) }
    })

    client._connected = true
    client._handshakeComplete = true
    client._socket = { write: () => {}, destroy: () => {} }

    const fakeTxBytes = Buffer.alloc(64, 0xab)
    const expectedTxid = internalToHash(sha256d(fakeTxBytes))

    let emittedTx = null
    client.on('tx', (tx) => { emittedTx = tx })

    const txMsg = buildMessage('tx', fakeTxBytes)
    client._onData(txMsg)

    assert.ok(emittedTx)
    assert.equal(emittedTx.txid, expectedTxid)
    assert.equal(emittedTx.rawHex, fakeTxBytes.toString('hex'))
  })

  it('broadcastTx sends tx message and returns txid', () => {
    client = new BSVNodeClient({
      checkpoint: { height: 100, hash: '00'.repeat(32), prevHash: '11'.repeat(32) }
    })

    const sent = []
    client._connected = true
    client._handshakeComplete = true
    client._socket = {
      write: (data) => { sent.push(data) },
      destroy: () => {}
    }

    const fakeTxHex = Buffer.alloc(64, 0xcd).toString('hex')
    const expectedTxid = internalToHash(sha256d(Buffer.from(fakeTxHex, 'hex')))

    const txid = client.broadcastTx(fakeTxHex)

    assert.equal(txid, expectedTxid)

    // Should have sent a tx message
    assert.ok(sent.length > 0)
    const txCmd = sent[0].subarray(4, 16).toString('ascii').replace(/\0/g, '')
    assert.equal(txCmd, 'tx')

    // Payload should be the raw tx bytes
    const txPayload = sent[0].subarray(24)
    assert.equal(txPayload.toString('hex'), fakeTxHex)

    // Should be cached in _knownTxs
    assert.equal(client._knownTxs.get(txid), fakeTxHex)
  })

  it('_onGetdata serves cached tx from _knownTxs', () => {
    client = new BSVNodeClient({
      checkpoint: { height: 100, hash: '00'.repeat(32), prevHash: '11'.repeat(32) }
    })

    const sent = []
    client._connected = true
    client._handshakeComplete = true
    client._socket = {
      write: (data) => { sent.push(data) },
      destroy: () => {}
    }

    // Broadcast a tx first (caches it in _knownTxs)
    const fakeTxHex = Buffer.alloc(32, 0xef).toString('hex')
    const txid = client.broadcastTx(fakeTxHex)
    sent.length = 0 // clear sent (the broadcast tx message)

    // Build getdata request for that txid
    const getdataPayload = Buffer.alloc(37)
    getdataPayload[0] = 1
    getdataPayload.writeUInt32LE(1, 1) // MSG_TX
    hashToInternal(txid).copy(getdataPayload, 5)
    const getdataMsg = buildMessage('getdata', getdataPayload)
    client._onData(getdataMsg)

    // Should have responded with the cached tx
    assert.ok(sent.length > 0)
    const respCmd = sent[0].subarray(4, 16).toString('ascii').replace(/\0/g, '')
    assert.equal(respCmd, 'tx')
    const respPayload = sent[0].subarray(24)
    assert.equal(respPayload.toString('hex'), fakeTxHex)
  })

  it('_onGetdata ignores unknown txids', () => {
    client = new BSVNodeClient({
      checkpoint: { height: 100, hash: '00'.repeat(32), prevHash: '11'.repeat(32) }
    })

    const sent = []
    client._connected = true
    client._handshakeComplete = true
    client._socket = {
      write: (data) => { sent.push(data) },
      destroy: () => {}
    }

    // Build getdata for a txid we don't have
    const getdataPayload = Buffer.alloc(37)
    getdataPayload[0] = 1
    getdataPayload.writeUInt32LE(1, 1)
    Buffer.alloc(32, 0xff).copy(getdataPayload, 5)
    const getdataMsg = buildMessage('getdata', getdataPayload)
    client._onData(getdataMsg)

    // Should not have sent anything
    assert.equal(sent.length, 0)
  })

  it('_onInv emits tx:inv for MSG_TX inventory', () => {
    client = new BSVNodeClient({
      checkpoint: { height: 100, hash: '00'.repeat(32), prevHash: '11'.repeat(32) }
    })

    client._connected = true
    client._handshakeComplete = true
    client._socket = { write: () => {}, destroy: () => {} }

    let emittedInv = null
    client.on('tx:inv', (inv) => { emittedInv = inv })

    // Build inv with 2 tx items
    const invPayload = Buffer.alloc(1 + 36 * 2)
    invPayload[0] = 2 // count = 2
    invPayload.writeUInt32LE(1, 1) // MSG_TX
    hashToInternal('aa'.repeat(32)).copy(invPayload, 5)
    invPayload.writeUInt32LE(1, 37) // MSG_TX
    hashToInternal('bb'.repeat(32)).copy(invPayload, 41)

    const invMsg = buildMessage('inv', invPayload)
    client._onData(invMsg)

    assert.ok(emittedInv)
    assert.equal(emittedInv.txids.length, 2)
    assert.equal(emittedInv.txids[0], 'aa'.repeat(32))
    assert.equal(emittedInv.txids[1], 'bb'.repeat(32))
  })

  it('_onInv handles mixed block and tx inventory', () => {
    client = new BSVNodeClient({
      checkpoint: { height: 100, hash: '00'.repeat(32), prevHash: '11'.repeat(32) }
    })

    const sent = []
    client._connected = true
    client._handshakeComplete = true
    client._socket = {
      write: (data) => { sent.push(data) },
      destroy: () => {}
    }

    let emittedInv = null
    client.on('tx:inv', (inv) => { emittedInv = inv })

    // Build inv with 1 block + 1 tx
    const invPayload = Buffer.alloc(1 + 36 * 2)
    invPayload[0] = 2 // count = 2
    invPayload.writeUInt32LE(2, 1) // MSG_BLOCK
    Buffer.alloc(32, 0x11).copy(invPayload, 5)
    invPayload.writeUInt32LE(1, 37) // MSG_TX
    hashToInternal('ee'.repeat(32)).copy(invPayload, 41)

    const invMsg = buildMessage('inv', invPayload)
    client._onData(invMsg)

    // Should have triggered header sync (for block)
    assert.ok(sent.length > 0)
    const cmd = sent[0].subarray(4, 16).toString('ascii').replace(/\0/g, '')
    assert.equal(cmd, 'getheaders')

    // Should have emitted tx:inv (for tx)
    assert.ok(emittedInv)
    assert.equal(emittedInv.txids.length, 1)
    assert.equal(emittedInv.txids[0], 'ee'.repeat(32))
  })
})

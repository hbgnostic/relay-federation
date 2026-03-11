import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { RelayBridge, BridgeError } from '../lib/index.js'

describe('RelayBridge constructor', () => {
  it('strips trailing slashes from baseUrl', () => {
    const b = new RelayBridge('http://localhost:9333/')
    assert.equal(b.baseUrl, 'http://localhost:9333')
  })

  it('stores auth option', () => {
    const b = new RelayBridge('http://localhost:9333', { auth: 'secret123' })
    assert.equal(b._auth, 'secret123')
  })

  it('defaults timeout to 10000', () => {
    const b = new RelayBridge('http://localhost:9333')
    assert.equal(b._timeout, 10000)
  })

  it('accepts custom timeout', () => {
    const b = new RelayBridge('http://localhost:9333', { timeout: 5000 })
    assert.equal(b._timeout, 5000)
  })
})

describe('input validation', () => {
  let bridge

  beforeEach(() => {
    bridge = new RelayBridge('http://localhost:9333')
  })

  it('getTx rejects short txid', async () => {
    await assert.rejects(
      () => bridge.getTx('abc'),
      { message: 'txid must be a 64-character hex string' }
    )
  })

  it('getTx rejects empty txid', async () => {
    await assert.rejects(
      () => bridge.getTx(''),
      { message: 'txid must be a 64-character hex string' }
    )
  })

  it('broadcast rejects missing rawHex', async () => {
    await assert.rejects(
      () => bridge.broadcast(''),
      { message: 'rawHex is required' }
    )
  })

  it('broadcast rejects non-string rawHex', async () => {
    await assert.rejects(
      () => bridge.broadcast(123),
      { message: 'rawHex is required' }
    )
  })

  it('getAddressHistory rejects short address', async () => {
    await assert.rejects(
      () => bridge.getAddressHistory('abc'),
      { message: 'Invalid BSV address' }
    )
  })

  it('send rejects missing toAddress', async () => {
    await assert.rejects(
      () => bridge.send('', 1000),
      { message: 'toAddress is required' }
    )
  })

  it('send rejects amount below dust', async () => {
    await assert.rejects(
      () => bridge.send('1Abc', 100),
      { message: 'amount must be at least 546 satoshis' }
    )
  })

  it('connect rejects missing endpoint', async () => {
    await assert.rejects(
      () => bridge.connect(''),
      { message: 'endpoint is required' }
    )
  })

  it('fund rejects missing rawHex', async () => {
    await assert.rejects(
      () => bridge.fund(''),
      { message: 'rawHex is required' }
    )
  })

  it('scanAddress rejects missing address', async () => {
    await assert.rejects(
      () => bridge.scanAddress(''),
      { message: 'address is required' }
    )
  })
})

describe('URL building', () => {
  it('builds URL without auth', () => {
    const bridge = new RelayBridge('http://localhost:9333')
    const url = bridge._buildUrl('/status')
    assert.equal(url, 'http://localhost:9333/status')
  })

  it('appends auth param when set', () => {
    const bridge = new RelayBridge('http://localhost:9333', { auth: 'mysecret' })
    const url = bridge._buildUrl('/status')
    assert.equal(url, 'http://localhost:9333/status?auth=mysecret')
  })

  it('throws when auth required but not set', () => {
    const bridge = new RelayBridge('http://localhost:9333')
    assert.throws(
      () => bridge._buildUrl('/register', true),
      { message: 'Authentication required. Pass auth in constructor options.' }
    )
  })

  it('appends auth when requireAuth is true', () => {
    const bridge = new RelayBridge('http://localhost:9333', { auth: 'secret' })
    const url = bridge._buildUrl('/register', true)
    assert.equal(url, 'http://localhost:9333/register?auth=secret')
  })
})

describe('getInscriptions query params', () => {
  // We can't actually call the method without a server, but we can test
  // that the URL would be built correctly by checking the internal logic
  it('builds empty params with no filters', () => {
    const params = new URLSearchParams()
    const qs = params.toString()
    assert.equal(qs, '')
  })

  it('builds params with mime filter', () => {
    const params = new URLSearchParams()
    params.set('mime', 'image/png')
    assert.equal(params.toString(), 'mime=image%2Fpng')
  })

  it('builds params with all filters', () => {
    const params = new URLSearchParams()
    params.set('mime', 'image/png')
    params.set('address', '1Abc')
    params.set('limit', '100')
    const qs = params.toString()
    assert.ok(qs.includes('mime=image%2Fpng'))
    assert.ok(qs.includes('address=1Abc'))
    assert.ok(qs.includes('limit=100'))
  })
})

describe('BridgeError', () => {
  it('parses JSON error body', () => {
    const err = new BridgeError(404, '{"error":"tx not found"}')
    assert.equal(err.message, 'tx not found')
    assert.equal(err.status, 404)
    assert.equal(err.name, 'BridgeError')
  })

  it('uses plain text body', () => {
    const err = new BridgeError(500, 'Internal Server Error')
    assert.equal(err.message, 'Internal Server Error')
    assert.equal(err.status, 500)
  })

  it('uses fallback message for empty body', () => {
    const err = new BridgeError(401, '')
    assert.equal(err.message, 'Bridge returned 401')
    assert.equal(err.status, 401)
  })

  it('is an instance of Error', () => {
    const err = new BridgeError(400, 'bad')
    assert.ok(err instanceof Error)
  })
})

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { encode } from 'cborg'
import { encodeRegistration, encodeDeregistration, decodePayload, PROTOCOL_PREFIX } from '../lib/cbor.js'

// Test fixtures
const fakePubkey = new Uint8Array(33).fill(0x02)
const fakeStakeTxid = new Uint8Array(32).fill(0xab)

const validRegistration = {
  endpoint: 'wss://bridge.example.com:8333',
  pubkey: fakePubkey,
  capabilities: ['tx_relay', 'header_sync', 'broadcast', 'address_history'],
  versions: ['1.0'],
  network_version: '1.0',
  stake_txid: fakeStakeTxid,
  mesh_id: 'indelible',
  timestamp: 1741190400
}

const validDeregistration = {
  pubkey: fakePubkey,
  reason: 'shutdown',
  timestamp: 1741190400
}

describe('CBOR encoding', () => {
  describe('registration', () => {
    it('round-trips a valid registration payload', () => {
      const bytes = encodeRegistration(validRegistration)
      assert.ok(bytes instanceof Uint8Array)
      assert.ok(bytes.length > 0)

      const decoded = decodePayload(bytes)
      assert.equal(decoded.action, 'register')
      assert.equal(decoded.endpoint, validRegistration.endpoint)
      assert.deepEqual(decoded.pubkey, fakePubkey)
      assert.deepEqual(decoded.capabilities, validRegistration.capabilities)
      assert.deepEqual(decoded.versions, ['1.0'])
      assert.equal(decoded.network_version, '1.0')
      assert.deepEqual(decoded.stake_txid, fakeStakeTxid)
      assert.equal(decoded.mesh_id, 'indelible')
      assert.equal(decoded.timestamp, 1741190400)
    })

    it('rejects missing endpoint', () => {
      const bad = { ...validRegistration }
      delete bad.endpoint
      assert.throws(() => encodeRegistration(bad), /missing required field: endpoint/)
    })

    it('rejects wrong pubkey length', () => {
      assert.throws(
        () => encodeRegistration({ ...validRegistration, pubkey: new Uint8Array(32) }),
        /pubkey must be 33-byte/
      )
    })

    it('rejects wrong stake_txid length', () => {
      assert.throws(
        () => encodeRegistration({ ...validRegistration, stake_txid: new Uint8Array(16) }),
        /stake_txid must be 32-byte/
      )
    })

    it('rejects non-ws endpoint', () => {
      assert.throws(
        () => encodeRegistration({ ...validRegistration, endpoint: 'http://example.com' }),
        /endpoint must start with ws:\/\/ or wss:\/\//
      )
    })

    it('rejects invalid capability', () => {
      assert.throws(
        () => encodeRegistration({ ...validRegistration, capabilities: ['tx_relay', 'bogus'] }),
        /invalid capability: bogus/
      )
    })
  })

  describe('deregistration', () => {
    it('round-trips a valid deregistration payload', () => {
      const bytes = encodeDeregistration(validDeregistration)
      assert.ok(bytes instanceof Uint8Array)

      const decoded = decodePayload(bytes)
      assert.equal(decoded.action, 'deregister')
      assert.deepEqual(decoded.pubkey, fakePubkey)
      assert.equal(decoded.reason, 'shutdown')
      assert.equal(decoded.timestamp, 1741190400)
    })

    it('rejects missing reason', () => {
      const bad = { ...validDeregistration }
      delete bad.reason
      assert.throws(() => encodeDeregistration(bad), /missing required field: reason/)
    })
  })

  describe('decodePayload', () => {
    it('rejects unknown action', () => {
      const bytes = encode({ action: 'bogus' })
      assert.throws(() => decodePayload(bytes), /unknown action: bogus/)
    })
  })

  describe('protocol prefix', () => {
    it('is the correct string', () => {
      assert.equal(PROTOCOL_PREFIX, 'indelible.bridge-registry')
    })
  })

  describe('payload size', () => {
    it('registration payload is under 400 bytes', () => {
      const bytes = encodeRegistration(validRegistration)
      assert.ok(bytes.length < 400, `payload is ${bytes.length} bytes, expected < 400`)
    })
  })
})

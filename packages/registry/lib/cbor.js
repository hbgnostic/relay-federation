import { encode, decode } from 'cborg'

const PROTOCOL_PREFIX = 'indelible.bridge-registry'

const REQUIRED_REGISTER_FIELDS = ['action', 'endpoint', 'pubkey', 'capabilities', 'versions', 'network_version', 'stake_txid', 'mesh_id', 'timestamp']
const REQUIRED_DEREGISTER_FIELDS = ['action', 'pubkey', 'reason', 'timestamp']
const VALID_CAPABILITIES = ['tx_relay', 'header_sync', 'broadcast', 'address_history']

/**
 * Encode a bridge registration payload to CBOR bytes.
 *
 * @param {object} payload
 * @param {string} payload.endpoint - WSS endpoint (e.g. "wss://bridge.example.com:8333")
 * @param {Uint8Array} payload.pubkey - 33-byte compressed public key
 * @param {string[]} payload.capabilities - subset of VALID_CAPABILITIES
 * @param {string[]} payload.versions - supported protocol versions (e.g. ["1.0"])
 * @param {string} payload.network_version - current network version (e.g. "1.0")
 * @param {Uint8Array} payload.stake_txid - 32-byte stake bond transaction ID
 * @param {string} payload.mesh_id - mesh identifier (e.g. "indelible")
 * @param {number} payload.timestamp - unix timestamp in seconds
 * @returns {Uint8Array} CBOR-encoded bytes
 */
export function encodeRegistration (payload) {
  const obj = { action: 'register', ...payload }
  validate(obj, REQUIRED_REGISTER_FIELDS)

  if (!(obj.pubkey instanceof Uint8Array) || obj.pubkey.length !== 33) {
    throw new Error('pubkey must be 33-byte Uint8Array')
  }
  if (!(obj.stake_txid instanceof Uint8Array) || obj.stake_txid.length !== 32) {
    throw new Error('stake_txid must be 32-byte Uint8Array')
  }
  if (!obj.endpoint.startsWith('wss://')) {
    throw new Error('endpoint must start with wss://')
  }
  for (const cap of obj.capabilities) {
    if (!VALID_CAPABILITIES.includes(cap)) {
      throw new Error(`invalid capability: ${cap}`)
    }
  }

  return encode(obj)
}

/**
 * Encode a bridge deregistration payload to CBOR bytes.
 *
 * @param {object} payload
 * @param {Uint8Array} payload.pubkey - 33-byte compressed public key
 * @param {string} payload.reason - reason for deregistration (e.g. "shutdown")
 * @param {number} payload.timestamp - unix timestamp in seconds
 * @returns {Uint8Array} CBOR-encoded bytes
 */
export function encodeDeregistration (payload) {
  const obj = { action: 'deregister', ...payload }
  validate(obj, REQUIRED_DEREGISTER_FIELDS)

  if (!(obj.pubkey instanceof Uint8Array) || obj.pubkey.length !== 33) {
    throw new Error('pubkey must be 33-byte Uint8Array')
  }

  return encode(obj)
}

/**
 * Decode CBOR bytes back to a registration or deregistration payload.
 *
 * @param {Uint8Array} bytes - CBOR-encoded bytes
 * @returns {object} decoded payload with action field
 */
export function decodePayload (bytes) {
  const obj = decode(bytes)

  if (obj.action === 'register') {
    validate(obj, REQUIRED_REGISTER_FIELDS)
  } else if (obj.action === 'deregister') {
    validate(obj, REQUIRED_DEREGISTER_FIELDS)
  } else {
    throw new Error(`unknown action: ${obj.action}`)
  }

  return obj
}

/** Protocol prefix for OP_RETURN identification */
export { PROTOCOL_PREFIX, VALID_CAPABILITIES }

function validate (obj, requiredFields) {
  for (const field of requiredFields) {
    if (obj[field] === undefined || obj[field] === null) {
      throw new Error(`missing required field: ${field}`)
    }
  }
}

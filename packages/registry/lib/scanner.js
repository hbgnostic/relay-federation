import { extractOpReturnData, decodePayload } from './cbor.js'
import { PROTOCOL_PREFIX, BEACON_ADDRESS, MIN_STAKE_SATS } from '@relay-federation/common/protocol'
import { fetchAddressHistory, fetchTxHex } from '@relay-federation/common/network'
import { hexToUint8 } from '@relay-federation/common/crypto'
import { Transaction, P2PKH } from '@bsv/sdk'

/**
 * Scan the blockchain for bridge registry transactions.
 *
 * All registration/deregistration txs send a 100 sat dust output to the
 * deterministic BEACON_ADDRESS. The scanner pulls address history for that
 * address, fetches each tx, parses the OP_RETURN output, and returns an
 * array of registry entries.
 *
 * @param {object} opts
 * @param {string} opts.spvEndpoint - SPV bridge base URL (e.g. "http://155.138.238.167:8080")
 * @param {string} opts.apiKey - Relay API key for authentication
 * @returns {Promise<Array<{txid: string, height: number, entry: object}>>}
 *   Sorted by height ascending (oldest first). Each entry has the decoded
 *   CBOR payload (action, endpoint, pubkey, capabilities, etc.)
 */
export async function scanRegistry (opts) {
  const { spvEndpoint, apiKey } = opts

  // Step 1: Get address history for the beacon address
  const history = await fetchAddressHistory(spvEndpoint, apiKey, BEACON_ADDRESS)

  // Step 2: Fetch each tx and parse OP_RETURN
  const entries = []
  for (const item of history) {
    try {
      const entry = await parseRegistryTx(spvEndpoint, apiKey, item.tx_hash)
      if (entry) {
        // Validate stake bond for registrations
        let stakeValid = null
        if (entry.action === 'register' && entry.stake_txid) {
          const result = await validateStakeBond(spvEndpoint, apiKey, entry.stake_txid, entry.pubkey)
          stakeValid = result.valid
          if (!result.valid) {
            entry._stakeReason = result.reason
          }
        }
        entries.push({
          txid: item.tx_hash,
          height: item.height,
          entry,
          stakeValid
        })
      }
    } catch (err) {
      // Skip unparseable txs — could be non-registry dust sent to beacon
    }
  }

  // Step 3: Sort by height ascending (oldest first).
  // Height 0 = mempool (unconfirmed) — treat as newest so latest
  // re-registrations take priority in buildPeerList().
  entries.sort((a, b) => {
    const ha = a.height === 0 ? Infinity : a.height
    const hb = b.height === 0 ? Infinity : b.height
    return ha - hb
  })

  return entries
}

/**
 * Fetch a transaction and attempt to parse its OP_RETURN as a registry entry.
 * Returns null if the tx doesn't contain a valid registry OP_RETURN.
 *
 * @param {string} baseUrl
 * @param {string} apiKey
 * @param {string} txid
 * @returns {Promise<object|null>} Decoded CBOR payload or null
 */
async function parseRegistryTx (baseUrl, apiKey, txid) {
  const rawHex = await fetchTxHex(baseUrl, apiKey, txid)

  // Parse the raw transaction to find OP_RETURN output
  const tx = Transaction.fromHex(rawHex)

  // Find the OP_RETURN output (0 satoshis, starts with 006a)
  const opReturnOutput = tx.outputs.find(out =>
    out.satoshis === 0 && out.lockingScript.toHex().startsWith('006a')
  )

  if (!opReturnOutput) return null

  // Extract prefix and CBOR data
  const { prefix, cborBytes } = extractOpReturnData(opReturnOutput.lockingScript)

  // Verify it's our protocol
  if (prefix !== PROTOCOL_PREFIX) return null

  // Decode the CBOR payload
  return decodePayload(cborBytes)
}

/**
 * Validate a stake bond for a registration entry.
 *
 * Checks that the stake_txid in the registration CBOR:
 *   1. Points to a real transaction on-chain
 *   2. Has a P2PKH output with >= MIN_STAKE_SATS to the registrant's pubkey
 *   3. (Spent/unspent tracking is done by the scanner on rescan)
 *
 * @param {string} baseUrl - SPV bridge base URL
 * @param {string} apiKey - Relay API key
 * @param {Uint8Array} stakeTxidBytes - 32-byte stake txid from CBOR
 * @param {Uint8Array} pubkeyBytes - 33-byte compressed pubkey from CBOR
 * @returns {Promise<{valid: boolean, reason?: string}>}
 */
async function validateStakeBond (baseUrl, apiKey, stakeTxidBytes, pubkeyBytes) {
  try {
    const stakeTxid = Array.from(stakeTxidBytes).map(b => b.toString(16).padStart(2, '0')).join('')

    // Fetch the stake bond tx
    const rawHex = await fetchTxHex(baseUrl, apiKey, stakeTxid)
    const tx = Transaction.fromHex(rawHex)

    // Derive the expected P2PKH locking script from the registrant's pubkey
    const pubkeyHex = Array.from(pubkeyBytes).map(b => b.toString(16).padStart(2, '0')).join('')
    // Build expected script by hashing the pubkey the same way P2PKH does
    const { PublicKey } = await import('@bsv/sdk')
    const pubkey = PublicKey.fromString(pubkeyHex)
    const address = pubkey.toAddress()
    const expectedScript = new P2PKH().lock(address).toHex()

    // Check if any output has >= MIN_STAKE_SATS to the registrant's address
    const stakeOutput = tx.outputs.find(out =>
      out.satoshis >= MIN_STAKE_SATS && out.lockingScript.toHex() === expectedScript
    )

    if (!stakeOutput) {
      return { valid: false, reason: `no output with >= ${MIN_STAKE_SATS} sats to registrant pubkey` }
    }

    return { valid: true }
  } catch (err) {
    return { valid: false, reason: `stake tx fetch failed: ${err.message}` }
  }
}

export { parseRegistryTx, validateStakeBond, BEACON_ADDRESS }

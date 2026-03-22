/**
 * Minimal wallet for address derivation and transaction building.
 * Derives unique P2PKH addresses per session from a seed.
 * Can sweep funds to a collection address.
 * No BRC-100 dependency. No wallet-toolbox. Just @bsv/sdk.
 */

import { PrivateKey, Hash, P2PKH, Transaction, SatoshisPerKilobyte } from '@bsv/sdk'

/**
 * Derive a deterministic private key from seed + label.
 * Uses HMAC-SHA256 (same pattern as Hummingbox's keys.ts).
 */
export function deriveKey(seedHex, label) {
  const seedBuf = Buffer.from(seedHex, 'hex')
  const hmac = Hash.sha256hmac(
    Buffer.from(label, 'utf8'),
    seedBuf
  )
  return PrivateKey.fromString(Buffer.from(hmac).toString('hex'), 'hex')
}

/**
 * Derive a payment address for a session.
 * Each session gets a unique address derived from seed + session ID.
 */
export function deriveSessionAddress(seedHex, sessionId) {
  const key = deriveKey(seedHex, `p2p-paygate:${sessionId}`)
  const address = key.toPublicKey().toAddress()
  return {
    address,
    publicKeyHex: key.toPublicKey().toString(),
  }
}

/**
 * Build and sign a sweep transaction that moves funds from a session address
 * to a collection address. Returns raw tx hex for broadcasting.
 *
 * @param {string} seedHex - Wallet seed
 * @param {string} sessionId - Session ID (to derive the private key)
 * @param {string} collectionAddress - Where to send the funds
 * @param {string} txid - The funding transaction ID
 * @param {number} vout - The output index in the funding tx
 * @param {number} satoshis - The amount at that output
 * @param {string} rawTxHex - Raw hex of the funding transaction (needed as sourceTransaction)
 * @returns {Promise<{ rawHex: string, txid: string }>} Signed sweep transaction
 */
export async function buildSweepTx(seedHex, sessionId, collectionAddress, txid, vout, satoshis, rawTxHex) {
  const privateKey = deriveKey(seedHex, `p2p-paygate:${sessionId}`)

  // Parse the source transaction
  const sourceTx = Transaction.fromHex(rawTxHex)

  // Build sweep transaction with explicit fee (1 sat for ~192 byte tx)
  const fee = 1
  const outputSatoshis = satoshis - fee

  const tx = new Transaction()

  tx.addInput({
    sourceTransaction: sourceTx,
    sourceOutputIndex: vout,
    unlockingScriptTemplate: new P2PKH().unlock(privateKey),
  })

  tx.addOutput({
    lockingScript: new P2PKH().lock(collectionAddress),
    satoshis: outputSatoshis,
  })

  await tx.sign()

  return {
    rawHex: tx.toHex(),
    txid: tx.id('hex'),
  }
}

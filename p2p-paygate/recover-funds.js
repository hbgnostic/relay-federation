/**
 * Recover funds from p2p-paygate session addresses
 *
 * Since session IDs are ephemeral, this script takes known addresses
 * and their txids, then tries to find the session ID by brute-forcing
 * or you can provide them directly.
 *
 * Usage:
 *   node recover-funds.js
 */

import { PrivateKey, Hash, P2PKH, Transaction, SatoshisPerKilobyte } from '@bsv/sdk'
import crypto from 'crypto'

// Load config
let config
try {
  const configModule = await import('./config.js')
  config = configModule.default
} catch {
  console.error('No config.js found')
  process.exit(1)
}

const SEED = config.seed
const BRIDGE_URL = config.bridgeUrl || 'http://34.122.254.59:9333'

// Destination address for recovered funds
const DESTINATION = process.argv[2]

if (!DESTINATION) {
  console.log('Usage: node recover-funds.js <destination-address>')
  console.log('')
  console.log('This will sweep all known session funds to the destination.')
  process.exit(1)
}

// Known payments - add addresses you know received funds
const KNOWN_ADDRESSES = [
  '1C5K9eBqou4JrPiMeZGfqyyjoZ5125E1Dj',
  '1Dgb5XxMgUxwL3JnXyJFS42cBvmyF5nz8h',
]

function deriveKey(seedHex, label) {
  const seedBuf = Buffer.from(seedHex, 'hex')
  const hmac = Hash.sha256hmac(Buffer.from(label, 'utf8'), seedBuf)
  return PrivateKey.fromString(Buffer.from(hmac).toString('hex'), 'hex')
}

function deriveAddress(seedHex, sessionId) {
  const key = deriveKey(seedHex, `p2p-paygate:${sessionId}`)
  return {
    address: key.toPublicKey().toAddress(),
    privateKey: key
  }
}

// Try to find session ID by generating random ones and checking addresses
async function findSessionForAddress(targetAddress, maxAttempts = 100000) {
  console.log(`Searching for session that generates ${targetAddress}...`)

  for (let i = 0; i < maxAttempts; i++) {
    const sessionId = crypto.randomBytes(16).toString('hex')
    const { address } = deriveAddress(SEED, sessionId)

    if (address === targetAddress) {
      console.log(`Found! Session ID: ${sessionId}`)
      return sessionId
    }

    if (i % 10000 === 0 && i > 0) {
      console.log(`  Tried ${i} sessions...`)
    }
  }

  return null
}

async function getAddressUTXOs(address) {
  try {
    // Try WoC unspent endpoint
    const resp = await fetch(`https://api.whatsonchain.com/v1/bsv/main/address/${address}/unspent`, {
      signal: AbortSignal.timeout(10000)
    })
    if (resp.ok) {
      return await resp.json()
    }
  } catch (e) {
    console.error(`Failed to get UTXOs for ${address}: ${e.message}`)
  }
  return []
}

async function getRawTx(txid) {
  // Try bridge first
  try {
    const resp = await fetch(`${BRIDGE_URL}/tx/${txid}/hex`, {
      signal: AbortSignal.timeout(10000)
    })
    if (resp.ok) {
      return await resp.text()
    }
  } catch {}

  // Fallback to WoC
  try {
    const resp = await fetch(`https://api.whatsonchain.com/v1/bsv/main/tx/${txid}/hex`, {
      signal: AbortSignal.timeout(10000)
    })
    if (resp.ok) {
      return await resp.text()
    }
  } catch {}

  return null
}

async function broadcast(rawHex) {
  const resp = await fetch(`${BRIDGE_URL}/broadcast`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rawHex })
  })
  return resp.json()
}

async function sweepAddress(sessionId, utxos) {
  const privateKey = deriveKey(SEED, `p2p-paygate:${sessionId}`)
  const address = privateKey.toPublicKey().toAddress()

  console.log(`\nSweeping ${address}...`)
  console.log(`  Found ${utxos.length} UTXO(s)`)

  let totalSats = 0
  const tx = new Transaction()

  for (const utxo of utxos) {
    const rawHex = await getRawTx(utxo.tx_hash)
    if (!rawHex) {
      console.error(`  Could not fetch tx ${utxo.tx_hash}`)
      continue
    }

    const sourceTx = Transaction.fromHex(rawHex)
    tx.addInput({
      sourceTransaction: sourceTx,
      sourceOutputIndex: utxo.tx_pos,
      unlockingScriptTemplate: new P2PKH().unlock(privateKey),
    })
    totalSats += utxo.value
  }

  if (tx.inputs.length === 0) {
    console.log('  No inputs to sweep')
    return null
  }

  tx.addOutput({
    lockingScript: new P2PKH().lock(DESTINATION),
    change: true,
  })

  tx.fee(new SatoshisPerKilobyte(1))
  tx.sign()

  console.log(`  Total: ${totalSats} sats`)
  console.log(`  Broadcasting...`)

  const result = await broadcast(tx.toHex())
  console.log(`  Result:`, result)
  console.log(`  TxID: ${tx.id('hex')}`)

  return tx.id('hex')
}

// Main
console.log('P2P Paygate Fund Recovery')
console.log('=========================')
console.log(`Destination: ${DESTINATION}`)
console.log(`Bridge: ${BRIDGE_URL}`)
console.log('')

// Note: Without session IDs, we can't directly derive the keys.
// The session IDs were random and stored in-memory only.
//
// Options:
// 1. If server is still running, check sessions Map
// 2. If you logged session IDs somewhere, add them below
// 3. Brute-force is not practical (32 hex chars = 2^128 possibilities)

console.log('IMPORTANT: Session IDs are required to derive private keys.')
console.log('If the server has restarted, those session IDs are lost.')
console.log('')
console.log('To recover, you need to either:')
console.log('1. Find session IDs from logs')
console.log('2. Keep server running and check /check/:sessionId responses')
console.log('')

// If you have session IDs, add them here:
const KNOWN_SESSIONS = [
  // { sessionId: 'abc123...', address: '1ABC...' },
]

for (const session of KNOWN_SESSIONS) {
  const utxos = await getAddressUTXOs(session.address)
  if (utxos.length > 0) {
    await sweepAddress(session.sessionId, utxos)
  }
}

// Check known addresses for funds (informational only without session IDs)
console.log('\nChecking known addresses for funds:')
for (const addr of KNOWN_ADDRESSES) {
  const utxos = await getAddressUTXOs(addr)
  const total = utxos.reduce((sum, u) => sum + u.value, 0)
  console.log(`  ${addr}: ${total} sats (${utxos.length} UTXOs)`)
  if (total > 0) {
    console.log(`    ^ Need session ID to recover these funds`)
  }
}

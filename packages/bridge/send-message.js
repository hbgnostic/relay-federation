#!/usr/bin/env node
/**
 * Send a signed message to a bridge's DataRelay topic.
 *
 * Usage:
 *   node send-message.js <bridge-url> <topic> <message>
 *
 * Example:
 *   node send-message.js http://bridge.relayx.com:9333 mesh.messages "Hey Ryan, check out docs/scaling-audit-prompt.md"
 *
 * Uses your bridge's WIF from config.json for signing.
 */

import { readFileSync } from 'node:fs'
import { PrivateKey } from '@bsv/sdk'
import { signHash } from '@relay-federation/common/crypto'

// Load config
const configPath = process.argv[2] === '--config' ? process.argv[3] : './config.json'
const args = process.argv[2] === '--config' ? process.argv.slice(4) : process.argv.slice(2)

const [bridgeUrl, topic, ...messageParts] = args
const message = messageParts.join(' ')

if (!bridgeUrl || !topic || !message) {
  console.error('Usage: node send-message.js [--config path] <bridge-url> <topic> <message>')
  console.error('Example: node send-message.js http://bridge.relayx.com:9333 mesh.messages "Hello from hummingbird"')
  process.exit(1)
}

// Load WIF from config
let config
try {
  config = JSON.parse(readFileSync(configPath, 'utf8'))
} catch (err) {
  console.error(`Failed to load config from ${configPath}:`, err.message)
  process.exit(1)
}

if (!config.wif) {
  console.error('No WIF found in config.json')
  process.exit(1)
}

// Derive keys
const privKey = PrivateKey.fromWif(config.wif)
const pubKey = privKey.toPublicKey()
const pubkeyHex = pubKey.toString()

// Build envelope
const timestamp = Math.floor(Date.now() / 1000)
const ttl = 3600 // 1 hour
const payload = message

// Sign: preimage = topic + payload + timestamp + ttl
const preimage = `${topic}${payload}${timestamp}${ttl}`
const dataHex = Buffer.from(preimage, 'utf8').toString('hex')
const signature = signHash(dataHex, privKey)  // Pass PrivateKey instance, not hex

const envelope = {
  type: 'data',
  topic,
  payload,
  pubkeyHex,
  timestamp,
  ttl,
  signature
}

console.log('Sending envelope:')
console.log('  Topic:', topic)
console.log('  Payload:', payload)
console.log('  From:', pubkeyHex.slice(0, 16) + '...')
console.log('  To:', bridgeUrl)
console.log()

// POST to bridge
const response = await fetch(`${bridgeUrl}/data`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(envelope)
})

const result = await response.json()

if (response.ok && result.accepted) {
  console.log('✓ Message sent successfully!')
} else {
  console.error('✗ Failed:', result.error || result)
  process.exit(1)
}

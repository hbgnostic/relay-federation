import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { rm, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { savePeerCache, loadPeerCache } from '../lib/peer-cache.js'

// Generate a unique temp dir for each test run
const testDir = join(tmpdir(), `peer-cache-test-${randomBytes(4).toString('hex')}`)

const samplePeers = [
  {
    pubkeyHex: 'aa'.repeat(33),
    endpoint: 'wss://bridge-a.com:8333',
    capabilities: ['tx_relay', 'header_sync'],
    meshId: 'indelible',
    stakeTxid: 'bb'.repeat(32),
    txid: 'cc'.repeat(32),
    height: 842100
  },
  {
    pubkeyHex: 'dd'.repeat(33),
    endpoint: 'wss://bridge-b.com:8333',
    capabilities: ['tx_relay'],
    meshId: 'indelible',
    stakeTxid: 'ee'.repeat(32),
    txid: 'ff'.repeat(32),
    height: 842200
  }
]

describe('Peer cache', () => {
  afterEach(async () => {
    try { await rm(testDir, { recursive: true }) } catch {}
  })

  it('save and load round-trips peer data', async () => {
    const filePath = join(testDir, 'peers.json')
    await savePeerCache(samplePeers, filePath)

    const loaded = await loadPeerCache(filePath)
    assert.notEqual(loaded, null)
    assert.equal(loaded.length, 2)
    assert.equal(loaded[0].pubkeyHex, samplePeers[0].pubkeyHex)
    assert.equal(loaded[0].endpoint, samplePeers[0].endpoint)
    assert.equal(loaded[1].meshId, samplePeers[1].meshId)
  })

  it('returns null for missing file', async () => {
    const result = await loadPeerCache(join(testDir, 'nonexistent.json'))
    assert.equal(result, null)
  })

  it('returns null for corrupted JSON', async () => {
    const filePath = join(testDir, 'bad.json')
    await savePeerCache(samplePeers, filePath) // create dir
    await writeFile(filePath, 'not valid json {{{')

    const result = await loadPeerCache(filePath)
    assert.equal(result, null)
  })

  it('returns null for expired cache', async () => {
    const filePath = join(testDir, 'old.json')

    // Write a cache with a timestamp 8 days ago
    const oldCache = {
      version: 1,
      savedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
      peers: samplePeers
    }
    await savePeerCache([], filePath) // create dir
    await writeFile(filePath, JSON.stringify(oldCache))

    const result = await loadPeerCache(filePath, 7)
    assert.equal(result, null)
  })

  it('accepts cache within max age', async () => {
    const filePath = join(testDir, 'fresh.json')

    // Write a cache with a timestamp 1 day ago
    const freshCache = {
      version: 1,
      savedAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(),
      peers: samplePeers
    }
    await savePeerCache([], filePath) // create dir
    await writeFile(filePath, JSON.stringify(freshCache))

    const result = await loadPeerCache(filePath, 7)
    assert.notEqual(result, null)
    assert.equal(result.length, 2)
  })

  it('returns null for wrong version', async () => {
    const filePath = join(testDir, 'wrong-version.json')
    await savePeerCache([], filePath) // create dir
    await writeFile(filePath, JSON.stringify({ version: 99, savedAt: new Date().toISOString(), peers: [] }))

    const result = await loadPeerCache(filePath)
    assert.equal(result, null)
  })
})

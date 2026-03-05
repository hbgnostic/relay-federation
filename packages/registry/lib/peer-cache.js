import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

const CACHE_VERSION = 1
const DEFAULT_MAX_AGE_DAYS = 7

/**
 * Save a peer list to a local JSON cache file.
 *
 * @param {Array} peers — Peer objects from buildPeerList()
 * @param {string} filePath — Path to the cache file
 */
export async function savePeerCache (peers, filePath) {
  const cache = {
    version: CACHE_VERSION,
    savedAt: new Date().toISOString(),
    peers
  }
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, JSON.stringify(cache, null, 2))
}

/**
 * Load peers from a local JSON cache file.
 *
 * Returns the peer array if the cache exists and is not expired.
 * Returns null if the file is missing, corrupted, or expired.
 *
 * @param {string} filePath — Path to the cache file
 * @param {number} [maxAgeDays=7] — Maximum age in days before cache is stale
 * @returns {Promise<Array|null>}
 */
export async function loadPeerCache (filePath, maxAgeDays = DEFAULT_MAX_AGE_DAYS) {
  let raw
  try {
    raw = await readFile(filePath, 'utf8')
  } catch {
    return null // file missing
  }

  let cache
  try {
    cache = JSON.parse(raw)
  } catch {
    return null // corrupted JSON
  }

  if (!cache || cache.version !== CACHE_VERSION || !Array.isArray(cache.peers)) {
    return null // wrong format
  }

  if (!cache.savedAt) return null

  const savedAt = new Date(cache.savedAt)
  const ageMs = Date.now() - savedAt.getTime()
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000

  if (ageMs > maxAgeMs) {
    return null // expired
  }

  return cache.peers
}

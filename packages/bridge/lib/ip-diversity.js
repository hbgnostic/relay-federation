/**
 * IP Diversity — enforces minimum /16 subnet diversity among peers.
 *
 * Prevents all connections from clustering in the same datacenter
 * by tracking the /16 prefix (first two octets) of each peer's IP.
 *
 * Rules:
 *   - Once we have 3+ peers, at least 3 different /16 subnets must be present
 *   - A new connection is rejected if it would reduce subnet count below the minimum
 *   - Non-IP hostnames are always allowed (can't determine subnet)
 */

/**
 * Extract the /16 subnet prefix from a WebSocket endpoint URL.
 *
 * @param {string} endpoint — ws:// or wss:// URL
 * @returns {string|null} First two octets (e.g. '144.202') or null if not an IP
 */
export function extractSubnet (endpoint) {
  try {
    const url = new URL(endpoint)
    const host = url.hostname

    // Check if host is an IPv4 address
    const parts = host.split('.')
    if (parts.length !== 4) return null
    if (!parts.every(p => /^\d{1,3}$/.test(p) && Number(p) <= 255)) return null

    return `${parts[0]}.${parts[1]}`
  } catch {
    return null
  }
}

/**
 * Count unique /16 subnets in a set of endpoints.
 *
 * @param {string[]} endpoints — array of ws:// or wss:// URLs
 * @returns {Set<string>} Set of unique /16 subnet prefixes
 */
export function getSubnets (endpoints) {
  const subnets = new Set()
  for (const ep of endpoints) {
    const subnet = extractSubnet(ep)
    if (subnet) subnets.add(subnet)
  }
  return subnets
}

/**
 * Check if connecting to a candidate endpoint would maintain IP diversity.
 *
 * @param {string[]} connectedEndpoints — endpoints of currently connected peers
 * @param {string} candidateEndpoint — endpoint of peer we want to connect to
 * @param {number} [minSubnets=3] — minimum number of unique /16 subnets required
 * @returns {{ allowed: boolean, reason?: string }}
 */
export function checkIpDiversity (connectedEndpoints, candidateEndpoint, minSubnets = 3) {
  const candidateSubnet = extractSubnet(candidateEndpoint)

  // Non-IP endpoints are always allowed (hostname-based — can't determine subnet)
  if (!candidateSubnet) {
    return { allowed: true }
  }

  // If we don't have enough peers yet, always allow
  if (connectedEndpoints.length < minSubnets) {
    return { allowed: true }
  }

  // Get current subnet distribution
  const currentSubnets = getSubnets(connectedEndpoints)

  // If candidate is in a subnet we already have, check if we'd still meet minimum
  if (currentSubnets.has(candidateSubnet)) {
    // Already have this subnet — only block if we're at exactly minSubnets
    // and too many peers are in this subnet (>50% of connections)
    const sameSubnetCount = connectedEndpoints.filter(ep => extractSubnet(ep) === candidateSubnet).length
    const totalAfter = connectedEndpoints.length + 1
    if (sameSubnetCount + 1 > Math.floor(totalAfter / 2) && currentSubnets.size <= minSubnets) {
      return { allowed: false, reason: `subnet ${candidateSubnet}.x.x already has ${sameSubnetCount}/${connectedEndpoints.length} peers` }
    }
    return { allowed: true }
  }

  // New subnet — always good for diversity
  return { allowed: true }
}

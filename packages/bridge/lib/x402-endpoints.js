/**
 * x402-endpoints.js — Discovery endpoint for x402 payment middleware.
 *
 * GET /.well-known/x402 — returns pricing info, free endpoints, payTo address.
 */

/**
 * Handle GET /.well-known/x402 — pricing discovery.
 *
 * @param {object} config — bridge config with x402 section
 * @param {string} version — bridge version string
 * @param {import('node:http').ServerResponse} res
 */
export function handleWellKnownX402 (config, version, res) {
  const pricingMap = config.x402?.endpoints || {}
  const endpoints = []
  for (const [key, satoshis] of Object.entries(pricingMap)) {
    const colonIdx = key.indexOf(':')
    if (colonIdx === -1) continue
    const method = key.slice(0, colonIdx)
    const path = key.slice(colonIdx + 1)
    endpoints.push({ method, path, satoshis })
  }

  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
  res.end(JSON.stringify({
    x402Version: '1',
    bridge: 'relay-federation',
    version,
    payTo: config.x402?.payTo || '',
    enabled: !!(config.x402?.enabled && config.x402?.payTo),
    endpoints,
    freeEndpoints: [
      '/health',
      '/.well-known/x402',
      '/status',
      '/api/address/*/unspent',
      '/api/address/*/history',
      '/api/address/*/balance',
      '/api/tx/*/hex',
      '/api/tx/*',
      '/api/sessions/*',
      '/api/sessions/index'
    ]
  }))
}

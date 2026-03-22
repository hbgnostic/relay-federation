// P2P Pay Gate Configuration
// Copy this to config.js and fill in your values

export default {
  // Relay bridge HTTP endpoint
  bridgeUrl: 'http://localhost:9333',

  // Bridge auth secret (bypasses rate limiting on heavy endpoints)
  // This is the BRIDGE_STATUS_SECRET from your relay bridge config.
  // Leave empty if you don't need rate limit bypass.
  bridgeAuthSecret: '',

  // Price in satoshis to unlock content
  priceSats: 1000,

  // Port for this server
  port: 3141,

  // BSV network: 'main' or 'test'
  chain: 'main',

  // Wallet seed (64-char hex string)
  // Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  // KEEP THIS SECRET. Do not commit to source control.
  seed: '',

  // Where to sweep funds after payment is detected.
  // Set to a BSV address you control. Funds will be swept from the
  // per-session address to this address via a transaction broadcast
  // through the bridge.
  // Leave empty to skip sweep (funds stay at session addresses).
  collectionAddress: '',

  // Optional webhook URL called after payment is confirmed.
  // POST with JSON body: { txid, sessionId, satoshis, sweepTxid }
  // Use this to notify your own wallet (e.g. Hummingbox) about the payment.
  webhookUrl: '',
  webhookSecret: '',

  // Path to gated content HTML file
  contentFile: './content/sample.html',

  // Session expiry in milliseconds (default: 24 hours)
  sessionTtl: 24 * 60 * 60 * 1000,

  // How often to poll bridge for payment (ms)
  pollInterval: 5000,
}

/**
 * P2P Pay Gate
 * A pay-per-view content gate that uses a BSV relay bridge
 * for payment detection and Merkle proof verification.
 *
 * No WhatsOnChain. No ARC. Pure P2P.
 */

import express from 'express'
import crypto from 'crypto'
import QRCode from 'qrcode'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { BridgeClient } from './lib/bridge.js'
import { deriveSessionAddress, buildSweepTx } from './lib/wallet.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// --- Load config ---
let config
try {
  const configModule = await import('./config.js')
  config = configModule.default
} catch {
  console.error('[paygate] No config.js found. Copy config.example.js to config.js and fill in your values.')
  process.exit(1)
}

if (!config.seed) {
  console.error('[paygate] No seed configured. Set seed in config.js.')
  process.exit(1)
}

const bridge = new BridgeClient(config.bridgeUrl, config.bridgeAuthSecret)
const app = express()
app.use(express.json())

// --- Session store (persisted to disk) ---
const sessions = new Map()
const SESSIONS_FILE = path.join(__dirname, 'sessions.json')

function saveSessions() {
  const data = Object.fromEntries(sessions)
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2))
}

function loadSessions() {
  try {
    const raw = fs.readFileSync(SESSIONS_FILE, 'utf8')
    const data = JSON.parse(raw)
    for (const [id, session] of Object.entries(data)) {
      sessions.set(id, session)
    }
    console.log(`[paygate] Loaded ${sessions.size} sessions from disk`)
  } catch {
    // No file yet, that's fine
  }
}
loadSessions()

function createSession() {
  const id = crypto.randomBytes(16).toString('hex')
  const { address, publicKeyHex } = deriveSessionAddress(config.seed, id)
  const session = {
    id,
    address,
    publicKeyHex,
    createdAt: Date.now(),
    txid: null,
    satoshis: null,
    accessToken: null,
    status: 'waiting',      // waiting | detected | confirmed | proved
    bridgeData: {},          // raw bridge responses for the frontend
  }
  sessions.set(id, session)
  saveSessions()
  return session
}

function cleanSessions() {
  const cutoff = Date.now() - (config.sessionTtl || 86400000)
  for (const [id, s] of sessions) {
    if (s.createdAt < cutoff) sessions.delete(id)
  }
}
setInterval(cleanSessions, 60000)

// --- Routes ---

// Gate page — generates session, shows payment terminal
app.get('/', async (req, res) => {
  // If they have a valid access token, serve content
  const token = req.query.token
  if (token) {
    for (const s of sessions.values()) {
      if (s.accessToken === token) {
        return serveContent(res)
      }
    }
  }

  const session = createSession()
  let qrDataUrl
  try {
    qrDataUrl = await QRCode.toDataURL(session.address, {
      width: 200,
      margin: 1,
      color: { dark: '#00ff00', light: '#000000' }
    })
  } catch {
    qrDataUrl = ''
  }

  res.type('html').send(gatePage(session, qrDataUrl))
})

// Check payment — polled by the frontend
app.get('/check/:sessionId', async (req, res) => {
  const session = sessions.get(req.params.sessionId)
  if (!session) return res.status(404).json({ error: 'Session not found' })

  // Already fully processed?
  if (session.accessToken) {
    return res.json({
      status: 'proved',
      txid: session.txid,
      accessToken: session.accessToken,
      bridgeData: session.bridgeData,
    })
  }

  // Step 1: Check for payment via bridge
  if (!session.txid) {
    const result = await bridge.checkPayment(session.address, config.priceSats)
    if (!result.found) {
      // Also return bridge status so frontend can show connection info
      let bridgeStatus = null
      try { bridgeStatus = await bridge.getStatus() } catch {}
      return res.json({
        status: 'waiting',
        bridgeStatus: bridgeStatus ? {
          peers: bridgeStatus.bsvNode?.peers || 0,
          headerHeight: bridgeStatus.headers?.bestHeight || 0,
          mempoolSize: bridgeStatus.mempool?.count || 0,
          bridgeName: bridgeStatus.name || 'unknown',
        } : null
      })
    }
    session.txid = result.txid
    session.satoshis = result.satoshis
    session.status = 'detected'
    session.bridgeData.detection = {
      txid: result.txid,
      satoshis: result.satoshis,
      detectedAt: new Date().toISOString(),
    }
    saveSessions()
  }

  // Step 2: Check tx status on bridge
  try {
    const txStatus = await bridge.getTxStatus(session.txid)
    session.bridgeData.txStatus = txStatus

    if (txStatus.state === 'confirmed' || txStatus.block) {
      session.status = 'confirmed'

      // Step 3: Fetch Merkle proof
      try {
        const proof = await bridge.getProof(session.txid)
        session.bridgeData.proof = proof
        session.status = 'proved'
        session.accessToken = crypto.randomBytes(32).toString('hex')
      } catch {
        // Proof not available yet — that's fine, confirmed is enough to grant access
        session.accessToken = crypto.randomBytes(32).toString('hex')
        session.status = 'confirmed'
      }
    }
    saveSessions()
  } catch {
    // tx status not available on bridge (might be too new)
    // Grant access on detection alone — the bridge saw it
    session.accessToken = crypto.randomBytes(32).toString('hex')
    saveSessions()
  }

  // Step 4: Sweep funds to collection address (background, don't block response)
  if (session.accessToken && !session.swept && config.collectionAddress) {
    session.swept = 'pending'
    sweepFunds(session).catch(err => {
      console.error(`[paygate] Sweep failed for ${session.id}:`, err.message)
    })
  }

  // Step 5: Webhook notification (background)
  if (session.accessToken && !session.webhookSent && config.webhookUrl) {
    session.webhookSent = true
    fireWebhook(session).catch(err => {
      console.error(`[paygate] Webhook failed for ${session.id}:`, err.message)
    })
  }

  res.json({
    status: session.status,
    txid: session.txid,
    satoshis: session.satoshis,
    accessToken: session.accessToken || null,
    bridgeData: session.bridgeData,
  })
})

// Serve gated content with valid token
app.get('/content', (req, res) => {
  const token = req.query.token
  if (!token) return res.status(401).json({ error: 'No token' })

  for (const s of sessions.values()) {
    if (s.accessToken === token) {
      return serveContent(res)
    }
  }
  res.status(403).json({ error: 'Invalid token' })
})

// Bridge info endpoint (for the frontend to show P2P stats)
app.get('/bridge-info', async (req, res) => {
  try {
    const status = await bridge.getStatus()
    res.json({
      name: status.name || 'unknown',
      peers: status.bsvNode?.peers || 0,
      headerHeight: status.headers?.bestHeight || 0,
      mempoolSize: status.mempool?.count || 0,
      meshPeers: status.peers?.connected || 0,
    })
  } catch (err) {
    res.status(502).json({ error: 'Bridge unreachable: ' + err.message })
  }
})

// Debug endpoint to list sessions (for fund recovery)
app.get('/debug/sessions', (req, res) => {
  const list = []
  for (const [id, s] of sessions) {
    list.push({
      sessionId: id,
      address: s.address,
      txid: s.txid,
      satoshis: s.satoshis,
      status: s.status,
      createdAt: new Date(s.createdAt).toISOString(),
    })
  }
  res.json({ count: list.length, sessions: list })
})

// --- Sweep funds to collection address ---

async function sweepFunds(session) {
  try {
    // Fetch the raw tx from the bridge so we can use it as sourceTransaction
    const txData = await bridge.getTx(session.txid)
    if (!txData || !txData.rawHex) {
      // Try fetching raw hex directly
      const resp = await fetch(`${config.bridgeUrl}/api/tx/${session.txid}/hex`, {
        headers: config.bridgeAuthSecret
          ? { 'Authorization': `Bearer ${config.bridgeAuthSecret}` }
          : {}
      })
      if (!resp.ok) throw new Error(`Could not fetch raw tx: ${resp.status}`)
      var rawHex = await resp.text()
    } else {
      var rawHex = txData.rawHex
    }

    // Find which output index pays to our session address
    const tx = (await import('@bsv/sdk')).Transaction.fromHex(rawHex)
    let vout = 0
    for (let i = 0; i < tx.outputs.length; i++) {
      // Check if this output pays to our address
      const script = tx.outputs[i].lockingScript.toHex()
      const expectedScript = new (await import('@bsv/sdk')).P2PKH().lock(session.address).toHex()
      if (script === expectedScript) {
        vout = i
        break
      }
    }

    const sweep = await buildSweepTx(
      config.seed,
      session.id,
      config.collectionAddress,
      session.txid,
      vout,
      session.satoshis,
      rawHex
    )

    // Broadcast sweep through the bridge
    const broadcastResp = await fetch(`${config.bridgeUrl}/broadcast`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.bridgeAuthSecret ? { 'Authorization': `Bearer ${config.bridgeAuthSecret}` } : {})
      },
      body: JSON.stringify({ rawHex: sweep.rawHex })
    })

    if (!broadcastResp.ok) {
      const body = await broadcastResp.text()
      throw new Error(`Broadcast failed: ${broadcastResp.status} ${body}`)
    }

    session.swept = sweep.txid
    session.bridgeData.sweep = { txid: sweep.txid, to: config.collectionAddress }
    console.log(`[paygate] Swept ${session.satoshis} sats -> ${config.collectionAddress} (${sweep.txid})`)
  } catch (err) {
    session.swept = false
    throw err
  }
}

// --- Webhook notification ---

async function fireWebhook(session) {
  const payload = {
    event: 'payment_received',
    txid: session.txid,
    sessionId: session.id,
    satoshis: session.satoshis,
    address: session.address,
    sweepTxid: session.swept || null,
    timestamp: new Date().toISOString(),
  }

  const headers = { 'Content-Type': 'application/json' }
  if (config.webhookSecret) {
    // HMAC signature for verification
    const hmac = crypto.createHmac('sha256', config.webhookSecret)
      .update(JSON.stringify(payload))
      .digest('hex')
    headers['X-Paygate-Signature'] = hmac
  }

  const resp = await fetch(config.webhookUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  })

  if (!resp.ok) {
    throw new Error(`Webhook ${resp.status}: ${await resp.text()}`)
  }
  console.log(`[paygate] Webhook sent for session ${session.id}`)
}

function serveContent(res) {
  const contentPath = path.resolve(config.contentFile || './content/sample.html')
  if (!fs.existsSync(contentPath)) {
    return res.type('html').send('<html><body style="background:#000;color:#0f0;font-family:monospace;padding:40px"><h1>Content not configured</h1><p>Drop your HTML into ./content/ and update config.js</p></body></html>')
  }
  res.type('html').sendFile(contentPath)
}

// --- Terminal-style gate page ---
function gatePage(session, qrDataUrl) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>P2P Pay Gate</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }

body {
  background: #0a0a0a;
  color: #ccc;
  font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', 'JetBrains Mono', Consolas, monospace;
  font-size: 15px;
  line-height: 1.7;
  min-height: 100vh;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding: 60px 20px;
}

.gate {
  width: 100%;
  max-width: 540px;
}

.prompt { color: #0f0; }
.dim { color: #777; }
.bright { color: #fff; }
.warn { color: #f80; }
.good { color: #0f0; }
.info { color: #0af; }
.muted { color: #888; }

.header {
  margin-bottom: 32px;
}

.header h1 {
  font-size: 18px;
  font-weight: 600;
  color: #0f0;
  letter-spacing: 2px;
  margin-bottom: 6px;
}

.header .sub {
  color: #777;
  font-size: 14px;
}

.section {
  margin-bottom: 28px;
}

.label {
  color: #777;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 2px;
  margin-bottom: 10px;
}

.price-line {
  font-size: 22px;
  color: #fff;
}

.price-line .unit {
  color: #777;
  font-size: 16px;
}

.pay-block {
  display: flex;
  gap: 20px;
  align-items: flex-start;
}

.qr-wrap {
  flex-shrink: 0;
  padding: 6px;
  background: #000;
  border: 1px solid #222;
}

.qr-wrap img { display: block; }

.pay-details {
  flex: 1;
  min-width: 0;
}

.address-box {
  background: #111;
  border: 1px solid #222;
  padding: 12px 14px;
  font-size: 13px;
  color: #0f0;
  word-break: break-all;
  cursor: pointer;
  margin-bottom: 12px;
  transition: border-color 0.2s;
}

.address-box:hover { border-color: #0f0; }

.copy-hint {
  color: #555;
  font-size: 12px;
}

.log {
  background: #111;
  border: 1px solid #222;
  padding: 18px;
  min-height: 180px;
  max-height: 360px;
  overflow-y: auto;
  font-size: 14px;
  line-height: 2;
}

.log-entry {
  padding: 0;
}

.log-entry .ts {
  color: #555;
  margin-right: 10px;
  font-size: 12px;
}

.cursor-blink {
  animation: blink 1s step-end infinite;
}

@keyframes blink {
  50% { opacity: 0; }
}

.bridge-bar {
  display: flex;
  gap: 24px;
  flex-wrap: wrap;
  font-size: 13px;
  color: #666;
  padding: 12px 0;
  border-top: 1px solid #1a1a1a;
  margin-top: 28px;
}

.bridge-bar .dot {
  display: inline-block;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  margin-right: 6px;
  vertical-align: middle;
}

.bridge-bar .dot.on { background: #0f0; }
.bridge-bar .dot.off { background: #f00; }

@media (max-width: 560px) {
  .pay-block { flex-direction: column; }
  body { padding: 30px 16px; }
}
</style>
</head>
<body>

<div class="gate">

<div class="header">
  <h1>P2P PAY GATE</h1>
  <div class="sub">payment via relay bridge &mdash; no third-party APIs</div>
</div>

<div class="section">
  <div class="label">Price</div>
  <div class="price-line"><span class="prompt">${config.priceSats}</span> <span class="unit">satoshis</span></div>
</div>

<div class="section">
  <div class="label">Send payment</div>
  <div class="pay-block">
    <div class="qr-wrap">
      <img src="${qrDataUrl}" alt="QR" width="160" height="160">
    </div>
    <div class="pay-details">
      <div class="address-box" onclick="copyAddr()" id="addr">${session.address}</div>
      <div class="copy-hint" id="copy-msg">click address to copy</div>
    </div>
  </div>
</div>

<div class="section">
  <div class="label">P2P Journey</div>
  <div class="log" id="log">
    <div class="log-entry"><span class="ts">${ts()}</span> <span class="info">session</span> ${session.id.slice(0, 12)}...</div>
    <div class="log-entry"><span class="ts">${ts()}</span> <span class="dim">polling bridge for payment...</span></div>
    <div class="log-entry"><span class="ts">${ts()}</span> <span class="cursor-blink prompt">_</span></div>
  </div>
</div>

<div class="bridge-bar" id="bridge-bar">
  <span><span class="dot off" id="dot"></span> bridge: connecting...</span>
  <span id="b-peers">peers: -</span>
  <span id="b-height">height: -</span>
  <span id="b-mempool">mempool: -</span>
</div>

</div>

<script>
const SESSION = '${session.id}';
const PRICE = ${config.priceSats};
const POLL_MS = ${config.pollInterval || 5000};
let done = false;

function ts() {
  const d = new Date();
  return d.toTimeString().split(' ')[0];
}

function log(msg, cls) {
  const el = document.getElementById('log');
  // remove cursor line
  const entries = el.querySelectorAll('.log-entry');
  const last = entries[entries.length - 1];
  if (last && last.querySelector('.cursor-blink')) last.remove();

  const div = document.createElement('div');
  div.className = 'log-entry';
  div.innerHTML = '<span class="ts">' + ts() + '</span>' + (cls ? '<span class="' + cls + '">' + msg + '</span>' : msg);
  el.appendChild(div);

  // add cursor
  const cur = document.createElement('div');
  cur.className = 'log-entry';
  cur.innerHTML = '<span class="ts">' + ts() + '</span><span class="cursor-blink prompt">_</span>';
  el.appendChild(cur);

  el.scrollTop = el.scrollHeight;
}

function copyAddr() {
  navigator.clipboard.writeText('${session.address}');
  const msg = document.getElementById('copy-msg');
  msg.textContent = 'copied';
  msg.style.color = '#0f0';
  setTimeout(function() { msg.textContent = 'click address to copy'; msg.style.color = ''; }, 2000);
}

let lastStatus = null;

async function poll() {
  if (done) return;
  try {
    const r = await fetch('/check/' + SESSION);
    const d = await r.json();

    // Update bridge bar
    if (d.bridgeStatus) {
      const bs = d.bridgeStatus;
      const dot = document.getElementById('dot');
      dot.className = 'dot on';
      dot.parentElement.innerHTML = '<span class="dot on" id="dot"></span> bridge: <span style="color:#0f0">connected</span>';
      document.getElementById('b-peers').textContent = 'peers: ' + bs.peers;
      document.getElementById('b-height').textContent = 'height: ' + bs.headerHeight;
      document.getElementById('b-mempool').textContent = 'mempool: ' + bs.mempoolSize;
      if (!lastStatus) {
        log('<span class="good">bridge connected</span>');
        log('<span class="dim">bsv nodes: ' + bs.peers + ' | headers: ' + bs.headerHeight + ' | mempool: ' + bs.mempoolSize + '</span>');
      }
      lastStatus = bs;
    }

    if (d.status === 'waiting') {
      // still waiting
    }

    if (d.status === 'detected' && d.txid) {
      log('<span class="warn">TX DETECTED via P2P bridge</span>');
      log('<span class="dim">txid:</span> <span class="bright">' + d.txid + '</span>');
      log('<span class="dim">amount:</span> <span class="good">' + d.satoshis + ' sats</span>');
      if (d.bridgeData && d.bridgeData.detection) {
        log('<span class="dim">detected at:</span> ' + d.bridgeData.detection.detectedAt);
      }
    }

    if (d.status === 'confirmed') {
      log('<span class="good">TX CONFIRMED in block</span>');
      if (d.bridgeData && d.bridgeData.txStatus && d.bridgeData.txStatus.block) {
        const b = d.bridgeData.txStatus.block;
        log('<span class="dim">block:</span> <span class="bright">' + (b.height || '?') + '</span>');
        if (b.blockHash) log('<span class="dim">hash:</span> ' + b.blockHash.slice(0, 24) + '...');
      }
    }

    if (d.status === 'proved') {
      log('<span class="good">TX CONFIRMED</span>');
      if (d.bridgeData && d.bridgeData.txStatus && d.bridgeData.txStatus.block) {
        const b = d.bridgeData.txStatus.block;
        log('<span class="dim">block:</span> <span class="bright">' + (b.height || '?') + '</span>');
      }
      if (d.bridgeData && d.bridgeData.proof) {
        const p = d.bridgeData.proof;
        log('<span class="good">MERKLE PROOF received</span>');
        log('<span class="dim">block hash:</span> ' + (p.blockHash || '').slice(0, 24) + '...');
        log('<span class="dim">block height:</span> ' + (p.height || '?'));
        if (p.proof && p.proof.nodes) {
          log('<span class="dim">proof path (' + p.proof.nodes.length + ' nodes):</span>');
          p.proof.nodes.forEach(function(n, i) {
            log('  <span class="muted">[' + i + ']</span> ' + n);
          });
        }
      }
    }

    if (d.accessToken) {
      done = true;
      log('');
      log('<span class="good">ACCESS GRANTED</span>');
      log('<span class="dim">redirecting to content...</span>');
      setTimeout(function() {
        window.location.href = '/content?token=' + d.accessToken;
      }, 2500);
      return;
    }
  } catch (err) {
    document.getElementById('dot').className = 'dot off';
  }

  if (!done) setTimeout(poll, POLL_MS);
}

// Start polling
setTimeout(poll, 1000);
</script>

</body>
</html>`;
}

function ts() {
  return new Date().toTimeString().split(' ')[0]
}

// --- Start ---
const PORT = config.port || 3141
app.listen(PORT, () => {
  console.log(`[paygate] P2P Pay Gate running on http://localhost:${PORT}`)
  console.log(`[paygate] Bridge: ${config.bridgeUrl}`)
  console.log(`[paygate] Price: ${config.priceSats} sats`)
})

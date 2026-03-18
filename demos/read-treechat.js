// Read TreeChat posts directly from the BSV blockchain
// No TreeChat API. No middleman. Just P2P block data through your bridge.
//
// Usage:
//   node demos/read-treechat.js                          # scan latest block
//   node demos/read-treechat.js --blocks 10              # scan last 10 blocks
//   node demos/read-treechat.js --bridge http://IP:9333  # use a specific bridge
//
// Requires: your relay-federation fork with /block/:height/transactions endpoint

const TREECHAT_MARKER = '7472656563686174' // "treechat" in hex

// --- Config ---
const args = process.argv.slice(2)
const bridgeUrl = getArg('--bridge') || 'http://34.122.254.59:9333'
const blockCount = parseInt(getArg('--blocks') || '1')
const authSecret = process.env.BRIDGE_SECRET || ''

function getArg (flag) {
  const idx = args.indexOf(flag)
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : null
}

function hexToUtf8 (hex) {
  if (!hex) return ''
  const bytes = []
  for (let i = 0; i < hex.length; i += 2) {
    bytes.push(parseInt(hex.slice(i, i + 2), 16))
  }
  return Buffer.from(bytes).toString('utf8')
}

// --- Main ---
console.log(`\n🔗 Bridge: ${bridgeUrl}`)
console.log(`📦 Scanning ${blockCount} block(s) for TreeChat posts...\n`)

// 1. Get current chain height from bridge status
const headers = { 'Content-Type': 'application/json' }
if (authSecret) headers['Authorization'] = `Bearer ${authSecret}`

const statusRes = await fetch(`${bridgeUrl}/status`, { headers })
if (!statusRes.ok) {
  console.error(`❌ Bridge unreachable: ${statusRes.status}`)
  process.exit(1)
}
const status = await statusRes.json()
const tipHeight = status.headers.bestHeight
console.log(`📡 Chain tip: block ${tipHeight}`)
console.log(`🔍 Scanning blocks ${tipHeight - blockCount + 1} → ${tipHeight}\n`)

// 2. Scan each block for TreeChat transactions
let totalTxs = 0
let treechatPosts = []

for (let h = tipHeight - blockCount + 1; h <= tipHeight; h++) {
  process.stdout.write(`  Block ${h}...`)

  try {
    const blockRes = await fetch(`${bridgeUrl}/block/${h}/transactions`, { headers })
    if (!blockRes.ok) {
      console.log(` ❌ ${blockRes.status}`)
      continue
    }

    const block = await blockRes.json()
    totalTxs += block.txCount

    // Find transactions with TreeChat OP_RETURN outputs
    for (const tx of block.transactions) {
      if (!tx.outputs) continue

      for (const output of tx.outputs) {
        if (output.type !== 'op_return' || !output.data) continue

        // Check if any push data contains the TreeChat marker
        const hasTreeChat = output.data.some(push => push === TREECHAT_MARKER)
        if (!hasTreeChat) continue

        // Decode all push data to find the message content
        const decoded = output.data.map(push => {
          if (push === TREECHAT_MARKER) return { role: 'marker', value: 'treechat' }
          const text = hexToUtf8(push)
          // Heuristic: if it decodes to readable text, it's probably content
          const isPrintable = /^[\x20-\x7E\n\r\t]+$/.test(text) && text.length > 1
          return { role: isPrintable ? 'text' : 'data', hex: push, value: text }
        })

        treechatPosts.push({
          txid: tx.txid,
          blockHeight: h,
          pushes: decoded,
          rawPushes: output.data
        })
      }
    }

    const found = treechatPosts.filter(p => p.blockHeight === h).length
    console.log(` ${block.txCount} txs` + (found > 0 ? ` — 🌳 ${found} TreeChat post(s)!` : ''))
  } catch (err) {
    console.log(` ❌ ${err.message}`)
  }
}

// 3. Display results
console.log(`\n${'═'.repeat(60)}`)
console.log(`  RESULTS: Scanned ${totalTxs} transactions across ${blockCount} blocks`)
console.log(`  Found ${treechatPosts.length} TreeChat post(s)`)
console.log(`${'═'.repeat(60)}\n`)

if (treechatPosts.length === 0) {
  console.log('No TreeChat posts found in this block range.')
  console.log('Try scanning more blocks: node demos/read-treechat.js --blocks 50\n')
  console.log('Remember: this is reading raw blockchain data via P2P.')
  console.log('No API. No app. Just your bridge talking to BSV nodes.\n')
} else {
  for (const post of treechatPosts) {
    console.log(`─── TreeChat Post ───────────────────────────────`)
    console.log(`  txid:  ${post.txid}`)
    console.log(`  block: ${post.blockHeight}`)
    console.log()

    // Show decoded push data
    for (const push of post.pushes) {
      if (push.role === 'marker') {
        console.log(`  [protocol]  treechat`)
      } else if (push.role === 'text') {
        console.log(`  [content]   ${push.value}`)
      } else {
        console.log(`  [data]      ${push.hex.slice(0, 40)}${push.hex.length > 40 ? '...' : ''}`)
      }
    }
    console.log()
  }
}

console.log('─────────────────────────────────────────────────')
console.log('This data was read directly from BSV blocks via P2P.')
console.log('No TreeChat API was used. No API key. No permission needed.')
console.log('The blockchain is a public record. Your bridge is your lens.\n')

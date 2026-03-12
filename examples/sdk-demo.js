// SDK demo — connect to a bridge and explore the mesh
// Usage: node sdk-demo.js [bridge-url]
//
// Default bridge: http://localhost:9333

import { RelayBridge } from '@relay-federation/sdk'

const url = process.argv[2] || 'http://localhost:9333'
const bridge = new RelayBridge(url)

// 1. Bridge status
const status = await bridge.getStatus()
console.log('=== Bridge Status ===')
console.log(`  Mesh:    ${status.bridge.meshId}`)
console.log(`  Height:  ${status.headers.bestHeight}`)
console.log(`  Peers:   ${status.peers.connected}`)
console.log(`  Mempool: ${status.txs.mempool} txs`)
console.log(`  BSV P2P: ${status.bsvNode.peers} peers`)
console.log()

// 2. Discover the mesh
const mesh = await bridge.discover()
console.log(`=== Mesh Discovery (${mesh.count} bridges) ===`)
for (const b of mesh.bridges) {
  console.log(`  ${b.pubkeyHex?.slice(0, 12)}...  ${b.endpoint}  mesh=${b.meshId}`)
}
console.log()

// 3. Inscriptions
const inscriptions = await bridge.getInscriptions({ limit: 5 })
console.log(`=== Inscriptions (${inscriptions.count} of ${inscriptions.total}) ===`)
for (const i of inscriptions.inscriptions) {
  console.log(`  ${i.txid.slice(0, 12)}... ${i.contentType} (${i.contentSize} bytes)`)
}
console.log()

// 4. Apps
const apps = await bridge.getApps()
if (apps.apps.length > 0) {
  console.log(`=== Apps (${apps.apps.length}) ===`)
  for (const a of apps.apps) {
    console.log(`  ${a.name}: ${a.health.status} (${a.health.uptimePercent}% uptime)`)
  }
} else {
  console.log('=== No apps configured on this bridge ===')
}

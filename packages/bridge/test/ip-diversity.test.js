import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { extractSubnet, getSubnets, checkIpDiversity } from '../lib/ip-diversity.js'

describe('extractSubnet', () => {
  it('extracts /16 from ws:// IP endpoint', () => {
    assert.equal(extractSubnet('ws://144.202.48.217:8333'), '144.202')
  })

  it('extracts /16 from wss:// IP endpoint', () => {
    assert.equal(extractSubnet('wss://45.63.77.31:8333'), '45.63')
  })

  it('returns null for hostname endpoints', () => {
    assert.equal(extractSubnet('wss://bridge.example.com:8333'), null)
  })

  it('returns null for invalid URL', () => {
    assert.equal(extractSubnet('not-a-url'), null)
  })

  it('returns null for IPv6', () => {
    assert.equal(extractSubnet('ws://[::1]:8333'), null)
  })

  it('returns null for localhost', () => {
    assert.equal(extractSubnet('ws://localhost:8333'), null)
  })
})

describe('getSubnets', () => {
  it('returns unique subnets from endpoint list', () => {
    const endpoints = [
      'ws://144.202.48.217:8333',
      'ws://144.202.99.1:8333',
      'ws://45.63.77.31:8333',
      'ws://10.0.0.1:8333'
    ]
    const subnets = getSubnets(endpoints)
    assert.equal(subnets.size, 3)
    assert.ok(subnets.has('144.202'))
    assert.ok(subnets.has('45.63'))
    assert.ok(subnets.has('10.0'))
  })

  it('ignores hostname endpoints', () => {
    const subnets = getSubnets(['wss://bridge.example.com:8333'])
    assert.equal(subnets.size, 0)
  })
})

describe('checkIpDiversity', () => {
  it('allows anything when fewer than minSubnets peers', () => {
    const result = checkIpDiversity(
      ['ws://144.202.1.1:8333', 'ws://144.202.2.2:8333'],
      'ws://144.202.3.3:8333'
    )
    assert.equal(result.allowed, true)
  })

  it('allows new subnet — always good for diversity', () => {
    const connected = [
      'ws://144.202.1.1:8333',
      'ws://45.63.1.1:8333',
      'ws://10.0.1.1:8333'
    ]
    const result = checkIpDiversity(connected, 'ws://192.168.1.1:8333')
    assert.equal(result.allowed, true)
  })

  it('allows hostname endpoints (cannot determine subnet)', () => {
    const connected = [
      'ws://144.202.1.1:8333',
      'ws://144.202.2.2:8333',
      'ws://144.202.3.3:8333'
    ]
    const result = checkIpDiversity(connected, 'wss://bridge.example.com:8333')
    assert.equal(result.allowed, true)
  })

  it('blocks when one subnet would have >50% and diversity is low', () => {
    const connected = [
      'ws://144.202.1.1:8333',
      'ws://144.202.2.2:8333',
      'ws://45.63.1.1:8333'
    ]
    // Adding another 144.202 would make it 3/4 = 75% from same subnet
    // with only 2 subnets total (<=3 minimum)
    const result = checkIpDiversity(connected, 'ws://144.202.3.3:8333')
    assert.equal(result.allowed, false)
    assert.ok(result.reason.includes('144.202'))
  })

  it('allows same subnet when diversity is already good', () => {
    const connected = [
      'ws://144.202.1.1:8333',
      'ws://45.63.1.1:8333',
      'ws://10.0.1.1:8333',
      'ws://192.168.1.1:8333'
    ]
    // 4 subnets — diversity is good, adding another 144.202 is fine
    const result = checkIpDiversity(connected, 'ws://144.202.2.2:8333')
    assert.equal(result.allowed, true)
  })
})

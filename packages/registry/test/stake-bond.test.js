import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PrivateKey, Transaction, P2PKH } from '@bsv/sdk'
import { buildStakeBondTx } from '../lib/stake-bond.js'
import { MIN_STAKE_SATS } from '@relay-federation/common/protocol'

const testKey = PrivateKey.fromRandom()
const testWif = testKey.toWif()

function createFakeUtxo (privateKey, satoshis = 200_000_000) {
  const address = privateKey.toPublicKey().toAddress()
  const p2pkh = new P2PKH()
  const fakeTx = new Transaction()
  fakeTx.addOutput({ lockingScript: p2pkh.lock(address), satoshis })
  return { tx_hash: fakeTx.id('hex'), tx_pos: 0, value: satoshis, rawHex: fakeTx.toHex() }
}

describe('Stake bond tx builder', () => {
  it('builds a valid stake bond transaction', async () => {
    const utxo = createFakeUtxo(testKey)
    const result = await buildStakeBondTx({
      wif: testWif,
      utxos: [utxo]
    })

    assert.ok(result.txHex)
    assert.ok(result.txid)
    assert.equal(result.txid.length, 64)
    assert.equal(result.stakeOutputIndex, 0)

    // Parse and verify
    const tx = Transaction.fromHex(result.txHex)
    assert.ok(tx.outputs.length >= 2, 'should have stake + change outputs')

    // Stake output should have MIN_STAKE_SATS
    assert.equal(tx.outputs[0].satoshis, MIN_STAKE_SATS)
  })

  it('stake output is standard P2PKH to own address', async () => {
    const utxo = createFakeUtxo(testKey)
    const result = await buildStakeBondTx({
      wif: testWif,
      utxos: [utxo]
    })

    const tx = Transaction.fromHex(result.txHex)
    const scriptHex = tx.outputs[0].lockingScript.toHex()

    // Standard P2PKH: OP_DUP OP_HASH160 <20-byte hash> OP_EQUALVERIFY OP_CHECKSIG
    assert.ok(scriptHex.startsWith('76a914'), 'should start with DUP HASH160 PUSH20')
    assert.ok(scriptHex.endsWith('88ac'), 'should end with EQUALVERIFY CHECKSIG')
    assert.equal(scriptHex.length, 50, 'standard P2PKH is 25 bytes = 50 hex chars')

    // Should match bridge operator's own address
    const expectedScript = new P2PKH().lock(testKey.toPublicKey().toAddress()).toHex()
    assert.equal(scriptHex, expectedScript)
  })

  it('defaults to MIN_STAKE_SATS', async () => {
    const utxo = createFakeUtxo(testKey)
    const result = await buildStakeBondTx({
      wif: testWif,
      utxos: [utxo]
    })

    const tx = Transaction.fromHex(result.txHex)
    assert.equal(tx.outputs[0].satoshis, MIN_STAKE_SATS)
  })

  it('accepts custom stake amount', async () => {
    const utxo = createFakeUtxo(testKey)
    const result = await buildStakeBondTx({
      wif: testWif,
      utxos: [utxo],
      stakeAmountSats: 50_000_000
    })

    const tx = Transaction.fromHex(result.txHex)
    assert.equal(tx.outputs[0].satoshis, 50_000_000)
  })

  it('change output goes to same address', async () => {
    const utxo = createFakeUtxo(testKey)
    const result = await buildStakeBondTx({
      wif: testWif,
      utxos: [utxo],
      stakeAmountSats: 1000
    })

    const tx = Transaction.fromHex(result.txHex)
    const expectedScript = new P2PKH().lock(testKey.toPublicKey().toAddress()).toHex()

    // Both stake and change should go to same address
    assert.equal(tx.outputs[0].lockingScript.toHex(), expectedScript)
    if (tx.outputs.length > 1) {
      assert.equal(tx.outputs[1].lockingScript.toHex(), expectedScript)
    }
  })

  it('txid can be used as stake_txid in registration', async () => {
    const utxo = createFakeUtxo(testKey)
    const result = await buildStakeBondTx({
      wif: testWif,
      utxos: [utxo]
    })

    // Convert txid hex to 32-byte Uint8Array (as required by CBOR registration)
    const txidBytes = new Uint8Array(32)
    for (let i = 0; i < 32; i++) {
      txidBytes[i] = parseInt(result.txid.slice(i * 2, i * 2 + 2), 16)
    }
    assert.equal(txidBytes.length, 32)
  })
})

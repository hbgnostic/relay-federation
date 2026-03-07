import { Transaction, P2PKH, PrivateKey, SatoshisPerKilobyte } from '@bsv/sdk'
import { MIN_STAKE_SATS } from '@relay-federation/common/protocol'

/**
 * Build a stake bond transaction.
 *
 * Creates a P2PKH output to the bridge's own address with the stake amount.
 * The bridge locks funds to itself as proof-of-stake — the scanner monitors
 * the UTXO on-chain and flags the bridge if the bond is spent.
 *
 * OP_CHECKLOCKTIMEVERIFY is disabled on BSV (reverted to OP_NOP2 since
 * Genesis upgrade, Feb 2020), so script-level timelocks are not possible.
 * Enforcement is done by the scanner watching for spent bonds.
 *
 * @param {object} opts
 * @param {string} opts.wif - WIF private key of the bridge operator
 * @param {Array<{tx_hash: string, tx_pos: number, value: number, rawHex: string}>} opts.utxos
 * @param {number} [opts.stakeAmountSats] - Stake amount (defaults to MIN_STAKE_SATS)
 * @returns {Promise<{txHex: string, txid: string, stakeOutputIndex: number}>}
 */
export async function buildStakeBondTx (opts) {
  const { wif, utxos, stakeAmountSats = MIN_STAKE_SATS } = opts

  const privateKey = PrivateKey.fromWif(wif)
  const address = privateKey.toPublicKey().toAddress()
  const tx = new Transaction()
  const p2pkh = new P2PKH()
  const lockingScript = p2pkh.lock(address)

  // Add funding inputs
  for (const utxo of utxos) {
    const sourceTransaction = Transaction.fromHex(utxo.rawHex)
    tx.addInput({
      sourceTransaction,
      sourceOutputIndex: utxo.tx_pos,
      unlockingScriptTemplate: p2pkh.unlock(
        privateKey,
        'all',
        false,
        utxo.value,
        lockingScript
      )
    })
  }

  // Output 0: stake bond (P2PKH to self)
  tx.addOutput({
    lockingScript: p2pkh.lock(address),
    satoshis: stakeAmountSats
  })

  // Output 1: change back to self
  tx.addOutput({
    lockingScript: p2pkh.lock(address),
    change: true
  })

  await tx.fee(new SatoshisPerKilobyte(1000))
  await tx.sign()

  const txHex = tx.toHex()
  const txid = tx.id('hex')

  return { txHex, txid, stakeOutputIndex: 0 }
}

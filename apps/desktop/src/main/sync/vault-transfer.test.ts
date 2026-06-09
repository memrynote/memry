import { describe, it, expect, beforeAll } from 'vitest'
import sodium from 'libsodium-wrappers-sumo'

import {
  buildVaultTransfer,
  encryptVaultTransfer,
  decryptVaultTransfer,
  type VaultTransfer
} from './vault-transfer'

const SESSION = '11111111-1111-1111-1111-111111111111'
const transfer: VaultTransfer = {
  version: 1,
  vaults: [{ vaultUuid: '8945f5fd-0e05-45f5-bae5-2979737aa0d0' }]
}

beforeAll(async () => {
  await sodium.ready
})

const keys = () => ({
  encKey: sodium.randombytes_buf(32),
  macKey: sodium.randombytes_buf(32)
})

describe('vault-transfer', () => {
  it('round-trips an encrypted vault list', () => {
    const { encKey, macKey } = keys()
    const enc = encryptVaultTransfer({ transfer, sessionId: SESSION, encKey, macKey })
    const out = decryptVaultTransfer({ ...enc, sessionId: SESSION, encKey, macKey })
    expect(out).toEqual(transfer)
  })

  it('builds a transfer from a server vault list', () => {
    const t = buildVaultTransfer([
      { vaultUuid: 'v-a', itemCount: 367, createdAt: 1000 },
      { vaultUuid: 'v-b', itemCount: 4, createdAt: 2000 }
    ])
    expect(t).toEqual({
      version: 1,
      vaults: [
        { vaultUuid: 'v-a', itemCount: 367, createdAt: 1000 },
        { vaultUuid: 'v-b', itemCount: 4, createdAt: 2000 }
      ]
    })
  })

  it('rejects a tampered confirm', () => {
    const { encKey, macKey } = keys()
    const enc = encryptVaultTransfer({ transfer, sessionId: SESSION, encKey, macKey })
    expect(() =>
      decryptVaultTransfer({
        ...enc,
        vaultTransferConfirm: sodium.to_base64(
          sodium.randombytes_buf(32),
          sodium.base64_variants.ORIGINAL
        ),
        sessionId: SESSION,
        encKey,
        macKey
      })
    ).toThrow(/confirmation failed/i)
  })
})

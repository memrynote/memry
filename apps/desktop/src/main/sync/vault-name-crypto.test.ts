import { describe, it, expect, beforeAll } from 'vitest'
import sodium from 'libsodium-wrappers-sumo'

import { encryptVaultName, decryptVaultName } from './vault-name-crypto'

describe('vault name crypto', () => {
  let key: Uint8Array

  beforeAll(async () => {
    await sodium.ready
    key = sodium.randombytes_buf(32)
  })

  it('round-trips a vault name', () => {
    const { encryptedName, nameNonce } = encryptVaultName('Research Vault', key, 'uuid-1')
    expect(decryptVaultName(encryptedName, nameNonce, key, 'uuid-1')).toBe('Research Vault')
  })

  it('returns null when the vault uuid (AAD) does not match', () => {
    const { encryptedName, nameNonce } = encryptVaultName('Research Vault', key, 'uuid-1')
    expect(decryptVaultName(encryptedName, nameNonce, key, 'uuid-2')).toBeNull()
  })

  it('returns null when the key is wrong', () => {
    const { encryptedName, nameNonce } = encryptVaultName('Research Vault', key, 'uuid-1')
    const otherKey = sodium.randombytes_buf(32)
    expect(decryptVaultName(encryptedName, nameNonce, otherKey, 'uuid-1')).toBeNull()
  })

  it('returns null on garbage input', () => {
    expect(decryptVaultName('!!!not-base64', '???', key, 'uuid-1')).toBeNull()
  })
})

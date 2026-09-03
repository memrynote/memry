import { describe, expect, it } from 'vitest'

import { classifyVaultKeyError, vaultRecoveryReason } from './vault-key-error'

describe('classifyVaultKeyError', () => {
  it('flags a master-key/vault mismatch as recovery-needed', () => {
    expect(classifyVaultKeyError(new Error('Current master key does not match this vault'))).toBe(
      'recovery-needed'
    )
  })

  it('flags a missing master key with an existing verifier as recovery-needed', () => {
    expect(
      classifyVaultKeyError(new Error('Vault key verifier exists but master key is missing'))
    ).toBe('recovery-needed')
  })

  it('flags a transiently unreadable secret as transient, NOT recovery-needed', () => {
    // secret-storage.ts throws this when a persisted secret can't be read this
    // run — retrying is correct; prompting recovery would be wrong.
    expect(
      classifyVaultKeyError(
        new Error(
          'Secret com.memry.sync/master-key exists in the secret store but could not be read this run; refusing to report it as absent'
        )
      )
    ).toBe('transient')
  })

  it('treats unrelated errors as other', () => {
    expect(classifyVaultKeyError(new Error('network down'))).toBe('other')
    expect(classifyVaultKeyError('not an error object')).toBe('other')
  })

  it('maps the reason for the renderer event', () => {
    expect(vaultRecoveryReason(new Error('Current master key does not match this vault'))).toBe(
      'vault-key-mismatch'
    )
    expect(
      vaultRecoveryReason(new Error('Vault key verifier exists but master key is missing'))
    ).toBe('master-key-missing')
  })

  it('routes a key an account can restore to recovery, not to a generic failure', () => {
    const error = new Error(
      'Master key not found in keychain — cannot create a local vault key while sync credentials exist'
    )
    expect(classifyVaultKeyError(error)).toBe('recovery-needed')
    expect(vaultRecoveryReason(error)).toBe('master-key-missing')
  })
})

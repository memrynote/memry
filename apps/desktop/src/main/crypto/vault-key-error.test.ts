import { describe, expect, it } from 'vitest'

import {
  classifyVaultKeyError,
  isKeychainUnreadableError,
  vaultRecoveryReason
} from './vault-key-error'

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

  it('flags a timed-out or latched OS keychain as transient (#2521)', () => {
    // keychain.ts re-wraps secret-storage's KeychainUnavailableError messages.
    const timedOut = new Error(
      'Failed to retrieve key from keychain (master-key): OS keychain did not answer within 5000ms for com.memry.sync/master-key'
    )
    const latched = new Error(
      'Failed to retrieve key from keychain (refresh-token): OS keychain is unavailable until it answers an earlier request (com.memry.sync/refresh-token)'
    )
    // The wording shipped in 2026.928.1, still in flight from older workers/logs.
    const legacyLatched = new Error(
      'Failed to retrieve key from keychain (refresh-token): OS keychain is unavailable for the rest of this run (com.memry.sync/refresh-token)'
    )
    for (const error of [timedOut, latched, legacyLatched]) {
      expect(isKeychainUnreadableError(error)).toBe(true)
      expect(classifyVaultKeyError(error)).toBe('transient')
    }
  })

  it('does not call a mismatch or a missing key unreadable', () => {
    expect(
      isKeychainUnreadableError(new Error('Current master key does not match this vault'))
    ).toBe(false)
    expect(
      isKeychainUnreadableError(new Error('Vault key verifier exists but master key is missing'))
    ).toBe(false)
    expect(isKeychainUnreadableError(new Error('network down'))).toBe(false)
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

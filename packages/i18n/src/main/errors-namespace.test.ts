import { describe, expect, it } from 'vitest'
import { createMainI18n } from './index'

describe('errors namespace', () => {
  it('returns populated English error messages', async () => {
    const i18n = await createMainI18n({ locale: 'en' })

    expect(i18n.t('errors:vault.notFound')).toBe(
      'Vault not found. It may have been moved or deleted.'
    )
    expect(i18n.t('errors:sync.networkOffline')).toBe(
      'You are offline. Changes will sync when you reconnect.'
    )
    expect(i18n.t('errors:sync.engineNotInitialized')).toBe(
      'Sync engine not initialized. Open a vault to start sync.'
    )
  })

  it('falls back to English for Turkish and Arabic error stubs', async () => {
    const tr = await createMainI18n({ locale: 'tr' })
    const ar = await createMainI18n({ locale: 'ar' })

    expect(tr.t('errors:generic.operationFailed')).toBe('Operation failed')
    expect(ar.t('errors:sync.certificatePinFailed')).toBe(
      'Secure connection failed. Check your network connection.'
    )
  })

  it('keeps the namespace on missing keys', async () => {
    const i18n = await createMainI18n({ locale: 'tr' })

    expect(i18n.t('errors:missing.key')).toBe('errors:missing.key')
  })
})

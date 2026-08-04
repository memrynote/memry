import { describe, it, expect, beforeEach } from 'vitest'
import { createMainI18n } from '@memry/i18n/main'
import {
  setMainI18n,
  getMainI18n,
  isMainI18nInitialized,
  __resetMainI18nForTest
} from './main-i18n'

describe('main-i18n accessor', () => {
  beforeEach(() => {
    __resetMainI18nForTest()
  })

  it('falls back to English rather than throwing when accessed before set', () => {
    expect(isMainI18nInitialized()).toBe(false)
    // The user must see the message, not an initialization error. Boot order is
    // still reported, but to the log.
    expect(getMainI18n().t('system:dialog.vault.title')).toBe('Select Vault Folder')
  })

  it('interpolates ICU placeholders on the fallback instance', () => {
    expect(getMainI18n().t('errors:sync.attachmentUploadFailed', { filename: 'notes.pdf' })).toBe(
      'Couldn\'t sync attachment "notes.pdf". It stays on this device.'
    )
  })

  it('prefers the real instance once boot installs it', async () => {
    const instance = await createMainI18n({ locale: 'tr' })
    getMainI18n()
    setMainI18n(instance)
    expect(isMainI18nInitialized()).toBe(true)
    expect(getMainI18n()).toBe(instance)
  })

  it('returns the set instance', async () => {
    const instance = await createMainI18n({ locale: 'en' })
    setMainI18n(instance)
    expect(getMainI18n()).toBe(instance)
  })

  it('reflects changeLanguage mutation on the same instance', async () => {
    const instance = await createMainI18n({ locale: 'en' })
    setMainI18n(instance)
    expect(getMainI18n().t('system:dialog.vault.title')).toBe('Select Vault Folder')
    await getMainI18n().changeLanguage('tr')
    expect(getMainI18n().t('system:dialog.vault.title')).toBe('Kasa Klasörünü Seçin')
  })
})

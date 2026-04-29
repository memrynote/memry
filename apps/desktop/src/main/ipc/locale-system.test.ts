import { describe, it, expect, beforeAll } from 'vitest'
import { createMainI18n, type I18nInstance } from '@memry/i18n/main'

describe('main-process locale change propagates to system namespace', () => {
  let i18n: I18nInstance

  beforeAll(async () => {
    i18n = await createMainI18n({ locale: 'en' })
  })

  it('English: dialog title resolves', () => {
    expect(i18n.t('system:dialog.vault.title')).toBe('Select Vault Folder')
  })

  it('After changeLanguage(tr), key resolves to Turkish', async () => {
    await i18n.changeLanguage('tr')
    expect(i18n.t('system:dialog.vault.title')).toBe('Kasa Klasörünü Seçin')
  })

  it('After changeLanguage back to en, key resolves to English', async () => {
    await i18n.changeLanguage('en')
    expect(i18n.t('system:dialog.vault.title')).toBe('Select Vault Folder')
  })
})

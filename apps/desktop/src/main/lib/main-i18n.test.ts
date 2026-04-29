import { describe, it, expect, beforeEach } from 'vitest'
import { createMainI18n } from '@memry/i18n/main'
import { setMainI18n, getMainI18n, __resetMainI18nForTest } from './main-i18n'

describe('main-i18n accessor', () => {
  beforeEach(() => {
    __resetMainI18nForTest()
  })

  it('throws when accessed before set', () => {
    expect(() => getMainI18n()).toThrow(/not initialized/)
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
    expect(getMainI18n().t('system:dialog.vault.title')).toBe('Select Vault Folder')
  })
})

import { describe, it, expect } from 'vitest'
import { createMainI18n } from './index'

describe('createMainI18n', () => {
  it('initializes with the requested locale', async () => {
    const i18n = await createMainI18n({ locale: 'tr' })
    expect(i18n.language).toBe('tr')
  })

  it('translates a known menu key', async () => {
    const i18n = await createMainI18n({ locale: 'tr' })
    expect(i18n.t('menu:file.label')).toBe('Dosya')
  })

  it('loads the tasks namespace in the main i18n instance', async () => {
    const i18n = await createMainI18n({ locale: 'ar' })
    expect(i18n.t('tasks:page.tabs.today')).toBe('اليوم')
  })

  it('returns the key for nonexistent translations', async () => {
    const i18n = await createMainI18n({ locale: 'tr' })
    expect(i18n.t('menu:nonexistent.key')).toBe('menu:nonexistent.key')
  })

  it('changeLanguage updates the active locale', async () => {
    const i18n = await createMainI18n({ locale: 'en' })
    expect(i18n.t('menu:file.label')).toBe('File')
    await i18n.changeLanguage('tr')
    expect(i18n.t('menu:file.label')).toBe('Dosya')
  })
})

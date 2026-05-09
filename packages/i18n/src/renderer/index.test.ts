import { describe, it, expect } from 'vitest'
import { createRendererI18n } from './index'

describe('createRendererI18n', () => {
  it('initializes with the requested locale', async () => {
    const i18n = await createRendererI18n({ locale: 'tr' })
    expect(i18n.language).toBe('tr')
  })

  it('translates Turkish settings namespace strings', async () => {
    const i18n = await createRendererI18n({ locale: 'tr' })
    expect(i18n.t('settings:general.language.label')).toBe('Dil')
  })

  it('translates a tasks namespace string', async () => {
    const i18n = await createRendererI18n({ locale: 'en' })
    expect(i18n.t('tasks:task.add')).toBe('Add Task')
  })

  it('translates Turkish tasks namespace strings', async () => {
    const i18n = await createRendererI18n({ locale: 'tr' })
    expect(i18n.t('tasks:task.add')).toBe('Görev Ekle')
  })

  it('formats journal count labels with ICU placeholders', async () => {
    const i18n = await createRendererI18n({ locale: 'en' })
    expect(i18n.t('journal:count.overdue', { count: 3 })).toBe('3 overdue')
  })

  it('formats Turkish journal count labels with ICU placeholders', async () => {
    const i18n = await createRendererI18n({ locale: 'tr' })
    expect(i18n.t('journal:count.overdue', { count: 3 })).toBe('3 vadesi geçmiş')
  })

  it('changeLanguage works', async () => {
    const i18n = await createRendererI18n({ locale: 'en' })
    await i18n.changeLanguage('ar')
    expect(i18n.language).toBe('ar')
  })
})

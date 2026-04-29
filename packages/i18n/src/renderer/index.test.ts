import { describe, it, expect } from 'vitest'
import { createRendererI18n } from './index'

describe('createRendererI18n', () => {
  it('initializes with the requested locale', async () => {
    const i18n = await createRendererI18n({ locale: 'tr' })
    expect(i18n.language).toBe('tr')
  })

  it('translates a settings string', async () => {
    const i18n = await createRendererI18n({ locale: 'tr' })
    expect(i18n.t('settings:general.language.label')).toBe('Dil')
  })

  it('translates a tasks namespace string', async () => {
    const i18n = await createRendererI18n({ locale: 'en' })
    expect(i18n.t('tasks:task.add')).toBe('Add Task')
  })

  it('falls back to English for empty Turkish tasks namespace', async () => {
    const i18n = await createRendererI18n({ locale: 'tr' })
    expect(i18n.t('tasks:task.add')).toBe('Add Task')
  })

  it('changeLanguage works', async () => {
    const i18n = await createRendererI18n({ locale: 'en' })
    await i18n.changeLanguage('ar')
    expect(i18n.language).toBe('ar')
  })
})

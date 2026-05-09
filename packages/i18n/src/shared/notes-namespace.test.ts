import { describe, expect, it } from 'vitest'
import { createMainI18n } from '../main'

describe('notes namespace', () => {
  it('returns populated English notes copy', async () => {
    const i18n = await createMainI18n({ locale: 'en' })

    expect(i18n.t('notes:page.empty.title')).toBe('No note selected')
  })

  it('translates Turkish notes keys', async () => {
    const i18n = await createMainI18n({ locale: 'tr' })

    expect(i18n.t('notes:page.empty.title')).toBe('Not seçilmedi')
  })

  it('translates Arabic notes keys', async () => {
    const i18n = await createMainI18n({ locale: 'ar' })

    expect(i18n.t('notes:tree.empty.newNote')).toBe('ملاحظة جديدة')
  })

  it('returns the key for missing notes translations', async () => {
    const i18n = await createMainI18n({ locale: 'tr' })

    expect(i18n.t('notes:missing.key')).toBe('notes:missing.key')
  })
})

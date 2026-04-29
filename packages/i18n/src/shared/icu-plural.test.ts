import { describe, it, expect } from 'vitest'
import { createMainI18n } from '../main'

describe('ICU pluralization', () => {
  describe('English', () => {
    it('uses "one" form for count=1', async () => {
      const i18n = await createMainI18n({ locale: 'en' })
      expect(i18n.t('common:count.item', { count: 1 })).toBe('1 item')
    })

    it('uses "other" form for count=0', async () => {
      const i18n = await createMainI18n({ locale: 'en' })
      expect(i18n.t('common:count.item', { count: 0 })).toBe('0 items')
    })

    it('uses "other" form for count=5', async () => {
      const i18n = await createMainI18n({ locale: 'en' })
      expect(i18n.t('common:count.note', { count: 5 })).toBe('5 notes')
    })
  })

  describe('Turkish', () => {
    it('produces same output for one and other (no plural -s in Turkish)', async () => {
      const i18n = await createMainI18n({ locale: 'tr' })
      expect(i18n.t('common:count.item', { count: 1 })).toBe('1 öğe')
      expect(i18n.t('common:count.item', { count: 5 })).toBe('5 öğe')
    })

    it('translates note correctly', async () => {
      const i18n = await createMainI18n({ locale: 'tr' })
      expect(i18n.t('common:count.note', { count: 3 })).toBe('3 not')
    })
  })

  describe('Arabic', () => {
    it('uses zero form for count=0', async () => {
      const i18n = await createMainI18n({ locale: 'ar' })
      expect(i18n.t('common:count.item', { count: 0 })).toBe('لا توجد عناصر')
    })

    it('uses one form for count=1', async () => {
      const i18n = await createMainI18n({ locale: 'ar' })
      expect(i18n.t('common:count.item', { count: 1 })).toBe('عنصر واحد')
    })

    it('uses two form for count=2', async () => {
      const i18n = await createMainI18n({ locale: 'ar' })
      expect(i18n.t('common:count.item', { count: 2 })).toBe('عنصران')
    })

    it('uses few form for count=5', async () => {
      const i18n = await createMainI18n({ locale: 'ar' })
      // few = 3-10 in Arabic CLDR
      expect(i18n.t('common:count.item', { count: 5 })).toBe('5 عناصر')
    })

    it('uses many form for count=11', async () => {
      const i18n = await createMainI18n({ locale: 'ar' })
      // many = 11-99 in Arabic CLDR
      expect(i18n.t('common:count.item', { count: 11 })).toBe('11 عنصراً')
    })
  })
})

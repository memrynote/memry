import { describe, expect, it } from 'vitest'
import { createRendererI18n } from '../renderer'
import { I18N_NAMESPACES } from '../shared/config'
import { RESOURCES } from '.'

describe('graph namespace resources', () => {
  it('registers graph as a typed namespace', () => {
    expect(I18N_NAMESPACES).toContain('graph')
  })

  it('populates English, Turkish, and Arabic graph resources', () => {
    expect(RESOURCES.en.graph.page.loading).toBe('Loading graph...')
    expect(RESOURCES.tr.graph.page.loading).toBe('Grafik yükleniyor...')
    expect(RESOURCES.ar.graph.page.loading).toBe('جارٍ تحميل الرسم البياني...')
  })

  it('translates Turkish and Arabic graph strings', async () => {
    const tr = await createRendererI18n({ locale: 'tr' })
    const ar = await createRendererI18n({ locale: 'ar' })

    expect(tr.t('graph:page.loading')).toBe('Grafik yükleniyor...')
    expect(ar.t('graph:context-menu.copy-title')).toBe('انسخ العنوان')
  })
})

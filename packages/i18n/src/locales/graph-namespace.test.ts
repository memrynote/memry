import { describe, expect, it } from 'vitest'
import { createRendererI18n } from '../renderer'
import { I18N_NAMESPACES } from '../shared/config'
import { RESOURCES } from '.'

describe('graph namespace resources', () => {
  it('registers graph as a typed namespace', () => {
    expect(I18N_NAMESPACES).toContain('graph')
  })

  it('populates English and Turkish graph resources while Arabic remains fallback-only', () => {
    expect(RESOURCES.en.graph.page.loading).toBe('Loading graph...')
    expect(RESOURCES.tr.graph.page.loading).toBe('Grafik yükleniyor...')
    expect(RESOURCES.ar.graph).toEqual({})
  })

  it('translates Turkish graph strings and falls back for Arabic', async () => {
    const tr = await createRendererI18n({ locale: 'tr' })
    const ar = await createRendererI18n({ locale: 'ar' })

    expect(tr.t('graph:page.loading')).toBe('Grafik yükleniyor...')
    expect(ar.t('graph:context-menu.copy-title')).toBe('Copy title')
  })
})

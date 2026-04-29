import { describe, expect, it } from 'vitest'
import { createRendererI18n } from '../renderer'
import { I18N_NAMESPACES } from '../shared/config'
import { RESOURCES } from '.'

describe('graph namespace resources', () => {
  it('registers graph as a typed namespace', () => {
    expect(I18N_NAMESPACES).toContain('graph')
  })

  it('populates English and leaves Turkish/Arabic as fallback-only empty objects', () => {
    expect(RESOURCES.en.graph.page.loading).toBe('Loading graph...')
    expect(RESOURCES.tr.graph).toEqual({})
    expect(RESOURCES.ar.graph).toEqual({})
  })

  it('falls back to English graph strings for Turkish and Arabic', async () => {
    const tr = await createRendererI18n({ locale: 'tr' })
    const ar = await createRendererI18n({ locale: 'ar' })

    expect(tr.t('graph:page.loading')).toBe('Loading graph...')
    expect(ar.t('graph:context-menu.copy-title')).toBe('Copy title')
  })
})

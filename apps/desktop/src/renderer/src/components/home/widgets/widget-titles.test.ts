import { describe, expect, it } from 'vitest'
import { EN_BUNDLE } from '@memry/i18n/locales/en-bundle'
import { WIDGET_REGISTRY } from '@/lib/home/widget-registry'
import './index'

function lookup(key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined,
      EN_BUNDLE.common
    )
}

describe('home widget titles', () => {
  it.each(Object.values(WIDGET_REGISTRY).map((def) => [def.type, def.titleKey]))(
    '%s titleKey %s resolves to an English string',
    (_type, titleKey) => {
      expect(typeof lookup(titleKey)).toBe('string')
    }
  )
})

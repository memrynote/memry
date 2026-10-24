import { describe, expect, it } from 'vitest'
import { RESOURCES } from '@memry/i18n/locales'
import { SETTINGS_SEARCH_INDEX, normalizeSearchText, searchSettings } from './settings-search'

function t(key: string): string {
  const value = key
    .split('.')
    .reduce<unknown>(
      (node, part) => (node as Record<string, unknown> | undefined)?.[part],
      RESOURCES.en.settings
    )
  return typeof value === 'string' ? value : key
}

describe('settings search', () => {
  it('points every entry at an existing English label', () => {
    const keys = SETTINGS_SEARCH_INDEX.flatMap((e) => [
      e.labelKey,
      ...(e.groupKey ? [e.groupKey] : []),
      ...(e.extraKeys ?? [])
    ])
    expect(keys.filter((key) => t(key) === key)).toEqual([])
  })

  it('ranks label prefix matches first and builds a breadcrumb', () => {
    const [first, ...rest] = searchSettings('date', t)
    expect(first.label).toBe('Date format')
    expect(first.path).toBe('General › Language & region')
    expect(rest.map((r) => r.path)).toContain('Modules › Journal › Location & format')
  })

  it('ignores case and punctuation', () => {
    expect(normalizeSearchText('Up-Date')).toBe('up date')
    expect(searchSettings('up-date', t).some((r) => r.label === 'Updates')).toBe(true)
  })

  it('requires every word to match', () => {
    const results = searchSettings('font size', t)
    expect(results[0]?.label).toBe(t('appearance.v2.fontSize'))
    expect(results.every((r) => /font/i.test(r.label + r.path))).toBe(true)
  })

  it('returns nothing for a blank query', () => {
    expect(searchSettings('   ', t)).toEqual([])
  })
})

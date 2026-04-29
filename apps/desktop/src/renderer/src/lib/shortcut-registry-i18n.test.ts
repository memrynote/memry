import { describe, expect, it } from 'vitest'
import { RESOURCES } from '@memry/i18n/locales'
import { CATEGORY_ORDER, SHORTCUT_REGISTRY } from './shortcut-registry'

const CATEGORY_I18N_KEYS: Record<string, string> = {
  Navigation: 'navigation',
  Tabs: 'tabs',
  Editor: 'editor',
  View: 'view'
}

function lookup(path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (value, part) =>
        value && typeof value === 'object' ? (value as Record<string, unknown>)[part] : undefined,
      RESOURCES.en.settings
    )
}

describe('shortcut registry i18n', () => {
  it('has settings namespace labels and descriptions for every shortcut entry', () => {
    for (const entry of SHORTCUT_REGISTRY) {
      expect(lookup(`shortcuts.entries.${entry.i18nKey}.label`)).toBe(entry.label)
      expect(lookup(`shortcuts.entries.${entry.i18nKey}.description`)).toBe(entry.description)
    }
  })

  it('has settings namespace labels for every shortcut category', () => {
    for (const category of CATEGORY_ORDER) {
      const key = CATEGORY_I18N_KEYS[category]
      expect(key).toBeTruthy()
      expect(lookup(`shortcuts.categories.${key}`)).toBe(category)
    }
  })
})

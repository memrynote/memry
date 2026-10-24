import { describe, it, expect, beforeAll } from 'vitest'
import { createRendererI18n } from '@memry/i18n/renderer'
import {
  IMPORT_STATUS,
  IMPORT_STATUS_CODES,
  importingItemStatus,
  type ImportStatusCode
} from '@memry/importers/messages'
import { formatImportMessage } from './import-message'

/**
 * The status codes travel from `@memry/importers` (which cannot reach i18n)
 * through the code → key map in `import-message.ts` to the real locale JSON and
 * the real ICU formatter. Typecheck proves the map is exhaustive; only running
 * it proves each key actually resolves — a key that is missing from
 * `en/settings.json` silently falls back to the English `message`, and a
 * template whose placeholder does not match the params renders as a raw
 * `{title}` because the ICU formatter swallows its own parse error.
 */
describe('formatImportMessage — importer status lines', () => {
  beforeAll(async () => {
    // `createRendererI18n` uses `initReactI18next`, which registers the
    // instance globally — that is the instance `getI18n()` inside
    // `formatImportMessage` resolves to.
    await createRendererI18n({ locale: 'en' })
  })

  it('translates every fixed status through a real locale key', () => {
    for (const [name, status] of Object.entries(IMPORT_STATUS)) {
      const text = formatImportMessage(status)

      expect(text.length, `${name} rendered blank`).toBeGreaterThan(0)
      // A missing key resolves to the key itself, which the formatter turns
      // back into the English `message` — indistinguishable from a hit unless
      // we assert the key never leaks.
      expect(text, `${name} leaked its i18n key`).not.toContain('import.status.')
      expect(text, `${name} left a raw ICU placeholder`).not.toMatch(/\{\w+\}/)
    }
  })

  it('interpolates {title} into the per-item status', () => {
    expect(formatImportMessage(importingItemStatus('Meeting notes'))).toBe(
      'Importing Meeting notes'
    )
  })

  it('covers every status code with a key that resolves', () => {
    const codes = Object.values(IMPORT_STATUS_CODES) as ImportStatusCode[]
    const unresolved = codes.filter((code) => {
      // Route each code through the same lookup the dialog uses; a code with no
      // key falls back to the sentinel `message` verbatim.
      const text = formatImportMessage({ code, message: '__MISSING__', params: { title: 'x' } })
      return text === '__MISSING__'
    })

    expect(unresolved).toEqual([])
  })

  it('renders a plain-string status verbatim (payload from an older build)', () => {
    expect(formatImportMessage('Scanning files…')).toBe('Scanning files…')
    expect(formatImportMessage('')).toBe('')
  })

  it('falls back to the English message for a code this build does not know', () => {
    expect(formatImportMessage({ code: 'status.notAThing', message: 'Doing something…' })).toBe(
      'Doing something…'
    )
  })
})

import { describe, it, expect } from 'vitest'
import { IntlMessageFormat } from 'intl-messageformat'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const LOCALES_DIR = fileURLToPath(new URL('.', import.meta.url))

/**
 * Interpolation here is ICU single-brace (`{count}`), because both i18n
 * entrypoints register the custom ICU formatter in `shared/icu-formatter.ts`.
 * i18next's default double-brace `{{count}}` does NOT throw — the formatter
 * catches the parse failure and returns the raw template — so a mistake ships
 * silently and users see `{{count}}` verbatim in the UI.
 *
 * Double braces are only the most common way to hit that silent failure, so the
 * second test compiles every string with the same parser the formatter uses.
 * That catches the rest of the class too — an unescaped ICU apostrophe, for
 * instance, quotes away the closing brace of a plural block.
 */
const DOUBLE_BRACE = /\{\{\s*\w+\s*\}\}/

type Offender = { file: string; key: string; value: string }

function collect(value: unknown, file: string, path: string[], out: Offender[]): void {
  if (typeof value === 'string') {
    if (DOUBLE_BRACE.test(value)) {
      out.push({ file, key: path.join('.'), value })
    }
    return
  }
  if (value && typeof value === 'object') {
    for (const [childKey, child] of Object.entries(value)) {
      collect(child, file, [...path, childKey], out)
    }
  }
}

function collectAll(value: unknown, file: string, path: string[], out: Offender[]): void {
  if (typeof value === 'string') {
    out.push({ file, key: path.join('.'), value })
    return
  }
  if (value && typeof value === 'object') {
    for (const [childKey, child] of Object.entries(value)) {
      collectAll(child, file, [...path, childKey], out)
    }
  }
}

describe('locale brace style', () => {
  const localeDirs = readdirSync(LOCALES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)

  it('finds locale directories to check', () => {
    expect(localeDirs.length).toBeGreaterThan(0)
  })

  it('uses ICU single-brace interpolation everywhere', () => {
    const offenders: Offender[] = []

    for (const locale of localeDirs) {
      const dir = join(LOCALES_DIR, locale)
      for (const file of readdirSync(dir).filter((name) => name.endsWith('.json'))) {
        const parsed: unknown = JSON.parse(readFileSync(join(dir, file), 'utf8'))
        collect(parsed, `${locale}/${file}`, [], offenders)
      }
    }

    expect(
      offenders.map((offender) => `${offender.file} → ${offender.key}: ${offender.value}`)
    ).toEqual([])
  })

  it('compiles every locale string with the ICU parser the formatter uses', () => {
    const failures: string[] = []

    for (const locale of localeDirs) {
      const dir = join(LOCALES_DIR, locale)
      for (const file of readdirSync(dir).filter((name) => name.endsWith('.json'))) {
        const strings: Offender[] = []
        collectAll(
          JSON.parse(readFileSync(join(dir, file), 'utf8')),
          `${locale}/${file}`,
          [],
          strings
        )

        for (const entry of strings) {
          try {
            new IntlMessageFormat(entry.value, locale)
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            failures.push(`${entry.file} → ${entry.key}: ${message} (${entry.value})`)
          }
        }
      }
    }

    expect(failures).toEqual([])
  })
})

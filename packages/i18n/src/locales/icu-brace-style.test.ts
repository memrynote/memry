import { describe, it, expect } from 'vitest'
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
 * Two keys predate this guard and are still broken. They are listed rather
 * than fixed so the guard can land without widening its blast radius; fixing
 * them means editing all ~33 locales.
 */
const KNOWN_BROKEN = ['setup.linking.vaultRow', 'resizeAria']

const DOUBLE_BRACE = /\{\{\s*\w+\s*\}\}/

type Offender = { file: string; key: string; value: string }

function collect(value: unknown, file: string, path: string[], out: Offender[]): void {
  if (typeof value === 'string') {
    if (DOUBLE_BRACE.test(value)) {
      const key = path.join('.')
      if (!KNOWN_BROKEN.some((known) => key === known || key.endsWith(`.${known}`))) {
        out.push({ file, key, value })
      }
    }
    return
  }
  if (value && typeof value === 'object') {
    for (const [childKey, child] of Object.entries(value)) {
      collect(child, file, [...path, childKey], out)
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
})

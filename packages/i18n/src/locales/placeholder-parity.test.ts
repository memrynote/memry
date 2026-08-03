import { describe, it, expect } from 'vitest'
import { IntlMessageFormat } from 'intl-messageformat'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const LOCALES_DIR = fileURLToPath(new URL('.', import.meta.url))
const SOURCE_LOCALE = 'en'

/**
 * `icu-brace-style.test.ts` proves every string *parses*. A translation can parse
 * perfectly and still be broken: drop `{current}` from "Step {current} of {total}"
 * and ICU compiles it happily, the formatter never complains, and the user reads
 * "Step of 12". Invented placeholders are the mirror image — the caller never
 * passes them, so ICU renders the literal `{foo}`.
 *
 * So compare shapes, not just syntax: for every key a locale shares with English,
 * the set of placeholder names must match, and an English plural block must stay
 * a plural block (otherwise `#` and the one/other forms are silently lost).
 *
 * The plural half only applies to locales CLDR gives more than one cardinal
 * category. ja/ko/th/vi/zh/id/ms have `other` alone, so `{count} 件` and
 * `{count, plural, other {# 件}}` render identically — flattening the block there
 * is a correct translation, not a dropped one.
 */

// ICU AST element types, mirroring the `TYPE` enum in
// @formatjs/icu-messageformat-parser. Inlined rather than imported because
// intl-messageformat is the declared dependency; the parser under it is not.
const TYPE_LITERAL = 0
const TYPE_PLURAL = 6
const TYPE_POUND = 7
const TYPE_TAG = 8

type IcuShape = { placeholders: Set<string>; hasPlural: boolean }

type Mismatch = { locale: string; file: string; key: string; detail: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function walk(nodes: unknown, shape: IcuShape): void {
  if (!Array.isArray(nodes)) return

  for (const node of nodes) {
    if (!isRecord(node)) continue
    // Literal text and `#` carry no argument name.
    if (node.type === TYPE_LITERAL || node.type === TYPE_POUND) continue
    if (node.type === TYPE_TAG) {
      // `<b>…</b>` is markup, not a parameter — only its children can hold placeholders.
      walk(node.children, shape)
      continue
    }
    if (node.type === TYPE_PLURAL) shape.hasPlural = true
    // argument / number / date / time / select / plural all name their argument in `value`.
    if (typeof node.value === 'string') shape.placeholders.add(node.value)
    // select and plural nest more elements inside each branch.
    if (isRecord(node.options)) {
      for (const option of Object.values(node.options)) {
        if (isRecord(option)) walk(option.value, shape)
      }
    }
  }
}

function icuShape(message: string, locale: string): IcuShape | null {
  const shape: IcuShape = { placeholders: new Set<string>(), hasPlural: false }
  try {
    walk(new IntlMessageFormat(message, locale).getAst(), shape)
  } catch {
    // Strings that do not parse at all are icu-brace-style.test.ts's failure to report.
    return null
  }
  return shape
}

function flatten(value: unknown, path: string[], out: Map<string, string>): void {
  if (typeof value === 'string') {
    out.set(path.join('.'), value)
    return
  }
  if (value && typeof value === 'object') {
    for (const [childKey, child] of Object.entries(value)) {
      flatten(child, [...path, childKey], out)
    }
  }
}

function readStrings(path: string): Map<string, string> {
  const out = new Map<string, string>()
  flatten(JSON.parse(readFileSync(path, 'utf8')), [], out)
  return out
}

function format(names: string[]): string {
  return names.map((name) => `{${name}}`).join(', ')
}

function describeMismatch(mismatch: Mismatch): string {
  return `${mismatch.locale}/${mismatch.file} → ${mismatch.key}: ${mismatch.detail}`
}

function inflectsPlurals(locale: string): boolean {
  try {
    return new Intl.PluralRules(locale).resolvedOptions().pluralCategories.length > 1
  } catch {
    // Unrecognised tag: assume it inflects, so the guard stays strict rather than silent.
    return true
  }
}

describe('locale placeholder parity', () => {
  const sourceDir = join(LOCALES_DIR, SOURCE_LOCALE)
  const sourceFiles = readdirSync(sourceDir).filter((name) => name.endsWith('.json'))
  const localeDirs = readdirSync(LOCALES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== SOURCE_LOCALE)
    .map((entry) => entry.name)

  const placeholderMismatches: Mismatch[] = []
  const pluralMismatches: Mismatch[] = []

  for (const file of sourceFiles) {
    const source = readStrings(join(sourceDir, file))

    for (const locale of localeDirs) {
      const translatedPath = join(LOCALES_DIR, locale, file)
      // A namespace a locale has not been given yet is a coverage gap, not a parity bug.
      if (!existsSync(translatedPath)) continue

      for (const [key, translated] of readStrings(translatedPath)) {
        const english = source.get(key)
        // Keys the locale has but English does not are out of scope here.
        if (english === undefined) continue

        const expected = icuShape(english, SOURCE_LOCALE)
        const actual = icuShape(translated, locale)
        if (!expected || !actual) continue

        const missing = [...expected.placeholders].filter((name) => !actual.placeholders.has(name))
        const invented = [...actual.placeholders].filter((name) => !expected.placeholders.has(name))

        if (missing.length > 0 || invented.length > 0) {
          const detail = [
            missing.length > 0 ? `dropped ${format(missing)}` : '',
            invented.length > 0 ? `invented ${format(invented)}` : ''
          ]
            .filter(Boolean)
            .join('; ')
          placeholderMismatches.push({
            locale,
            file,
            key,
            detail: `${detail} — en: "${english}" / ${locale}: "${translated}"`
          })
        }

        if (expected.hasPlural && !actual.hasPlural && inflectsPlurals(locale)) {
          pluralMismatches.push({
            locale,
            file,
            key,
            detail: `English uses an ICU plural block, translation does not — en: "${english}" / ${locale}: "${translated}"`
          })
        }
      }
    }
  }

  it('finds an English source and translated locales to compare', () => {
    expect(sourceFiles.length).toBeGreaterThan(0)
    expect(localeDirs.length).toBeGreaterThan(0)
  })

  it('keeps the English placeholder set in every translation', () => {
    expect(placeholderMismatches.map(describeMismatch)).toEqual([])
  })

  it('keeps English plural blocks pluralised in every translation', () => {
    expect(pluralMismatches.map(describeMismatch)).toEqual([])
  })
})

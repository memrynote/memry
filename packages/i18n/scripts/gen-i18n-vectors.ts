/**
 * Native-string vectors: `crates/memry-desktop/tests/vectors/i18n-format.json.gz`.
 *
 * The Rust core of the Tauri app formats the `errors`, `menu`, `system` and `notes`
 * namespaces itself. This runs the real `createMainI18n` (i18next + `IcuFormatter` +
 * `intl-messageformat`) over every message of those namespaces in every locale, and over a
 * set of hand-written templates for the parser corners, and records what comes out. The
 * Rust test replays every case and demands byte equality.
 *
 *   tsx scripts/gen-i18n-vectors.ts            write
 *   tsx scripts/gen-i18n-vectors.ts --check    compare with the committed file
 *
 * The file is gzip; `--check` compares the decompressed text, since the compressed bytes
 * depend on the zlib build.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync, gzipSync } from 'node:zlib'

import { IntlMessageFormat } from 'intl-messageformat'

import { IcuFormatter } from '../src/shared/icu-formatter'
import { SUPPORTED_LOCALES } from '../src/shared/config'
import { createMainI18n } from '../src/main'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '../../../crates/memry-desktop/tests/vectors/i18n-format.json.gz')
const LOCALES_DIR = join(HERE, '../src/locales')
const NAMESPACES = ['errors', 'menu', 'system', 'notes'] as const

/** Plural argument values (`count`) and the string values every other argument takes. */
const COUNTS = [0, 1, 2, 3, 5, 11, 100, 101, 1234]
const TEXTS = ['Ünï Cödé', "it's {#}", "'{'"]

// intl-messageformat's TYPE enum.
const T_ARGUMENT = 1
const T_SELECT = 5
const T_PLURAL = 6

interface Names {
  plain: string[]
  plural: string[]
}

type Element = { type: number; value?: string; options?: Record<string, { value: Element[] }> }

function collect(elements: Element[], names: Names): void {
  for (const element of elements) {
    const { type, value } = element
    if (value !== undefined && type === T_ARGUMENT && !names.plain.includes(value)) {
      names.plain.push(value)
    }
    if (value !== undefined && type === T_PLURAL && !names.plural.includes(value)) {
      names.plural.push(value)
    }
    if (value !== undefined && type === T_SELECT && !names.plain.includes(value)) {
      names.plain.push(value)
    }
    for (const option of Object.values(element.options ?? {})) collect(option.value, names)
  }
}

function namesOf(template: string): Names {
  const names: Names = { plain: [], plural: [] }
  try {
    collect(new IntlMessageFormat(template, 'en', undefined, { ignoreTag: true }).getAst(), names)
  } catch {
    // An unparsable template formats to itself, with no arguments needed.
  }
  return names
}

interface ArgSet {
  plural: number
  text: string
}

function argSets(names: Names): ArgSet[] {
  if (names.plain.length === 0 && names.plural.length === 0) return [{ plural: 0, text: '' }]
  const sets: ArgSet[] = []
  if (names.plural.length > 0) {
    for (const plural of COUNTS) sets.push({ plural, text: TEXTS[0] })
    for (const text of TEXTS.slice(1)) sets.push({ plural: 2, text })
  } else {
    for (const text of TEXTS) sets.push({ plural: 0, text })
  }
  return sets
}

function argsFor(names: Names, set: ArgSet): Record<string, string | number> {
  const args: Record<string, string | number> = {}
  for (const name of names.plain) args[name] = set.text
  for (const name of names.plural) args[name] = set.plural
  return args
}

function flatten(prefix: string, value: unknown, out: Map<string, string>): void {
  if (typeof value === 'string') {
    out.set(prefix, value)
  } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      flatten(prefix ? `${prefix}.${key}` : key, child, out)
    }
  }
}

function readNamespace(locale: string, ns: string): Map<string, string> {
  const out = new Map<string, string>()
  flatten('', JSON.parse(readFileSync(join(LOCALES_DIR, locale, `${ns}.json`), 'utf8')), out)
  return out
}

/** Parser corners. Each runs through the plugin's own `parse`, so the error rule is included. */
const TEMPLATES: Array<{
  template: string
  locale: string
  args: Record<string, string | number>
}> = []
function addTemplate(
  template: string,
  args: Record<string, string | number> = {},
  locale = 'en'
): void {
  TEMPLATES.push({ template, locale, args })
}

for (const template of [
  '',
  'plain',
  'Hello {name}',
  'Hello { name }',
  'Hello {name} and {other}',
  "it's fine",
  "it''s fine",
  "'{'quoted'}'",
  "'{' and '}'",
  "a ''quoted'' word",
  "'# not special here'",
  "rock 'n' roll",
  "'{name}'",
  "'{name'} tail",
  "'<b>' and <b>bold</b>",
  "'unterminated {name}",
  '{name}{name}',
  '}',
  'a } b',
  '{',
  '{name',
  '{}',
  '{ }',
  '{name,}',
  // `number`, `date` and `time` arguments are outside the native subset (none is used).
  '{name, nope, x}',
  '<b>{name}</b>',
  'a < b > c',
  '{n, plural, one {# item} other {# items}}',
  '{n, plural, =0 {none} =1 {one} other {many #}}',
  '{n, plural, =0{none}one{# thing}other{# things}}',
  '{n,plural,one{#}other{#}}',
  '{n, plural, one {# item}}',
  '{n, plural, other {#}}',
  '{n, plural, one {# a} one {# b} other {c}}',
  '{n, plural, zero {z} one {o} two {t} few {f} many {m} other {x #}}',
  '{n, plural, offset:1 =0 {nobody} =1 {just you} one {you and # other} other {you and # others}}',
  '{n, plural, offset:1 other {#}}',
  "{n, plural, one {'#' literal} other {'# literal' #}}",
  "{n, plural, one {it's # item} other {it''s # items}}",
  '{n, plural, one {# {name}} other {# {name}s}}',
  '{n, plural, one {{m, plural, one {# a} other {# b}}} other {c}}',
  '{n, plural, one {a {m, plural, one {# x} other {# y}}} other {c #}}',
  '# outside a plural',
  '{n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}',
  '{g, select, male {he} female {she} other {they}}',
  '{g, select, male {he #} other {they #}}',
  '{g, select, male {he}}',
  '{n, plural, one {a} other {b}} and {m}',
  'text {n, plural, one {# x} other {# y}} text'
]) {
  addTemplate(template, { name: 'Kaan', other: 'Z', n: 1, m: 2, g: 'female' })
}
for (const n of [
  0, 1, 2, 3, 4, 5, 6, 7, 10, 11, 12, 13, 14, 21, 22, 25, 100, 101, 102, 1000, 1234, 1234567, 1.5,
  -1
]) {
  addTemplate('{n, plural, zero {z #} one {o #} two {t #} few {f #} many {m #} other {x #}}', { n })
}
addTemplate('{n, plural, =5 {five} other {#}}', { n: '5' })
addTemplate('{n, plural, one {# x} other {# y}}', { n: 'abc' })
addTemplate('{n, plural, one {# x} other {# y}}', { n: '2' })
addTemplate('Hello {name}', {})
addTemplate('Hello {name}', { name: 0 })
addTemplate('Hello {name}', { name: 2.5 })
addTemplate('Hello {name}', { name: 1e21 })
addTemplate('Hello {name}', { name: 0.0000001 })
for (const locale of [
  'ar',
  'he',
  'ru',
  'pl',
  'cs',
  'fr',
  'ja',
  'zh-CN',
  'fil',
  'no',
  'pt',
  'hr',
  'ro',
  'lt'
]) {
  for (const n of [0, 1, 2, 3, 5, 11, 21, 100, 101, 1234]) {
    addTemplate(
      '{n, plural, zero {z #} one {o #} two {t #} few {f #} many {m #} other {x #}}',
      { n },
      locale
    )
  }
  addTemplate('{n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}', { n: 22 }, locale)
}

interface Case {
  template: string
  locale: string
  args: Record<string, string | number>
  expected: string
}

const MISSING_KEYS = [
  'errors:no.such.key',
  'menu:x',
  'notes:a.b.c',
  'system:nope',
  'nothing',
  'common:missing.here'
]

async function build(): Promise<string> {
  const locales = Object.values(SUPPORTED_LOCALES)
  const english = new Map<string, Map<string, string>>()
  for (const ns of NAMESPACES) english.set(ns, readNamespace('en', ns))

  const messages: Record<string, Record<string, { names: Names; out: string[] }>> = {}
  for (const locale of locales) {
    const i18n = await createMainI18n({ locale })
    const entries: Record<string, { names: Names; out: string[] }> = {}
    for (const ns of NAMESPACES) {
      const own = readNamespace(locale, ns)
      const keys = [...new Set([...(english.get(ns)?.keys() ?? []), ...own.keys()])].toSorted()
      for (const key of keys) {
        const template = own.get(key) ?? english.get(ns)?.get(key) ?? ''
        const names = namesOf(template)
        const out = argSets(names).map((set) => i18n.t(`${ns}:${key}`, argsFor(names, set)))
        // A message without arguments that formats to itself is not recorded; the Rust test
        // asserts that every unrecorded message formats to itself.
        const plainSame = names.plain.length + names.plural.length === 0 && out[0] === template
        if (!plainSame) entries[`${ns}:${key}`] = { names, out }
      }
    }
    messages[locale] = entries
  }

  const english18 = await createMainI18n({ locale: 'en' })
  const missing = MISSING_KEYS.map((key) => ({ key, expected: english18.t(key) }))

  const formatter = new IcuFormatter()
  const cases: Case[] = TEMPLATES.map((spec, index) => ({
    ...spec,
    expected: formatter.parse(spec.template, spec.args, spec.locale, 'vector', `case-${index}`)
  }))

  return `${JSON.stringify({
    meta: {
      class: 'i18n-format',
      implementation: 'packages/i18n (createMainI18n, IcuFormatter, intl-messageformat)',
      namespaces: NAMESPACES,
      counts: COUNTS,
      texts: TEXTS,
      locales: locales.length,
      messageCases: Object.values(messages).reduce((sum, m) => sum + Object.keys(m).length, 0),
      templateCases: cases.length
    },
    missing,
    cases,
    messages
  })}\n`
}

const text = await build()
if (process.argv.includes('--check')) {
  const committed = existsSync(OUT) ? gunzipSync(readFileSync(OUT)).toString('utf8') : ''
  if (committed !== text) {
    console.error('i18n-format.json.gz is stale: run `pnpm --filter @memry/i18n vectors:generate`')
    process.exit(1)
  }
  console.log('i18n vectors up to date')
} else {
  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, gzipSync(Buffer.from(text), { level: 9 }))
  console.log(`wrote ${OUT}`)
}

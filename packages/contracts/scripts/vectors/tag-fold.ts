/**
 * Case input: `tag` → `expected.fold`, the tag's identity (chapter 13
 * §13.7.8), and `expected.key`, the definition key (the trimmed tag, folded).
 * `equal` lists spellings that must fold to the same string.
 */
import { foldTag, tagKey } from '@memry/shared/tag-fold'
import { meta } from './shared'

interface CaseSpec {
  name: string
  pins: string
  tag: string
  /** Spellings that fold the same as `tag`. */
  equal: string[]
  /** Spellings that must fold differently. */
  distinct: string[]
}

const SPECS: CaseSpec[] = [
  {
    name: 'ascii',
    pins: 'ASCII letters lowercase',
    tag: 'Protocol',
    equal: ['PROTOCOL', 'protocol'],
    distinct: ['protocols']
  },
  {
    name: 'umlaut',
    pins: 'non-ASCII letters lowercase: Ü is ü',
    tag: 'Ünal',
    equal: ['ünal', 'ÜNAL'],
    distinct: ['unal']
  },
  {
    name: 'turkish-dotted-capital-i',
    pins: 'İ folds to i, not to i + U+0307; I folds to i too',
    tag: 'İş',
    equal: ['iş', 'İŞ', 'i\u0307ş', 'IŞ'],
    distinct: ['ış']
  },
  {
    name: 'turkish-dotless-i',
    pins: 'ı stays ı; I folds to i; ı and i stay distinct letters',
    tag: 'ışık',
    equal: ['ışık'],
    distinct: ['IŞIK', 'işik']
  },
  {
    name: 'turkish-capital-i',
    pins: 'I folds to i, so IŞIK is işik',
    tag: 'IŞIK',
    equal: ['işik', 'İŞİK'],
    distinct: ['ışık']
  },
  {
    name: 'turkish-s-cedilla',
    pins: 'Ş folds to ş; Şehir, şehir and ŞEHİR are one tag',
    tag: 'Şehir',
    equal: ['şehir', 'ŞEHİR', 'ŞehİR'],
    distinct: ['sehir']
  },
  {
    name: 'combining-dot-only-after-i',
    pins: 'U+0307 is dropped only right after a character that folded to i',
    tag: 'e\u0307',
    equal: ['E\u0307'],
    distinct: ['e']
  },
  {
    name: 'sharp-s',
    pins: 'ß stays ß; ẞ folds to ß; SS is another tag',
    tag: 'Straße',
    equal: ['STRAẞE', 'straße'],
    distinct: ['STRASSE', 'strasse']
  },
  {
    name: 'greek-final-sigma',
    pins: 'every sigma folds to σ, with no context',
    tag: 'ΟΔΟΣ',
    equal: ['οδος', 'οδοσ', 'Οδος'],
    distinct: ['οδο']
  },
  {
    name: 'mixed-case-and-scripts',
    pins: 'Cyrillic, Latin and a hierarchy fold per character; / is kept',
    tag: 'Proje/ÇALIŞMA/Лекция',
    equal: ['proje/çalişma/лекция', 'PROJE/Çalişma/ЛЕКЦИЯ'],
    distinct: ['proje/çalışma/лекция']
  },
  {
    name: 'length-changes',
    pins: 'İ folds to one character, and i + U+0307 to one: never cut an original at a folded length',
    tag: 'Ai\u0307/b',
    equal: ['aİ/b', 'Aİ/B'],
    distinct: ['ai/c']
  },
  {
    name: 'no-trim-in-fold',
    pins: 'the fold keeps whitespace; the definition key trims it first',
    tag: '  Ünal ',
    equal: ['  ünal '],
    distinct: ['ünal']
  },
  {
    name: 'non-letters',
    pins: 'digits, punctuation and emoji are kept',
    tag: 'Q3-2026_🎯',
    equal: ['q3-2026_🎯'],
    distinct: ['q3-2026']
  }
]

export function buildTagFold(): Record<string, unknown> {
  const cases = SPECS.map((spec) => ({
    name: spec.name,
    pins: spec.pins,
    input: { tag: spec.tag, equal: spec.equal, distinct: spec.distinct },
    expected: { fold: foldTag(spec.tag), key: tagKey(spec.tag) }
  }))
  return {
    meta: meta({
      class: 'tag-fold',
      chapter: 'docs/protocol/13-payload-schemas.md',
      source: 'packages/shared/src/tag-fold.ts',
      caseCount: cases.length
    }),
    cases
  }
}

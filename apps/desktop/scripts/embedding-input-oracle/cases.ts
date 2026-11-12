/**
 * The 61 inputs of `embedding-input.json`: notes (title and body), typed
 * queries and interleaved page text. Built from fixed sentence pools, so the
 * file is the same on every machine. The long inputs sit on the window
 * boundaries of `embedding-input.ts`: the 4000-unit window, the chunk budget
 * after the title header, a separator just inside or outside the second half,
 * a surrogate pair or a decomposed letter cut in two, the 16-window cap, and
 * the slivers under the 10-unit minimum.
 */
export type NoteCase = {
  kind: 'note'
  name: string
  title: string | null
  content: string | null
}
export type QueryCase = { kind: 'query'; name: string; query: string }
export type InterleavedCase = { kind: 'interleaved'; name: string; text: string | null }
export type Case = NoteCase | QueryCase | InterleavedCase

const EN = [
  'The meeting moved to Thursday afternoon.',
  'Bring the quarterly numbers and the draft plan.',
  'Search should find this note by meaning, not only by words.',
  'Local first means the data stays on the device.'
]
const TR = [
  'Toplantı perşembe öğleden sonraya taşındı.',
  'Çeyrek rakamlarını ve taslak planı getir.',
  'Arama bu notu kelimeyle değil anlamıyla bulmalı.',
  'İğdır, Şırnak ve Ağrı yolculuğu için ılık giysiler al.'
]

/** `count` sentences from `pool`, in order, joined by `joiner`. */
function sentences(pool: readonly string[], count: number, joiner = ' '): string {
  return Array.from({ length: count }, (_, i) => pool[i % pool.length]).join(joiner)
}

/** Text of exactly `length` UTF-16 units drawn from `pool`, joined by `joiner`. */
function exact(length: number, pool: readonly string[] = EN, joiner = ' '): string {
  let text = ''
  for (let i = 0; text.length < length; i++) text += (i > 0 ? joiner : '') + pool[i % pool.length]
  return text.slice(0, length)
}

/** The header `buildEmbeddingChunks` writes before every window of a titled note. */
const header = (title: string): string => `title: ${title} | text: `
const BUDGET_T = 4000 - header('T').length

const note = (name: string, title: string | null, content: string | null): NoteCase => ({
  kind: 'note',
  name,
  title,
  content
})

const NOTES: NoteCase[] = [
  note('english title and body', 'Weekly sync', sentences(EN, 3)),
  note('turkish title and body', 'Haftalık toplantı', sentences(TR, 4)),
  note('mixed languages', 'Plan / Plan', `${sentences(EN, 2)} ${sentences(TR, 2)}`),
  note('null title', null, sentences(EN, 2)),
  note('whitespace title', '  \t ', sentences(TR, 2)),
  note('null body', 'A title that is long enough', null),
  note('both null', null, null),
  note('under the minimum', 'abc', 'defghi'),
  note('exactly the minimum', 'abcd', 'efghij'),
  note('minimum counts trimmed units', '  ab ', ' cdefghi  '),
  note(
    'js trim set',
    '\ufeff\u00a0Title\u3000',
    '\u2028\u2029\u1680 body text here \u202f\u205f\t\v\f'
  ),
  note('u+0085 is not trimmed', '\u0085Title\u0085', '\u0085body text here\u0085'),
  note('title over 200 units', 'T'.repeat(250), sentences(EN, 2)),
  note('title of 200 units ending in a split pair', `${'t'.repeat(199)}😀 tail`, sentences(EN, 2)),
  note('crlf paragraphs', 'CRLF', sentences(EN, 160, '\r\n\r\n')),
  note('paragraph breaks', 'Paragraphs', sentences(TR, 220, '\n\n')),
  note('line breaks only', 'Lines', sentences(EN, 200, '\n')),
  note('sentence breaks only', 'Sentences', sentences(EN, 200, ' ')),
  note('spaces only', 'Words', `${'word '.repeat(1700)}end`),
  note('no separator', 'T', 'x'.repeat(9000)),
  note('paragraph break in the first half only', 'T', `${'a'.repeat(100)}\n\n${'b'.repeat(8000)}`),
  note(
    'word break just past half',
    'T',
    `${'a'.repeat(Math.ceil(BUDGET_T / 2))} ${'b'.repeat(6000)}`
  ),
  note(
    'word break just before half',
    'T',
    `${'a'.repeat(Math.ceil(BUDGET_T / 2) - 1)} ${'b'.repeat(6000)}`
  ),
  note('surrogate pair cut at the budget', 'T', `${'x'.repeat(BUDGET_T - 1)}😀${'y'.repeat(3000)}`),
  note(
    'surrogate pair cut at the input slice',
    null,
    `${'z'.repeat(3999 - 'title: none | text: '.length)}😀 more`
  ),
  note(
    'decomposed letters cut at the budget',
    'T',
    `${'x'.repeat(BUDGET_T - 1)}e\u0301${'i\u0307 '.repeat(1500)}`
  ),
  note('body of exactly the budget', 'T', exact(BUDGET_T)),
  note('body of budget plus one', 'T', exact(BUDGET_T + 1)),
  note('tail sliver dropped', 'T', `${exact(BUDGET_T - 1, EN)}\n\nshort`),
  note('whitespace-only later window dropped', 'T', `${'a'.repeat(BUDGET_T)}${' '.repeat(5000)}`),
  note('more than 16 windows', 'Book', sentences(EN, 1800, '\n\n')),
  note('exactly the embeddable cap', 'Cap', exact(64000, TR, '\n')),
  note('emoji zwj sequences', 'Aile 👨‍👩‍👧‍👦', '👩🏽‍💻 '.repeat(900)),
  note('cjk without spaces', '日本語', '検索は意味で見つけるべきです。'.repeat(400)),
  note('turkish long', 'Uzun not', sentences(TR, 300)),
  note('untitled long', null, sentences(EN, 250, '\n')),
  note('tabs and vertical tabs', '\tTab\t', `\v${sentences(EN, 2)}\v`),
  note(
    'word break exactly at half of an even budget',
    'TT',
    `${'a'.repeat((4000 - header('TT').length) / 2)} ${'b'.repeat(6000)}`
  ),
  note('title only', 'Just a reasonably long title', ''),
  note('newlines around body', 'N', `\n\n\n${sentences(TR, 3)}\n\n\n`),
  note('dotted text without spaces', 'Dots', 'a.'.repeat(4500)),
  note('crlf single lines', 'CR', sentences(TR, 200, '\r\n'))
]

const QUERIES: QueryCase[] = [
  ['empty', ''],
  ['whitespace', ' \u3000\ufeff '],
  ['one word', 'kedi'],
  ['padded', '  meeting notes  '],
  ['turkish', 'ılık giysiler İğdır'],
  ['u+0085 kept', '\u0085query\u0085'],
  ['over the window', exact(4100)],
  [
    'surrogate pair cut at the window',
    `${'q'.repeat(3999 - 'task: search result | query: '.length)}😀`
  ],
  ['emoji', 'kedi 🐈 dog 🐕'],
  ['operators kept verbatim', 'tag:work "exact phrase" -draft']
].map(([name, query]) => ({ kind: 'query' as const, name, query }))

const INTERLEAVED: InterleavedCase[] = (
  [
    ['null', null],
    ['empty', ''],
    ['under the minimum', '  short  '],
    ['exactly the minimum', ' 0123456789 '],
    ['turkish page text', sentences(TR, 5)],
    ['over the cap', exact(2600)],
    ['surrogate pair cut at the cap', `${'p'.repeat(2499)}😀 rest`],
    ['multiline ocr text', sentences(EN, 6, '\n')],
    ['whitespace only', '\n\n\t\u00a0']
  ] satisfies [string, string | null][]
).map(([name, text]) => ({ kind: 'interleaved' as const, name, text }))

export const CASES: Case[] = [...NOTES, ...QUERIES, ...INTERLEAVED]

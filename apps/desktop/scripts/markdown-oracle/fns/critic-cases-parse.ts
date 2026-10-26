/** Cases of `critic-markup/parser.ts`, `transforms.ts` and the comment payload. */
import type { OracleCase } from '../cases-frontmatter'
import type { MarkdownSource } from '../cases-bn'
import {
  criticMarkupCommentBodyHash,
  parseCriticMarkup,
  type CriticMarkupMark
} from '../../../../../packages/shared/src/critic-markup/parser'

export function fnCase(group: string, slug: string, fn: string, ...args: unknown[]): OracleCase {
  return { id: `${group}/fn/${slug.replace(/[^a-z0-9-]+/g, '-')}`, op: 'fn', input: { fn, args } }
}

export function indexed(items: Record<string, string>): Array<[string, string]> {
  return Object.entries(items).map(([name, value], i) => [
    `${String(i).padStart(3, '0')}-${slugOf(name)}`,
    value
  ])
}

function slugOf(text: string): string {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return s.length > 0 ? s.slice(0, 40) : 'case'
}

const TS36 = (1_700_000_000_000).toString(36)
const mentions = encodeURIComponent(
  JSON.stringify([
    { kind: 'note', refId: 'n1', label: 'Note ✓' },
    { kind: 'bogus', refId: 'n2', label: 'x' },
    { kind: 'task', refId: '', label: 'x' },
    'text',
    { kind: 'calendar_event', refId: 'e1', label: '日本語 😀' }
  ])
)
const attachments = encodeURIComponent(
  JSON.stringify([
    { id: 'a1', name: 'p.png', path: 'x/p.png', size: 12, mimeType: 'image/png', type: 'image' },
    { id: 'a2', name: 'f', path: 'f', size: 'big', mimeType: 3, type: 'other' },
    { id: '', name: 'f', path: 'f' },
    { id: 'a3', name: 'g', path: 'g', size: 1.5, mimeType: '', type: 'file' }
  ])
)
const formatPayload = (body: string, v = 1, hashOf = body): string => {
  const payload = {
    v,
    hash: criticMarkupCommentBodyHash(hashOf),
    ranges: [{ start: 0, end: 2, marks: ['bold'] }]
  }
  return `id=f1;type=comment;format=${encodeURIComponent(JSON.stringify(payload))} | ${body}`
}

export const PARSE_SOURCES: Record<string, string> = {
  empty: '',
  plain: 'Just text.\nNo marks.',
  addition: 'a {++added++} b',
  deletion: 'a {--gone--} b',
  substitution: 'a {~~old~>new~~} b',
  'comment only': 'a {>>note<<} b',
  'comment with metadata': 'a {>>id=c1;type=comment | the body<<} b',
  highlight: 'a {==text==}{>>id=c2;type=comment | body<<} b',
  'highlight no comment': 'a {==text==} b',
  'highlight space comment': 'a {==text==} {>>c<<} b',
  'unclosed addition': 'a {++open',
  'unclosed deletion': 'a {--open',
  'unclosed substitution arrow': 'a {~~old~>new',
  'subst no arrow': 'a {~~old~~} b',
  'subst two arrows': '{~~a~>b~>c~~}',
  'unclosed comment': 'a {>>open',
  'nested marks': '{++ outer {-- inner --} ++}',
  'adjacent marks': '{++a++}{--b--}{~~c~>d~~}',
  'empty marks': '{++++}{----}{~~~>~~}{>><<}{====}{>><<}',
  'empty highlight': '{====}{>><<}',
  'emoji before': '😀😀 {++x++} 😀 {--y--} {==z==}{>>w<<}',
  'emoji inside': '{++😀 ok++} {~~😀~>日本語~~}',
  'cjk comment': '本文 {==強調==}{>>id=c3;type=comment | メモ 😀<<} 終わり',
  crlf: 'a\r\n{++b++}\r\n{--c--}\r\n',
  'lone cr and ls': 'a\r{++b\u2028c++}\u2029{>>d<<}',
  'bom nbsp': '\uFEFF{++a\u00A0b++}\u00A0{>> \u00A0id=x\u00A0 |\u00A0body\u00A0<<}',
  tabs: '{>>\tid=t;type=comment\t|\tbody\t<<}',
  'only whitespace': ' \n\t ',
  'fenced code': '```\n{++not special++}\n```\n{++real++}',
  'metadata and no separator': '{>>id=c9;type=comment<<}',
  'separator only': '{>> | <<}',
  'empty metadata': '{>> | body<<}',
  'metadata no id': '{>>type=comment | body<<}',
  'empty id': '{>>id=;type=comment | body<<}',
  'duplicate keys': '{>>id=a;id=b | body<<}',
  'key equals first': '{>>=x;id=k | body<<}',
  'extra separator': '{>>id=a | b | c<<}',
  'created at plain': '{>>id=a;createdAt=1700000000000 | b<<}',
  'created at hex': '{>>id=a;createdAt=0x10 | b<<}',
  'created at octal binary': '{>>id=a;createdAt=0o7 | b<<}{>>id=b;createdAt=0b11 | b<<}',
  'created at spaces': '{>>id=a;createdAt= 5 | b<<}',
  'created at exponent': '{>>id=a;createdAt=1e3 | b<<}',
  'created at fractions': '{>>id=a;createdAt=.5 | b<<}{>>id=b;createdAt=5. | b<<}',
  'created at invalid':
    '{>>id=a;createdAt=abc | b<<}{>>id=b;createdAt=1_0 | b<<}{>>id=c;createdAt=0x | b<<}',
  'created at negative': '{>>id=a;createdAt=-5 | b<<}{>>id=b;createdAt=+7 | b<<}',
  'created at infinity': '{>>id=a;createdAt=Infinity | b<<}{>>id=b;createdAt=-Infinity | b<<}',
  'created at zero': '{>>id=a;createdAt=0 | b<<}{>>id=b;createdAt=0.0 | b<<}',
  'created at exp bad': '{>>id=a;createdAt=1e | b<<}{>>id=b;createdAt=1e+ | b<<}',
  'created at from id': `{>>id=critic-comment-${TS36}-ab12;type=comment | b<<}`,
  'created at id too early': `{>>id=critic-comment-${(1_500_000_000_000).toString(36)}-ab | b<<}`,
  'created at id too late': `{>>id=critic-comment-${(4_200_000_000_000).toString(36)}-ab | b<<}`,
  'created at id upper': '{>>id=critic-comment-ABC-ab | b<<}',
  'created at id no dash': `{>>id=critic-comment-${TS36} | b<<}`,
  'created at id empty run': '{>>id=critic-comment--ab | b<<}',
  'created at beats id': `{>>id=critic-comment-${TS36}-x;createdAt=1600000000000 | b<<}`,
  mentions: `{>>id=m1;mentions=${mentions} | with mentions<<}`,
  'mentions invalid json': '{>>id=m2;mentions=%7Bbad | b<<}',
  'mentions bad uri': '{>>id=m3;mentions=%zz | b<<}',
  'mentions bad utf8': '{>>id=m4;mentions=%C3 | b<<}',
  'mentions not array': `{>>id=m5;mentions=${encodeURIComponent('{"a":1}')} | b<<}`,
  'mentions all invalid': `{>>id=m6;mentions=${encodeURIComponent('[{"kind":"x"}]')} | b<<}`,
  attachments: `{>>id=at1;attachments=${attachments} | with files<<}`,
  'format valid': formatPayload('Hello world bold'),
  'format other version': formatPayload('Hello world bold', 2),
  'format other body': formatPayload('Hello world bold', 1, 'changed'),
  'format garbage': '{>>id=f2;format=nope | body<<}',
  'format array': `{>>id=f3;format=${encodeURIComponent('[1]')} | body<<}`,
  'format empty ranges': `{>>id=f4;format=${encodeURIComponent('{"v":1,"hash":"x","ranges":[]}')} | body<<}`,
  'ReDoS openers': '{++'.repeat(3000) + 'tail',
  'many closers missing': '{==a'.repeat(1500) + '==}{>>',
  'highlight then missing close': '{==a==}{>>never closed {==b==}{>>c<<}',
  'brace noise': '{ {+ {++ } {> {>> {~ {~~ {= {-',
  'markdown around': '# T\n\n- {++item++}\n- {--old--}\n\n> {==q==}{>>c<<}'
}

export function parseCases(external: MarkdownSource[]): OracleCase[] {
  const cases = indexed(PARSE_SOURCES).map(([slug, md]) =>
    fnCase('critic-parse', slug, 'critic.parseCriticMarkup', md)
  )
  external.forEach((source, i) => {
    const id = `src-${String(i).padStart(4, '0')}`
    cases.push(fnCase('critic-parse-src', id, 'critic.parseCriticMarkup', source.markdown))
    const cut = source.markdown.indexOf('\n', Math.floor(source.markdown.length / 2))
    const at = cut === -1 ? source.markdown.length : cut
    const spliced = `${source.markdown.slice(0, at)}\n{++😀 add++} {--del--}{>>id=c-${i};type=comment | 日本 😀<<}\n${source.markdown.slice(at)}`
    cases.push(fnCase('critic-parse-mixed', id, 'critic.parseCriticMarkup', spliced))
  })
  return cases
}

const moved = (mark: CriticMarkupMark, by: number): CriticMarkupMark => ({
  ...mark,
  start: mark.start + by,
  end: mark.end + by
})

/** Round trips and edits of parsed marks. */
export function serializeCases(): OracleCase[] {
  const cases: OracleCase[] = []
  const add = (slug: string, plain: string, marks: unknown[]): void => {
    cases.push(fnCase('critic-serialize', slug, 'critic.serializeCriticMarkup', plain, marks))
  }
  indexed(PARSE_SOURCES).forEach(([slug, md]) => {
    const parsed = parseCriticMarkup(md)
    add(`roundtrip-${slug}`, parsed.plainText, parsed.marks)
  })

  const base = parseCriticMarkup(
    'Hi 😀 {++add++} mid {--del--} {~~a~>b~~} {==hl 日本==}{>>id=c1;type=comment | body<<} end'
  )
  const [addition, deletion, substitution, comment] = base.marks
  add('stale-comment-relocates', base.plainText, [moved(comment, 3)])
  add('stale-addition-dropped', base.plainText, [moved(addition, 3)])
  add('stale-comment-missing-text', base.plainText, [{ ...comment, visibleText: 'absent' }])
  add('stale-deletion-dropped', base.plainText, [moved(deletion, -1)])
  add('negative-start', base.plainText, [{ ...addition, start: -2, end: 3 }])
  add('end-before-start', base.plainText, [{ ...addition, start: 8, end: 4 }])
  add('empty-visible-anywhere', base.plainText, [
    { ...comment, visibleText: '', start: 99, end: 99 }
  ])
  add('overlapping', base.plainText, [
    { ...addition, start: 0, end: 6, visibleText: base.plainText.slice(0, 6) },
    { ...deletion, start: 2, end: 5, visibleText: base.plainText.slice(2, 5) }
  ])
  add('unsorted', base.plainText, [comment, substitution, deletion, addition])
  add('same-start', base.plainText, [
    { ...comment, start: 0, end: 0, visibleText: '', id: 'z' },
    { ...comment, start: 0, end: 0, visibleText: '', id: 'y' }
  ])
  add('emoji-offsets', '😀😀 x', [
    { id: 'e', kind: 'addition', visibleText: '😀 x', start: 2, end: 6 }
  ])
  add('metadata-kept', 'abc', [
    {
      id: 'k',
      kind: 'comment',
      visibleText: 'b',
      body: 'hi',
      metadata: ' x=1 ; y=2 ',
      start: 1,
      end: 2
    }
  ])
  add('no-original-text', 'abc', [
    { id: 's', kind: 'substitution', visibleText: 'b', start: 1, end: 2 }
  ])
  add('empty-text', '', [
    { id: 'c', kind: 'comment', visibleText: '', body: 'only', start: 0, end: 0 }
  ])
  return cases
}

/** The payload builder over the shapes of metadata, mentions, attachments and format ranges. */
export function payloadCases(): OracleCase[] {
  const cases: OracleCase[] = []
  const add = (slug: string, mark: Record<string, unknown>): void => {
    cases.push(fnCase('critic-payload', slug, 'critic.buildCommentPayload', mark))
  }
  const mention = { kind: 'note', refId: 'n1', label: 'Note é' }
  const attachment = {
    id: 'a1',
    name: 'p.png',
    path: 'x/p.png',
    size: 12,
    mimeType: 'image/png',
    type: 'image'
  }
  add('bare', { id: 'c1' })
  add('body', { id: 'c1', body: 'hello' })
  add('body-trim', { id: 'c1', body: '  hello  ' })
  add('metadata', { id: 'c1', metadata: ' id=c1;type=comment;x=1 ', body: 'b' })
  add('metadata-blank', { id: 'c1', metadata: '   ', body: 'b' })
  add('mentions', { id: 'c1', body: 'b', mentions: [mention] })
  add('mentions-invalid-only', { id: 'c1', body: 'b', mentions: [{ ...mention, refId: '' }] })
  add('mentions-empty-array', { id: 'c1', body: 'b', mentions: [] })
  add('attachments', { id: 'c1', body: 'b', attachments: [attachment] })
  add('attachments-fractions', {
    id: 'c1',
    attachments: [
      { id: 'a', name: 'n', path: 'p', size: 0.1, mimeType: '', type: 'file' },
      { id: 'b', name: 'n', path: 'p', size: 1e21 },
      { id: 'c', name: 'n', path: 'p', size: 123456789.125 }
    ]
  })
  add('attachments-empty-id', { id: 'c1', attachments: [{ ...attachment, id: '' }] })
  add('format', {
    id: 'c1',
    body: 'Hello world',
    formatRanges: [{ start: 0, end: 5, marks: ['bold'] }]
  })
  add('format-order', {
    id: 'c1',
    body: 'Hello 😀 world',
    formatRanges: [
      { start: 6, end: 8, marks: ['code', 'bold', 'bold', 'italic'] },
      { start: 0, end: 5, marks: ['underline', 'strikethrough'] },
      { start: 0, end: 3, marks: ['bold'] }
    ]
  })
  add('format-clamped', {
    id: 'c1',
    body: 'abc',
    formatRanges: [
      { start: 1, end: 99, marks: ['bold'] },
      { start: 3, end: 4, marks: ['bold'] },
      { start: -1, end: 2, marks: ['bold'] },
      { start: 2, end: 2, marks: ['bold'] },
      { start: 0, end: 1, marks: [] }
    ]
  })
  add('format-fractional', {
    id: 'c1',
    body: 'abcdef',
    formatRanges: [{ start: 0.5, end: 2.25, marks: ['bold'] }]
  })
  add('format-trimmed-body', {
    id: 'c1',
    body: '  abc  ',
    formatRanges: [{ start: 0, end: 3, marks: ['bold'] }]
  })
  add('format-empty', { id: 'c1', body: 'abc', formatRanges: [] })
  add('all-three', {
    id: 'c1',
    body: 'abc',
    metadata: 'id=c1;mentions=old;attachments=old;format=old;keep=1;;=bad;lone',
    mentions: [mention],
    attachments: [attachment],
    formatRanges: [{ start: 0, end: 1, marks: ['code'] }]
  })
  add('stale-keys-dropped', {
    id: 'c1',
    metadata: 'id=c1;mentions=old;attachments=old;format=old',
    mentions: []
  })
  add('only-stale-keys', { id: 'c1', metadata: 'mentions=old', mentions: [] })
  add('unicode-everything', {
    id: 'ç1',
    body: '日本語 😀',
    mentions: [{ kind: 'journal', refId: 'ü', label: '😀 "quoted" \\ \n' }],
    formatRanges: [{ start: 0, end: 4, marks: ['italic'] }]
  })
  return cases
}

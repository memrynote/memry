/** Cases of the metadata normalisers and the transforms. */
import type { OracleCase } from '../cases-frontmatter'
import {
  buildCommentPayload,
  parseCriticMarkup
} from '../../../../../packages/shared/src/critic-markup/parser'
import { fnCase } from './critic-cases-parse'

const VALUES: Record<string, unknown> = {
  'not-array': { a: 1 },
  null: null,
  string: 'x',
  number: 3,
  'empty-array': [],
  'non-objects': [1, 'x', null, true, [1]],
  'valid-all': [
    { kind: 'note', refId: 'r', label: 'l' },
    { kind: 'task', refId: 'r', label: 'l' },
    { kind: 'journal', refId: 'r', label: 'l' },
    { kind: 'inbox', refId: 'r', label: 'l' },
    { kind: 'calendar_event', refId: 'r', label: 'l' }
  ],
  'bad-kind': [
    { kind: 'Note', refId: 'r', label: 'l' },
    { kind: 3, refId: 'r', label: 'l' }
  ],
  'missing-fields': [
    { kind: 'note' },
    { kind: 'note', refId: 'r' },
    { kind: 'note', refId: 3, label: 'l' }
  ],
  'extra-fields': [{ kind: 'note', refId: 'r', label: 'l', extra: 1 }],
  attachments: [
    { id: 'a', name: 'n', path: 'p' },
    { id: 'a', name: 'n', path: 'p', size: 5, mimeType: 'm', type: 'image', extra: 1 },
    { id: 'a', name: 'n', path: 'p', size: '5', mimeType: 5, type: 'zip' },
    { id: 'a', name: 'n', path: 'p', size: 0, mimeType: '', type: 'file' },
    { id: '', name: 'n', path: 'p' },
    { id: 'a', name: '', path: 'p' },
    { id: 'a', name: 'n', path: '' }
  ],
  ranges: [
    { start: 0, end: 3, marks: ['bold'] },
    { start: 1, end: 100, marks: ['code', 'italic', 'code'] },
    { start: 5, end: 9, marks: ['bold'] },
    { start: -1, end: 3, marks: ['bold'] },
    { start: 2, end: 2, marks: ['bold'] },
    { start: 'a', end: 3, marks: ['bold'] },
    { start: 0, end: 3, marks: 'bold' },
    { start: 0, end: 3, marks: ['nope'] },
    { start: 0, end: 3 },
    { start: 0, end: 1, marks: ['strikethrough', 'underline'] },
    { start: 0, end: 2.5, marks: ['bold'] },
    { start: 0.5, end: 1.5, marks: ['bold', 3, null] }
  ]
}

export function normalizeCases(): OracleCase[] {
  const cases: OracleCase[] = []
  for (const [slug, value] of Object.entries(VALUES)) {
    cases.push(fnCase('critic-normalize', `mentions-${slug}`, 'critic.normalizeMentions', value))
    cases.push(
      fnCase('critic-normalize', `attachments-${slug}`, 'critic.normalizeAttachments', value)
    )
    for (const length of [0, 3, 6, 50]) {
      cases.push(
        fnCase(
          'critic-normalize',
          `ranges-${slug}-${length}`,
          'critic.normalizeFormatRanges',
          value,
          length
        )
      )
    }
  }
  const body = 'Hello 😀 world'
  const withFormat = buildCommentPayload({
    id: 'x',
    body,
    formatRanges: [{ start: 0, end: 5, marks: ['bold'] }]
  })
  const encoded = /format=([^;| ]+)/.exec(withFormat)?.[1] ?? ''
  for (const [slug, encodedValue, text] of [
    ['valid', encoded, body],
    ['other-body', encoded, 'Hello world'],
    ['body-needs-trim', encoded, `  ${body}  `],
    ['empty', '', body],
    ['null', null, body],
    ['bad-uri', '%E0%A4%A', body],
    ['bad-json', '%7B', body],
    ['percent-only', '%', body],
    ['lowercase-hex', encoded.toLowerCase(), body],
    ['plus-sign', encoded.replaceAll('%20', '+'), body]
  ] as const) {
    cases.push(
      fnCase('critic-normalize', `format-${slug}`, 'critic.parseCommentFormat', encodedValue, text)
    )
  }
  for (const [slug, text] of [
    ['empty', ''],
    ['ascii', 'hello'],
    ['padded', '  hello \n'],
    ['emoji', '😀 日本語'],
    ['nbsp', '\u00A0x\u00A0'],
    ['long', 'x'.repeat(5000)]
  ] as const) {
    cases.push(fnCase('critic-normalize', `hash-${slug}`, 'critic.bodyHash', text))
  }
  return cases
}

export function transformCases(): OracleCase[] {
  const cases: OracleCase[] = []
  const docs: Record<string, string> = {
    mixed:
      'Hello 😀 {++big++} world {--old--} and {~~a~>bcd~~} then {==hi 日本==}{>>c1 | note<<} end {>>solo<<}',
    'tail-marks': '{--a--}{++b++}{~~c~>dd~~}',
    'shrink-substitution': 'x {~~long text~>s~~} y {++z++}',
    'no-original': 'p {++q++}',
    'empty-visible': 'a {--b--}{>>c<<}'
  }
  for (const [docSlug, md] of Object.entries(docs)) {
    const parsed = parseCriticMarkup(md)
    const ids = [...parsed.marks.map((mark) => mark.id), 'missing-id']
    ids.forEach((id, index) => {
      for (const name of ['accept', 'reject', 'resolve', 'delete']) {
        cases.push(
          fnCase(
            'critic-transform',
            `${name}-${docSlug}-${index}`,
            `critic.${name}CriticMark`,
            parsed.plainText,
            parsed.marks,
            id
          )
        )
      }
    })
  }
  const parsed = parseCriticMarkup('😀 {~~a~>b~~} 😀')
  const [sub] = parsed.marks
  cases.push(
    fnCase(
      'critic-transform',
      'reject-no-original-field',
      'critic.rejectCriticMark',
      parsed.plainText,
      [{ ...sub, originalText: undefined }],
      sub.id
    ),
    fnCase(
      'critic-transform',
      'duplicate-ids',
      'critic.acceptCriticMark',
      'ab',
      [
        { id: 'd', kind: 'deletion', visibleText: 'a', originalText: 'a', start: 0, end: 1 },
        { id: 'd', kind: 'deletion', visibleText: 'b', originalText: 'b', start: 1, end: 2 }
      ],
      'd'
    ),
    fnCase(
      'critic-transform',
      'reject-addition-offsets-out-of-range',
      'critic.rejectCriticMark',
      'ab',
      [{ id: 'o', kind: 'addition', visibleText: 'zz', start: 5, end: 9 }],
      'o'
    ),
    fnCase(
      'critic-transform',
      'reject-addition-negative',
      'critic.rejectCriticMark',
      'abcd',
      [{ id: 'o', kind: 'addition', visibleText: 'zz', start: -3, end: -1 }],
      'o'
    )
  )
  return cases
}

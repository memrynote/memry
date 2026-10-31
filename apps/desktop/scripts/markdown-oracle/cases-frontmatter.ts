/**
 * Inputs of the `frontmatter.json` and `markdown-class.json` vector files. The
 * expected outputs come from running the Electron code on them
 * (`oracle-serve.oracle.ts`); nothing here states an answer.
 */
import { encodeYaml, type YamlJson } from './yaml-json'

export interface OracleCase {
  id: string
  op: string
  input: Record<string, unknown>
}

const FM = (body: string, eol = '\n'): string => `---${eol}${body}---${eol}`

function splitCases(): OracleCase[] {
  const raws: Record<string, string> = {
    'plain-block': `${FM('title: A\n')}body\n`,
    'crlf-block': `${FM('title: A\r\n', '\r\n')}body\r\n`,
    'bom-block': `\uFEFF${FM('title: A\n')}body\n`,
    'no-frontmatter': 'just a body\n',
    'empty-input': '',
    'only-delimiter': '---\n',
    'unclosed-block': '---\ntitle: A\nbody continues\n',
    'unclosed-crlf': '---\r\ntitle: A\r\n',
    'no-final-newline': '---\ntitle: A\n---',
    'closing-at-eof-with-body-none': '---\na: 1\n---\n',
    'empty-block': '---\n---\nbody\n',
    'blank-line-separator': `${FM('a: 1\n')}\n\nbody\n`,
    'leading-blank-line': `\n${FM('a: 1\n')}body\n`,
    'four-dashes-open': '----\na: 1\n---\nbody\n',
    'four-dashes-close': '---\na: 1\n----\nbody\n---\n',
    'spaces-after-open': '--- \na: 1\n---\n',
    'spaces-after-close': '---\na: 1\n--- \nbody\n',
    'horizontal-rule-body': `${FM('a: 1\n')}text\n---\nmore\n`,
    'comment-lines': FM('# note\na: 1 # trailing\n'),
    'lone-cr-open': '---\r---\nbody\n',
    'bom-only': '\uFEFF',
    'bom-no-block': '\uFEFFbody\n',
    'unicode-body': `${FM('t: é\n')}日本語 😀\n`,
    'mixed-eol': '---\r\na: 1\n---\nbody\r\n',
    'close-with-cr-only-line': '---\na: 1\n---\r\nbody\n',
    'many-docs': '---\na: 1\n---\nbody\n---\nb: 2\n---\n',
    'dash-in-value': FM('a: ---\n'),
    'closing-after-blank': '---\n\n\n---\nbody\n',
    'nul-in-body': `${FM('a: 1\n')}x\u0000y\n`,
    'line-separator-body': `${FM('a: 1\n')}x\u2028y\n`
  }
  return Object.entries(raws).map(([slug, raw]) => ({
    id: `frontmatter/split/${slug}`,
    op: 'split',
    input: { raw }
  }))
}

function parseCases(): OracleCase[] {
  const raws: Record<string, string> = {
    simple: `${FM('title: Hello\ntags:\n  - a\n  - b\n')}body\n`,
    crlf: `${FM('title: Hello\r\nn: 2\r\n', '\r\n')}body\r\n`,
    bom: `\uFEFF${FM('title: Hello\n')}body\n`,
    'no-frontmatter': 'body only\n',
    'empty-block': '---\n---\nbody\n',
    'comments-only': FM('# a comment\n  # another\n'),
    'comment-and-key': FM('# lead\nkey: v\n'),
    'unclosed-block': '---\nkey: v\nbody\n',
    'no-final-newline': `${FM('key: v\n')}body`,
    'only-whitespace-block': FM('   \n\n'),
    'blank-line-separator': `${FM('key: v\n')}\n\nbody\n`,
    'bare-date': FM('created: 2024-01-15\n'),
    'iso-datetime': FM('created: 2024-01-15T10:30:00Z\nupdated: 2024-01-15 10:30:00.5 +02:00\n'),
    'quoted-date-stays-string': FM('created: "2024-01-15"\n'),
    'nested-map': FM('a:\n  b:\n    c: 1\n  d: [1, 2]\n'),
    'flow-map': FM('a: {x: 1, y: two}\n'),
    'list-top-level': FM('- a\n- b\n'),
    'scalar-top-level': FM('just text\n'),
    'null-top-level': FM('~\n'),
    'number-top-level': FM('42\n'),
    'invalid-yaml': FM('a: [1, 2\n'),
    'tab-indent-error': FM('a:\n\tb: 1\n'),
    'duplicate-key': FM('a: 1\na: 2\n'),
    'anchors-merge': FM('base: &b {x: 1}\nuse:\n  <<: *b\n  y: 2\n'),
    'multiline-literal': FM('desc: |\n  line one\n  line two\n'),
    'multiline-folded': FM('desc: >-\n  line one\n  line two\n'),
    'quoted-keys': FM('"a b": 1\n\'c: d\': 2\n'),
    'integer-keys-order': FM('b: 1\n2: x\na: 3\n1: y\n'),
    'booleans-and-nulls': FM('a: true\nb: No\nc: null\nd: ~\ne:\nf: yes\n'),
    numbers: FM(
      'a: 1\nb: 1.5\nc: 0x1F\nd: 0o17\ne: 1_000\nf: .inf\ng: -.INF\nh: .nan\ni: 1e3\nj: 190:20:30\n'
    ),
    'unicode-values': FM('t: 日本語 😀\nu: "\\u00e9\\U0001F600"\n'),
    'document-markers-in-block': FM('a: 1\n...\n'),
    'directive-in-block': FM('%YAML 1.2\n---\na: 1\n'),
    'hash-in-first-line': '---\n#a\n---\nbody\n',
    'language-line': '---yaml\na: 1\n---\n',
    'close-marker-lookalike': '---\na: 1\n---x\nb: 2\n---\nbody\n',
    'whitespace-then-comment': FM('\n   \n  # c\n'),
    'set-and-omap': FM('s: !!set {a, b}\no: !!omap\n  - a: 1\n  - b: 2\np: !!pairs\n  - a: 1\n'),
    binary: FM('b: !!binary aGVsbG8=\n'),
    'explicit-int-tag': FM('a: !!int "12"\nb: !!str 12\nc: !!float 1\n'),
    'unknown-tag': FM('a: !custom x\n'),
    'alias-undefined': FM('a: *missing\n'),
    'trailing-spaces-key': FM('a : 1\n'),
    'colon-in-value': FM('url: http://example.com:8080/a?b=c#frag\n'),
    'multi-document-error': FM('a: 1\n---\nb: 2\n')
  }
  return Object.entries(raws).map(([slug, raw]) => ({
    id: `frontmatter/parse/${slug}`,
    op: 'parse',
    input: { raw }
  }))
}

function serializeCases(): OracleCase[] {
  const base = `${FM('title: Hello\ntags: [a, b]\ncreated: 2024-01-15\n')}\n\nbody one\nbody two\n`
  const crlf = `${FM('title: Hello\r\n', '\r\n')}\r\nbody one\r\n`
  const cases: Array<[string, Record<string, unknown>]> = [
    ['unedited-same-content', { raw: base }],
    ['unedited-new-body', { raw: base, content: 'new body\n' }],
    ['unedited-new-body-no-final-newline', { raw: base.replace(/\n$/, ''), content: 'new body\n' }],
    ['edited-same-content', { raw: base, frontmatterEdited: true }],
    ['edited-new-body', { raw: base, content: 'edited\n', frontmatterEdited: true }],
    ['crlf-new-body', { raw: crlf, content: 'x\ny\n' }],
    ['crlf-edited', { raw: crlf, frontmatterEdited: true, content: 'x\n' }],
    ['crlf-body-with-lone-cr', { raw: crlf, content: 'a\rb\r\nc\n' }],
    ['no-frontmatter-new-body', { raw: 'old\n', content: 'new\n\n\n' }],
    ['no-frontmatter-edited', { raw: 'old\n', content: 'new\n', frontmatterEdited: true }],
    ['bom-unedited', { raw: `\uFEFF${base}`, content: 'x\n' }],
    ['bom-edited', { raw: `\uFEFF${base}`, content: 'x\n', frontmatterEdited: true }],
    ['separator-kept', { raw: `${FM('a: 1\n')}\n\n\nbody\n`, content: '\n\nnew\n' }],
    ['separator-crlf', { raw: `${FM('a: 1\r\n', '\r\n')}\r\n\r\nbody\r\n`, content: 'new\n' }],
    ['empty-new-body', { raw: base, content: '' }],
    ['empty-new-body-with-block', { raw: FM('a: 1\n') + 'x\n', content: '\n\n' }],
    ['strips-trailing-newlines', { raw: base, content: 'tail\n\n\n\n' }],
    ['keeps-no-trailing-newline', { raw: `${FM('a: 1\n')}x`, content: 'y\n\n' }],
    // A block that ends the file, no line end after its closing fence (#3800).
    ['block-at-eof-new-body', { raw: '---\nmood: ok\n---', content: 'added\n' }],
    ['block-at-eof-crlf', { raw: '---\r\nmood: ok\r\n---', content: 'added\nmore\n' }],
    ['block-at-eof-bom', { raw: '\uFEFF---\nmood: ok\n---', content: 'added' }],
    ['block-at-eof-empty-body', { raw: '---\nmood: ok\n---', content: '' }],
    ['block-at-eof-blank-body', { raw: '---\nmood: ok\n---', content: '\n\n' }],
    ['block-at-eof-leading-newlines', { raw: '---\nmood: ok\n---', content: '\n\nadded\n' }],
    ['block-at-eof-lone-cr', { raw: '---\r\nmood: ok\r\n---\r', content: 'added' }],
    ['edited-date-respelled', { raw: FM('d: 2024-01-15\n'), frontmatterEdited: true }],
    ['edited-comments-dropped', { raw: FM('# c\na: 1 # t\n'), frontmatterEdited: true }],
    ['edited-quotes-normalised', { raw: FM('a: "x"\nb: \'y\'\nc: z\n'), frontmatterEdited: true }],
    ['edited-key-order-integers', { raw: FM('b: 1\n2: x\na: 3\n1: y\n'), frontmatterEdited: true }],
    [
      'edited-long-string-folds',
      { raw: FM(`d: ${'word '.repeat(30).trim()}\n`), frontmatterEdited: true }
    ],
    ['edited-multiline-literal', { raw: FM('d: |\n  a\n  b\n'), frontmatterEdited: true }],
    ['edited-aliases-become-refs', { raw: FM('a: &x [1, 2]\nb: *x\n'), frontmatterEdited: true }],
    ['edited-aliased-map', { raw: FM('a: &x {p: 1}\nb: *x\n'), frontmatterEdited: true }],
    [
      'edited-merge-key',
      { raw: FM('base: &b {x: 1}\nuse:\n  <<: *b\n  y: 2\n'), frontmatterEdited: true }
    ],
    ['edited-empty-map-drops-block', { raw: '---\n---\nbody\n', frontmatterEdited: true }],
    ['edited-null-frontmatter-throws', { raw: FM('~\n'), frontmatterEdited: true }],
    ['edited-list-frontmatter', { raw: FM('- a\n- b\n'), frontmatterEdited: true }],
    ['edited-scalar-frontmatter', { raw: FM('abc\n'), frontmatterEdited: true }],
    ['edited-number-frontmatter', { raw: FM('42\n'), frontmatterEdited: true }],
    ['edited-invalid-yaml-throws', { raw: FM('a: [1\n'), frontmatterEdited: true }],
    ['edited-unicode', { raw: FM('t: 日本語 😀 é\n'), frontmatterEdited: true }],
    ['edited-binary', { raw: FM('b: !!binary aGVsbG8=\n'), frontmatterEdited: true }],
    [
      'edited-special-floats',
      { raw: FM('a: .inf\nb: -.inf\nc: .nan\nd: 1e-7\ne: 1e21\n'), frontmatterEdited: true }
    ],
    [
      'edited-bool-forms',
      { raw: FM('a: Yes\nb: TRUE\nc: off\nd: null\n'), frontmatterEdited: true }
    ],
    [
      'edited-crlf-multiline',
      { raw: FM('d: |\r\n  a\r\n  b\r\n', '\r\n'), frontmatterEdited: true }
    ],
    [
      'edited-set-omap-pairs',
      {
        raw: FM('s: !!set {a, b}\no: !!omap\n  - a: 1\np: !!pairs\n  - k: v\n'),
        frontmatterEdited: true
      }
    ],
    [
      'edited-timestamp-forms',
      {
        raw: FM('a: 2001-12-14t21:59:43.10-05:00\nb: 2001-12-14 21:59:43.10 -5\nc: 2002-12-14\n'),
        frontmatterEdited: true
      }
    ],
    [
      'edited-date-overflow',
      { raw: FM('a: 2024-02-31\nb: 0050-01-01\nc: 2024-13-01\n'), frontmatterEdited: true }
    ]
  ]
  return cases.map(([slug, input]) => ({
    id: `frontmatter/serialize/${slug}`,
    op: 'serialize',
    input: { frontmatterEdited: false, ...input }
  }))
}

const longWords = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor '

function dumpValues(): Array<[string, unknown]> {
  const strings: Array<[string, string]> = [
    ['plain-word', 'hello'],
    ['empty', ''],
    ['true-word', 'true'],
    ['null-word', 'null'],
    ['tilde', '~'],
    ['yes', 'yes'],
    ['no-capitalised', 'No'],
    ['y-letter', 'y'],
    ['on-word', 'on'],
    ['int-like', '123'],
    ['float-like', '1.5'],
    ['exp-like', '1e3'],
    ['hex-like', '0x1F'],
    ['octal-like', '0o7'],
    ['date-like', '2024-01-01'],
    ['datetime-like', '2024-01-01T10:00:00Z'],
    ['merge-key-like', '<<'],
    ['dash', '-'],
    ['dash-space', '- x'],
    ['question', '? x'],
    ['colon-space', 'a: b'],
    ['space-hash', 'a #b'],
    ['leading-hash', '#a'],
    ['inner-hash', 'a#b'],
    ['leading-space', ' lead'],
    ['trailing-space', 'trail '],
    ['newline-inside', 'multi\nline'],
    ['newline-trailing', 'multi\nline\n'],
    ['only-newline', '\n'],
    ['double-newline', 'a\n\nb'],
    ['keep-chomp', 'a\n\n'],
    ['leading-newline-space', '\n indented'],
    ['more-indented-line', 'a\n  b\nc'],
    ['tab', 'tab\there'],
    ['single-quote', "it's"],
    ['double-quote', 'say "hi"'],
    ['backslash', 'a\\b'],
    ['unicode-bmp', 'é ü 日本語'],
    ['emoji', 'smile 😀'],
    ['nbsp', 'a\u00a0b'],
    ['line-separator', 'a\u2028b'],
    ['nul', 'a\u0000b'],
    ['delete', 'a\u007fb'],
    ['next-line', 'a\u0085b'],
    ['bom', '\uFEFFa'],
    ['flow-seq-chars', '[a]'],
    ['flow-map-chars', '{a}'],
    ['comma', 'a, b'],
    ['at-sign', '@at'],
    ['backtick', '`tick'],
    ['percent', '%pct'],
    ['bang', '!bang'],
    ['ampersand', '&amp'],
    ['star', '*star'],
    ['pipe', '|pipe'],
    ['gt', '>gt'],
    ['equals', '=eq'],
    ['dash-dash-dash', '---'],
    ['long-foldable', `${longWords}${longWords}end`],
    ['long-no-space', 'x'.repeat(120)],
    ['long-with-newline', `${longWords}${longWords}\nsecond line`],
    ['long-more-indented', `${longWords}${longWords}\n  ${longWords}${longWords}`],
    ['long-url', `https://example.com/${'path/'.repeat(30)}`],
    ['long-with-quote', `${longWords}it's ${longWords}`],
    ['width-boundary-80', 'a '.repeat(40).trim()],
    ['width-boundary-81', `${'a '.repeat(40)}b`],
    ['crlf-inside', 'a\r\nb'],
    ['cr-inside', 'a\rb'],
    ['ten-lines', Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n')],
    ['colon-end', 'ends:'],
    ['colon-no-space', 'a:b'],
    ['plain-with-dash-inside', 'a-b - c'],
    ['version-like', '1.2.3'],
    ['signed-int-like', '+12'],
    ['underscore-int-like', '1_000'],
    ['sexagesimal-like', '1:30'],
    ['inf-like', '.inf'],
    ['nan-like', '.nan'],
    ['astral-only', '😀'],
    ['control-bell', 'a\u0007b'],
    ['escape-char', 'a\u001bb'],
    ['non-char', 'a\ufffeb'],
    ['private-use', 'a\ue000b']
  ]
  const values: Array<[string, unknown]> = strings.map(([slug, value]) => [
    `string-${slug}`,
    { k: value }
  ])
  const longKey = 'k'.repeat(1100)
  const keys = [
    'key with spaces',
    'a:b',
    'true',
    '123',
    '',
    '#k',
    'ключ',
    '- k',
    '? k',
    'k: v',
    'null',
    '~',
    "it's",
    'a"b',
    'multi\nline',
    '1.5',
    '2024-01-01',
    ' lead',
    'trail ',
    '😀',
    'tab\tkey',
    '<<',
    'long ' + 'word '.repeat(30)
  ]
  for (const [index, key] of keys.entries()) values.push([`key-${index}`, { [key]: 'v' }])
  values.push(['key-over-1024', { [longKey]: 'v' }])
  const numbers: Array<[string, number]> = [
    ['zero', 0],
    ['negative-zero', -0],
    ['one', 1],
    ['minus-one', -1],
    ['half', 1.5],
    ['e21', 1e21],
    ['e-7', 1e-7],
    ['long-fraction', 123456789.123456],
    ['point-three', 0.1 + 0.2],
    ['nan', Number.NaN],
    ['inf', Number.POSITIVE_INFINITY],
    ['minus-inf', Number.NEGATIVE_INFINITY],
    ['e100', 1e100],
    ['min-double', 5e-324],
    ['big-int', Number('9007199254740993')],
    ['e-6', 0.000001],
    ['e20', 1e20],
    ['negative-fraction', -0.25],
    ['max-double', Number.MAX_VALUE],
    ['five-e-100', 5e-100]
  ]
  for (const [slug, value] of numbers) values.push([`number-${slug}`, { n: value }])
  values.push(
    ['bool-true', { a: true, b: false }],
    ['null-value', { a: null }],
    ['date-midnight', { d: new Date('2024-01-15T00:00:00.000Z') }],
    ['date-ms', { d: new Date('2024-01-15T10:30:45.123Z') }],
    ['date-big-year', { d: new Date('+012345-01-01T00:00:00.000Z') }],
    ['date-early-year', { d: new Date('0001-01-01T00:00:00.000Z') }],
    ['binary', { b: Buffer.from('hello world') }],
    ['binary-tail-one', { b: Buffer.from([1, 2, 3, 4]) }],
    ['binary-empty', { b: Buffer.from([]) }],
    ['empty-seq', { a: [] }],
    ['empty-map', { a: {} }],
    ['seq-scalars', { a: [1, 'two', true, null] }],
    [
      'seq-nested',
      {
        a: [
          [1, 2],
          [3, [4, 5]]
        ]
      }
    ],
    ['seq-of-maps', { a: [{ x: 1, y: 2 }, { z: 3 }] }],
    ['seq-of-empties', { a: [[], {}, []] }],
    ['seq-multiline-strings', { a: ['x\ny', 'p\nq\n'] }],
    ['seq-of-long-strings', { a: [`${longWords}${longWords}`, 'short'] }],
    ['map-depth-4', { a: { b: { c: { d: 'deep', e: [1] } } } }],
    ['map-integer-key-order', { b: 1, 2: 'x', a: 3, 1: 'y', '01': 'z', '4294967295': 'w' }],
    ['map-empty-nested', { a: { b: {} } }],
    ['map-with-seq-of-seq-of-map', { a: [[{ k: 'v' }]] }],
    ['map-numeric-string-values', { a: '1', b: '1.0', c: 'true', d: 'null' }],
    ['seq-explicit-null-items', { a: [null, null] }],
    ['map-with-dollar-key', { $date: 'x', other: 1 }],
    [
      'seq-of-dates',
      { a: [new Date('2024-01-15T00:00:00.000Z'), new Date('2025-02-03T04:05:06.007Z')] }
    ],
    [
      'typical-note',
      {
        title: 'Weekly review: plan & ship',
        tags: ['work', 'review', '2024'],
        aliases: [],
        created: new Date('2024-01-15T10:30:00.000Z'),
        pinned: false,
        priority: 3,
        'memry-id': 'b0c1d2e3-0000-4000-8000-000000000000'
      }
    ],
    [
      'typical-properties',
      { status: 'In Progress', rating: 4.5, link: '[[Other note]]', url: 'https://x.test/a?b=c#d' }
    ],
    ['one-key', { only: 'one' }],
    ['unicode-keys-and-values', { ключ: 'значение', 日本: ['語', '😀'] }]
  )
  return values
}

function dumpCases(): OracleCase[] {
  return dumpValues().flatMap(([slug, value]) => {
    const encoded: YamlJson = encodeYaml(value)
    const base: OracleCase = {
      id: `frontmatter/dump/${slug}`,
      op: 'dump',
      input: { value: encoded }
    }
    return slug.startsWith('typical') || slug === 'string-multiline-newline-inside'
      ? [
          base,
          {
            id: `frontmatter/dump/${slug}-crlf`,
            op: 'dump',
            input: { value: encoded, eol: '\r\n' }
          }
        ]
      : [base]
  })
}

function loadCases(): OracleCase[] {
  const texts: Record<string, string> = {
    'plain-scalar': 'hello',
    'int-decimal': 'a: 12',
    'int-signed': 'a: [-12, +12, 0, -0, +0]',
    'int-binary': 'a: 0b1010',
    'int-octal': 'a: 0755',
    'int-hex': 'a: 0xFF',
    'int-underscores': 'a: 1_000_000',
    'int-sexagesimal': 'a: 190:20:30',
    'int-huge': 'a: 123456789012345678901234567890',
    'int-trailing-underscore-is-string': 'a: 12_',
    'int-bad-octal-is-string': 'a: 0789',
    'float-forms': 'a: [1.5, -1.5, .5, 5., 1e3, 1.5E-3, +1.5, 1_0.5]',
    'float-special': 'a: [.inf, -.inf, +.Inf, .INF, .nan, .NaN, .NAN]',
    'float-sexagesimal': 'a: 20:59.5',
    'float-not-quite': 'a: [1.2.3, 1e, e3, ., 1_.5, 0.]',
    'bool-forms': 'a: [true, True, TRUE, false, False, FALSE, yes, no, on, off, y, n]',
    'null-forms': 'a: [~, null, Null, NULL, ]\nb:\nc: ~',
    'timestamp-date': 'a: 2024-01-15',
    'timestamp-datetime-z': 'a: 2024-01-15T10:30:00Z',
    'timestamp-space-sep': 'a: 2024-01-15 10:30:00',
    'timestamp-offset': 'a: 2001-12-14t21:59:43.10-05:00',
    'timestamp-short-offset': 'a: 2001-12-14 21:59:43.10 -5',
    'timestamp-fraction-long': 'a: 2024-01-15T10:30:00.123456789Z',
    'timestamp-overflow-day': 'a: 2024-02-31',
    'timestamp-overflow-month': 'a: 2024-13-01',
    'timestamp-two-digit-year-quirk': 'a: 0050-01-01',
    'timestamp-single-digit-parts': 'a: 2024-1-5 1:02:03',
    'timestamp-single-digit-date-is-string': 'a: 2024-1-5',
    'timestamp-trailing-text-is-string': 'a: 2024-01-15 extra',
    'timestamp-tz-minutes': 'a: 2024-01-15T10:30:00+05:30',
    'timestamp-quoted-is-string': 'a: "2024-01-15"',
    'timestamp-key': '2024-01-15: x',
    'single-quoted': "a: 'it''s'\nb: 'multi\n  line'",
    'double-quoted-escapes':
      'a: "tab\\there\\nnewline \\" \\\\ \\/ \\0 \\a \\b \\e \\v \\f \\r \\N \\_ \\L \\P \\x41 \\u00e9 \\U0001F600"',
    'double-quoted-surrogate-pair': 'a: "\\ud83d\\ude00"',
    'double-quoted-line-fold': 'a: "one\n  two\n\n  three"',
    'double-quoted-escaped-newline': 'a: "one \\\n   two"',
    'double-quoted-bad-escape': 'a: "\\q"',
    'double-quoted-bad-hex': 'a: "\\xZZ"',
    'unterminated-double': 'a: "oops',
    'unterminated-single': "a: 'oops",
    'literal-clip': 'a: |\n  one\n  two\nb: 1',
    'literal-strip': 'a: |-\n  one\n  two\n',
    'literal-keep': 'a: |+\n  one\n\n\nb: 1',
    'literal-indent-indicator': 'a: |2\n    indented\n  base\n',
    'literal-bad-indent-zero': 'a: |0\n  x\n',
    'literal-repeat-chomp': 'a: |+-\n  x\n',
    'folded-basic': 'a: >\n  one\n  two\n\n  three\n',
    'folded-strip': 'a: >-\n  one\n  two\n',
    'folded-more-indented': 'a: >\n  one\n    indented\n  two\n',
    'folded-keep': 'a: >+\n  one\n\n',
    'folded-comment-header': 'a: > # comment\n  text\n',
    'plain-multiline': 'a: one\n  two\n  three\nb: x',
    'plain-with-hash': 'a: one #comment\nb: two#notcomment',
    'plain-with-colon': 'a: http://x.test:80/p',
    'plain-dash-start': 'a: -x\nb: - y',
    'flow-seq': 'a: [1, [2, 3], {x: 1}]',
    'flow-map': 'a: {x: 1, y: [a, b], z: {q: ~}}',
    'flow-multiline': 'a: [\n  1,\n  2\n]\nb: {\n  x: 1\n}',
    'flow-trailing-comma': 'a: [1, 2, ]',
    'flow-missing-comma': 'a: [1 2]',
    'flow-pair-in-seq': 'a: [x: 1, y: 2]',
    'flow-explicit-pair': 'a: [? x : 1]',
    'flow-unterminated': 'a: [1, 2',
    'flow-empty': 'a: []\nb: {}',
    'flow-key-with-null-value': 'a: {x, y}',
    'block-seq-top': '- a\n- b\n-\n- c',
    'block-seq-nested': '- - 1\n  - 2\n- - 3',
    'block-seq-of-maps': '- a: 1\n  b: 2\n- c: 3',
    'block-seq-same-indent-as-parent': 'a:\n- 1\n- 2\nb: 3',
    'block-map-nested': 'a:\n  b:\n    c: 1\n  d: 2\ne: 3',
    'block-map-bad-indent': 'a:\n  b: 1\n c: 2',
    'block-map-missing-colon': 'a: 1\nb\n',
    'block-map-no-space-after-colon': 'a:1',
    'explicit-key': '? a\n: 1\n? [x, y]\n: 2',
    'explicit-key-without-value': '? a\n? b\n',
    'explicit-key-complex': '? - a\n  - b\n: value',
    'key-int': '1: a\n2: b',
    'key-float': '1.5: b\n.inf: c',
    'key-bool': 'true: c\nno: d',
    'key-null': 'null: d',
    'key-tilde': '~: e',
    'key-null-and-tilde-collide': 'null: d\n~: e',
    'array-key': '[1, 2]: x',
    'map-key': '{a: 1}: x',
    'nested-array-key-error': '[[1], 2]: x',
    'integer-key-order': 'b: 1\n10: x\n2: y\na: 2\n01: z',
    'duplicate-key-error': 'a: 1\nb: 2\na: 3',
    'duplicate-key-flow-error': 'a: {x: 1, x: 2}',
    'anchor-alias-scalar': 'a: &x hello\nb: *x',
    'anchor-alias-seq': 'a: &x [1, 2]\nb: *x',
    'anchor-alias-map': 'a: &x {p: 1}\nb: *x',
    'alias-undefined': 'a: *nope',
    'alias-with-tag': 'a: &x 1\nb: !!str *x',
    'anchor-on-block-map': 'a: &x\n  p: 1\nb: *x',
    'anchor-on-block-seq': 'a: &x\n- 1\n- 2\nb: *x',
    'anchor-top-level-scalar': '&x hello',
    'merge-basic': 'base: &b {x: 1, y: 2}\nuse:\n  <<: *b\n  y: 3',
    'merge-list': 'a: &a {p: 1}\nb: &b {q: 2}\nuse:\n  <<: [*a, *b]\n  r: 3',
    'merge-override-after': 'base: &b {x: 1}\nuse:\n  <<: *b\n  x: 9',
    'merge-scalar-error': 'use:\n  <<: 5',
    'merge-null-error': 'use:\n  <<:\n  x: 1',
    'merge-seq-of-seq': 'a: &a [1, 2]\nuse:\n  <<: *a',
    'merge-quoted-key-is-plain-key': 'use:\n  "<<": 1',
    'tag-str': 'a: !!str 12\nb: !!str\nc: !!str null',
    'tag-int': 'a: !!int "12"\nb: !!int 0x10',
    'tag-int-bad': 'a: !!int abc',
    'tag-float': 'a: !!float 1\nb: !!float "2.5"',
    'tag-bool-bad': 'a: !!bool maybe',
    'tag-null': 'a: !!null ~\nb: !!null',
    'tag-seq-and-map': 'a: !!seq [1]\nb: !!map {x: 1}',
    'tag-seq-on-map-error': 'a: !!seq {x: 1}',
    'tag-timestamp': 'a: !!timestamp 2024-01-15',
    'tag-binary': 'a: !!binary aGVsbG8gd29ybGQ=',
    'tag-binary-multiline': 'a: !!binary |\n  aGVs\n  bG8=\n',
    'tag-binary-bad': 'a: !!binary "***"',
    'tag-set': 'a: !!set {x, y}',
    'tag-set-bad': 'a: !!set {x: 1}',
    'tag-omap': 'a: !!omap\n  - x: 1\n  - y: 2',
    'tag-omap-duplicate': 'a: !!omap\n  - x: 1\n  - x: 2',
    'tag-pairs': 'a: !!pairs\n  - x: 1\n  - x: 2',
    'tag-pairs-bad': 'a: !!pairs\n  - [1]',
    'tag-unknown': 'a: !foo bar',
    'tag-verbatim': 'a: !<tag:yaml.org,2002:str> 12',
    'tag-bang-only': 'a: ! 12',
    'tag-handle-directive': '%TAG !e! tag:yaml.org,2002:\n---\na: !e!str 12',
    'tag-duplicate-error': 'a: !!str !!int 1',
    comments: '# top\na: 1 # trailing\n# between\nb: 2',
    'comment-without-space-is-text': 'a: x#y',
    'document-start-marker': '---\na: 1',
    'document-end-marker': 'a: 1\n...\n',
    'two-documents-error': 'a: 1\n---\nb: 2\n',
    'empty-document': '',
    'only-comment': '# nothing',
    'only-marker': '---\n',
    'document-end-then-content-error': 'a: 1\n...\nb: 2\n',
    'yaml-directive': '%YAML 1.2\n---\na: 1',
    'yaml-directive-bad-major': '%YAML 2.0\n---\na: 1',
    'yaml-directive-duplicate': '%YAML 1.2\n%YAML 1.2\n---\na: 1',
    'yaml-directive-without-marker': '%YAML 1.2\na: 1',
    'unknown-directive': '%FOO bar\n---\na: 1',
    'bom-start': '\uFEFFa: 1',
    'nul-error': 'a: 1\u0000',
    'control-char-error': 'a: \u0001',
    'tab-indent-error': 'a:\n\tb: 1',
    'tab-in-value': 'a: x\ty',
    'crlf-input': 'a: 1\r\nb:\r\n  - x\r\n  - y\r\n',
    'cr-only-input': 'a: 1\rb: 2\r',
    'nested-seq-in-map-in-seq': '- a:\n  - 1\n  - 2\n  b: x',
    unicode: 'a: 日本語\nb: 😀\n"ключ": значение',
    'line-separator-is-content': 'a: x\u2028y',
    'long-plain-key-value': `${'k'.repeat(50)}: ${'v'.repeat(200)}`,
    'deep-nesting':
      Array.from({ length: 30 }, (_, i) => `${'  '.repeat(i)}k${i}:`).join('\n') + ' leaf',
    'document-separator-in-plain': 'a: x\n---y',
    'colon-key-no-value': 'a:',
    'colon-only': ':',
    'question-only': '?',
    'dash-only': '-',
    'star-only-error': '*',
    'ampersand-only-error': '&',
    'bang-only': '!',
    'percent-start-plain-error': '%a',
    'at-start-error': '@a',
    'backtick-start-error': '`a',
    'multiline-implicit-key-error': '? a\n  b\n: c\nd\ne: f',
    'seq-bad-indent-error': '- a\n - b',
    'json-like': '{"a": 1, "b": [true, null, "x"], "c": {"d": 1.5}}',
    'plain-scalar-spans-lines-in-seq': '- one\n  two\n- three',
    'sparse-lines': 'a: 1\n\n\n\nb: 2\n\n',
    'trailing-spaces': 'a: 1   \nb: 2\t\n',
    'key-with-trailing-spaces': 'a   : 1',
    'quoted-key': '"a b": 1\n\'c d\': 2',
    'complex-real-note':
      'title: "Weekly: plan"\ntags:\n  - work\n  - review\ncreated: 2024-01-15T10:30:00Z\npinned: false\naliases: []\nrating: 4.5\nurl: https://x.test/a?b=c#d\nnotes: |\n  first\n  second\n'
  }
  return Object.entries(texts).map(([slug, text]) => ({
    id: `frontmatter/load/${slug}`,
    op: 'load',
    input: { text }
  }))
}

function writeCases(): OracleCase[] {
  const entries: Array<[string, unknown, string]> = [
    ['no-keys-body', {}, 'body\n\n\n'],
    ['no-keys-empty', {}, ''],
    ['keys-body', { title: 'A', tags: ['x'] }, 'body text\n'],
    ['keys-empty-body', { title: 'A' }, ''],
    ['keys-body-no-newline', { title: 'A' }, 'body'],
    ['keys-blank-body', { title: 'A' }, '\n\n'],
    ['date-value', { d: new Date('2024-01-15T00:00:00.000Z') }, 'x\n'],
    ['crlf-body-kept', { a: 1 }, 'a\r\nb\r\n'],
    ['unicode', { t: '日本語 😀' }, '日本語\n'],
    ['long-string', { d: `${longWords}${longWords}` }, 'b']
  ]
  return entries.map(([slug, value, content]) => ({
    id: `frontmatter/write/${slug}`,
    op: 'write',
    input: { value: encodeYaml(value), content }
  }))
}

export function frontmatterCases(): OracleCase[] {
  return [
    ...splitCases(),
    ...parseCases(),
    ...serializeCases(),
    ...dumpCases(),
    ...loadCases(),
    ...writeCases()
  ]
}

const kb = (n: number): string => 'x'.repeat(n)

export function markdownClassCases(): OracleCase[] {
  const entries: Array<[string, Record<string, unknown>]> = [
    ['empty', { markdown: '' }],
    ['short-note', { markdown: '# Title\n\nbody\n' }],
    ['blank-only', { markdown: ' \t\r\n\n  \n' }],
    ['crlf-blank-lines', { markdown: 'a\r\n\r\nb\r\n' }],
    ['unicode-bytes', { markdown: 'é日本😀\n\nx' }],
    ['block-just-under', { markdown: kb(100), maxBlockBytes: 100 }],
    ['block-just-over', { markdown: kb(101), maxBlockBytes: 100 }],
    ['block-with-interior-newlines', { markdown: 'aa\nbb\ncc', maxBlockBytes: 8 }],
    ['block-with-interior-newlines-over', { markdown: 'aa\nbb\ncc', maxBlockBytes: 7 }],
    ['file-just-under', { markdown: `${kb(40)}\n\n${kb(40)}`, maxFileBytes: 82 }],
    ['file-just-over', { markdown: `${kb(40)}\n\n${kb(40)}`, maxFileBytes: 81 }],
    ['file-bound-reported-first', { markdown: kb(200), maxFileBytes: 100, maxBlockBytes: 100 }],
    [
      'block-bound-only',
      { markdown: `${kb(30)}\n\n${kb(300)}`, maxFileBytes: 1000, maxBlockBytes: 100 }
    ],
    [
      'largest-block-is-first',
      { markdown: `${kb(300)}\n\n${kb(30)}`, maxFileBytes: 1000, maxBlockBytes: 100 }
    ],
    ['whitespace-line-separates', { markdown: `${kb(60)}\n \t \n${kb(60)}`, maxBlockBytes: 100 }],
    ['non-blank-line-joins', { markdown: `${kb(60)}\n.\n${kb(60)}`, maxBlockBytes: 100 }],
    ['unicode-block-bytes', { markdown: '日'.repeat(40), maxBlockBytes: 119 }],
    ['astral-block-bytes', { markdown: '😀'.repeat(20), maxBlockBytes: 79 }],
    ['default-thresholds-small', { markdown: kb(5000) }],
    ['default-block-over-128k', { markdown: kb(128 * 1024 + 1) }],
    ['default-block-at-128k', { markdown: kb(128 * 1024) }],
    ['default-file-over-1m', { markdown: `${kb(100_000)}\n\n`.repeat(11) }],
    [
      'default-file-at-1m-exactly',
      { markdown: `${kb(100_000)}\n\n`.repeat(10) + kb(1024 * 1024 - 1_000_020) }
    ]
  ]
  return entries.map(([slug, input]) => ({
    id: `markdown-class/classify/${slug}`,
    op: 'classify',
    input
  }))
}

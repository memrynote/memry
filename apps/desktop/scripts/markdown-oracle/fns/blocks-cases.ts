/**
 * Hand-written inputs of layer `blocks`: every branch and quirk of the callout,
 * quote, math, toggle, file, embed, youtube and column functions, adversarial
 * strings included. Inputs only; the TypeScript code answers them.
 */
import type { StubSpec } from './blocks-stubs'

import { type Builder, L, MINI, item, para, table } from './blocks-builder'

const def = (label: unknown, color: unknown, icon: unknown): Record<string, unknown> => ({
  label,
  color,
  icon
})

const mk = (name: string, label = name) => ({ name, label, color: '#000000', icon: 'x' })

function calloutTypeCases(b: Builder): void {
  const good = def('Danger', '#FF0000', 'flame')
  const raws: unknown[] = [
    null,
    undefined,
    [],
    'x',
    7,
    {},
    { danger: good },
    { info: good, danger: good },
    { Danger: good, danger2: good, '-x': good, a: good, a_b: good, 'a-b': good, a1: good },
    { zeta: good, alpha: good, 'a-1': good, a_1: good, a11: good, a1: good, a: good, ab: good },
    { x: null },
    { x: 'str' },
    { x: [] },
    { x: def('L', 'red', 'i') },
    { x: def('L', '#12345', 'i') },
    { x: def('L', '#1234567', 'i') },
    { x: def('L', '#abcdeF', 'i') },
    { x: def('L', '#ABCDEF', 'i') },
    { x: def('L', '#ggg000', 'i') },
    { x: def('L', 5, 'i') },
    { x: def('L', '#000000', '') },
    { x: def('L', '#000000', 5) },
    { x: def('L', '#000000', 'a'.repeat(32)) },
    { x: def('L', '#000000', 'a'.repeat(33)) },
    { x: def('L', '#000000', '😀'.repeat(16)) },
    { x: def('L', '#000000', '😀'.repeat(17)) },
    { x: def('  padded  ', '#000000', 'i') },
    { x: def('\u00a0\ufeff', '#000000', 'i') },
    { x: def('   ', '#000000', 'i') },
    { x: def('', '#000000', 'i') },
    { x: def(undefined, '#000000', 'i') },
    { x: def(5, '#000000', 'i') },
    { x: def('a'.repeat(40), '#000000', 'i') },
    { x: def('a'.repeat(41), '#000000', 'i') },
    { x: def('日本語'.repeat(14), '#000000', 'i') },
    { x: def(`${'a'.repeat(38)}😀b`, '#000000', 'i') },
    { x: def(`  ${'a'.repeat(38)}😀😀  `, '#000000', 'i') },
    { ['a'.repeat(32)]: good, ['a'.repeat(33)]: good },
    { ünï: good, '': good, ' x': good, 'x y': good, 'x\n': good },
    { __proto__x: good, constructor: good, toString: good }
  ]
  raws.forEach((raw) => b.add('calloutTypes.sanitize', raw ?? null))

  const names = [
    'info',
    'warning',
    'error',
    'success',
    'note',
    'abstract',
    'todo',
    'tip',
    'important',
    'question',
    'example',
    'quote',
    'bug',
    'danger',
    'Info',
    'NOTE',
    '',
    ' info',
    'info ',
    'custom',
    'my-type',
    'toString',
    'constructor',
    '__proto__',
    'hasOwnProperty'
  ]
  const customs = [[], ['danger'], ['danger', 'my-type', 'custom'], ['info'], ['toString']]
  for (const custom of customs) {
    for (const name of names) b.add('calloutTypes.isName', name, custom)
  }
  names.forEach((name) => b.add('calloutTypes.isBuiltIn', name))
  const syntax = [
    'a',
    'z',
    'a1',
    'a_',
    'a-',
    '_a',
    '-a',
    '1a',
    'A',
    'aB',
    'a'.repeat(32),
    'a'.repeat(33),
    '',
    'a b',
    'a\n',
    'é',
    'a😀',
    'a.b'
  ]
  syntax.forEach((name) => b.add('calloutTypes.isNameSyntax', name))
  b.add('calloutTypes.definitions', [])
  b.add('calloutTypes.definitions', [mk('a'), mk('b')])
  b.add('calloutTypes.definitions', [mk('a', 'one'), mk('b'), mk('a', 'two')])
}

function calloutSerializeCases(b: Builder): void {
  const folds: (string | null)[] = [null, 'none', 'closed', 'open', 'bogus', '']
  for (const fold of folds) {
    b.add('callout.marker', 'info', fold)
    b.add('callout.marker', 'x_y-1', fold)
  }
  const bodies = [
    '',
    '\n\n',
    'a',
    '\na\n',
    'a\n\nb',
    'a\n\n\nb',
    '\n\na\n\n',
    'a\r\nb',
    '- x\n  - y',
    '  lead',
    'trail  ',
    ' \n',
    '\n \n',
    '日本語\n😀'
  ]
  for (const body of bodies) {
    for (const fold of [null, 'closed', 'open']) b.add('callout.serialize', 'note', body, fold)
  }
}

const READ_LINES: string[] = [
  '> [!info]',
  '> [!info]\n> body',
  '> [!info]-\n> body',
  '> [!info]+\n> body\n> more',
  '> [!info]*\n> body',
  '> [!info]--\n> body',
  '> [!NOTE]\n> body',
  '> [!Info]\n> body',
  '> [!info] Title\n> body',
  '> [!info]x\n> body',
  '> [!danger]\n> body',
  '>[!info]\n> body',
  '> [!]\n> body',
  '> [!1a]\n> body',
  '> [!a-b_c9]\n> body',
  '> [!info]\n> body\n>',
  '> [!info]\n> body\n>tail',
  '> [!info]\n> body\n> ',
  '> [!info]\n>\n> second',
  '> [!info]\n> body\n>\n> second',
  '> [!info]\n> - a\n> - b',
  '> [!info]\n> a\n> - b',
  '> [!info]\n> 1. a\n> 2. b',
  '> [!info]\n> > nested',
  '> [!info]\n> body\n> > nested',
  '> [!info]\n> - a\nlazy tail',
  '> [!info]\n> - a\nlazy tail\n\nafter',
  '> [!info]\n> - a\n# heading',
  '> [!info]\n> - a\n- b',
  '> [!info]\n> ```\n> - x\n> ```',
  '> [!info]\n> ```\n> - x\n> ```\nlazy',
  '> [!info]\n> - [a\nb](u)',
  '> [!info]\r\n> body',
  '> [!info]\n> body\r',
  '> [!info]\n> a\u2028b',
  '> [!info]\n> a\r\n> b',
  '> [!info]\n> 😀 日本語',
  '> [!info]\n\n> after blank',
  '> [!info]\n> one\nplain',
  '> [!info]\n>  two spaces',
  '> [!info]\n>\tTab',
  '[!info]',
  '[!info]\nbody',
  '[!info]\nbody\nmore',
  '[!info]\nbody\n\nafter',
  '[!warning]\nbody',
  '[!error]\nbody',
  '[!success]\nbody',
  '[!note]\nbody',
  '[!INFO]\nbody',
  '[!info]-\nbody',
  '[!info] \nbody',
  '[!info]\n\nbody',
  '[!info]\n\u00a0\nbody',
  '[!info]\n \t \nbody',
  '[!info]\n> quoted body',
  '[!info]\r\nbody',
  '[!info]\n- list\n- items',
  'plain',
  '',
  '> quote',
  '> [!info]\n> a\n> b\n> c\n\n> [!warning]\n> d'
]

function calloutReadCases(b: Builder): void {
  for (const text of READ_LINES) {
    const lines = L(text)
    for (const custom of [[], ['danger']]) b.add('callout.read', lines, 0, true, custom)
    b.add('callout.read', lines, 0, false, [])
  }
  b.add('callout.read', L('x\n> [!info]\n> body'), 1, true, [])
  b.add('callout.read', L('x\n> [!info]\n> body'), 1, false, [])
  b.add('callout.read', L('x\n[!info]\nbody'), 1, true, [])
  b.add('callout.read', L('> [!info]\n> body\n> [!warning]\n> b2'), 2, true, [])
  b.add('callout.read', L('> [!info]\n> body'), 0, true, ['info', 'info'])
}

const run = (
  type: string,
  contentLines: string[],
  extra: Record<string, unknown> = {}
): Record<string, unknown> => ({
  type,
  fold: 'none',
  contentLines,
  raw: '',
  end: contentLines.length + 1,
  bare: false,
  reshapes: false,
  ...extra
})

function calloutResolveCases(b: Builder): void {
  // Runs given directly.
  const direct: [Record<string, unknown>, StubSpec][] = [
    [run('info', []), MINI],
    [run('info', ['']), MINI],
    [run('info', ['body']), MINI],
    [run('info', ['body', 'more']), MINI],
    [run('info', ['a', '', 'b']), MINI],
    [run('info', ['- a', '- b'], { reshapes: true }), MINI],
    [run('info', ['* a', '* b'], { reshapes: true }), MINI],
    [run('info', ['* a', '* b'], { reshapes: false }), MINI],
    [run('info', ['- a', '  - b'], { reshapes: true }), MINI],
    [run('info', ['1. a'], { reshapes: true, fold: 'open' }), MINI],
    [run('info', ['a', '- b'], { reshapes: true, fold: 'closed' }), MINI],
    [run('info', ['> inner'], { reshapes: true }), MINI],
    [run('info', ['# heading']), MINI],
    [run('info', ['body'], { bare: true }), MINI],
    [run('info', ['a', '', 'b'], { bare: true }), MINI],
    [run('info', ['- a'], { bare: true, reshapes: true }), MINI],
    [run('info', ['x'], { fold: 'open' }), { kind: 'parse-error' }],
    [run('info', ['x'], { fold: 'open' }), { kind: 'serialize-error' }],
    [run('info', []), { kind: 'parse-error' }]
  ]
  for (const [r, stub] of direct) b.add('callout.resolve', r, [], stub)

  const tables: [string[], Record<string, unknown>, StubSpec][] = [
    [['x'], {}, table({ x: [] })],
    [['x'], {}, table({ x: [para('x', [para('child')])] })],
    [['x'], {}, table({ x: [para('x', [item('bulletListItem', 'c')])] })],
    [['x'], {}, table({ x: [item('bulletListItem', 'x', [para('p')])] })],
    [
      ['x'],
      {},
      table({ x: [item('bulletListItem', 'x', [item('bulletListItem', 'y', [para('z')])])] })
    ],
    [['x'], {}, table({ x: [item('bulletListItem', 'x', [item('numberedListItem', 'y')])] })],
    [['x'], {}, table({ x: [para('x'), para('y')] })],
    [
      ['x'],
      {},
      table({ x: [para('x'), item('bulletListItem', 'y')] }, [
        [[para('x'), item('bulletListItem', 'y')], 'x\n\n- y']
      ])
    ],
    [['x'], {}, table({ x: [{ type: 'heading', props: {}, content: [], children: [] }] })],
    [['x'], {}, table({ x: [{ type: 'paragraph', props: {} }] })],
    [
      ['x'],
      {},
      table({ x: [{ type: 'paragraph', props: {}, content: null, children: [] }, para('b')] })
    ],
    [['x'], { bare: true }, table({ x: [para('x'), para('y')] })],
    [['x'], { bare: true }, table({ x: [para('x')] })],
    [['x'], { bare: true }, table({ x: [item('bulletListItem', 'x')] })],
    [['x'], { reshapes: true }, table({ x: [para('x')] }, [[[para('x')], 'changed']])],
    [
      ['x'],
      { reshapes: true, fold: 'closed' },
      table({ x: [para('x')], changed: [para('x')] }, [[[para('x')], 'changed']])
    ],
    [
      ['x'],
      { reshapes: true, fold: 'open' },
      table({ x: [para('x')], changed: [para('x')] }, [[[para('x')], 'changed']])
    ],
    [
      ['x'],
      { reshapes: true },
      table({ x: [para('x')], 'q\n\nr': [para('x')] }, [[[para('x')], 'q\n\nr']])
    ],
    [
      ['x'],
      { reshapes: true },
      table({ x: [para('x')], y: [para('y')] }, [
        [[para('x')], 'y'],
        [[para('y')], 'z']
      ])
    ],
    [
      ['x'],
      { reshapes: true, type: 'unknown-type' },
      table({ x: [para('x')] }, [[[para('x')], 'y']])
    ],
    [
      ['x', 'y'],
      { reshapes: true, type: 'danger' },
      table({ 'x\ny': [para('x'), para('y')], y: [para('y')] }, [[[para('x'), para('y')], 'y']])
    ]
  ]
  for (const [lines, extra, stub] of tables) {
    b.add(
      'callout.resolve',
      run(typeof extra.type === 'string' ? extra.type : 'info', lines, extra),
      ['danger'],
      stub
    )
    b.add(
      'callout.resolve',
      run(typeof extra.type === 'string' ? extra.type : 'info', lines, extra),
      [],
      stub
    )
  }

  // Read then resolve, through the mini stub.
  const wholes = [
    '> [!info]\n> body',
    '> [!info]\n> body\n> more',
    '> [!info]-\n> - a\n> - b',
    '> [!info]+\n> * a\n> * b',
    '> [!info]\n> a\n>\n> b',
    '> [!info]\n> a\n>\n> - b',
    '> [!info]\n> a\n> - b',
    '> [!info]\n> > nested',
    '> [!info]\n> a\n> > nested',
    '> [!info]\n> - a\nlazy',
    '> [!danger]\n> body',
    '> [!info]\n> # h',
    '> [!info]\n> - a\n>   - b',
    '> [!info]\n> 1. a\n> 2. b',
    '> [!info]\n> - [ ] task',
    '> [!info]\n> - [x] done',
    '[!info]\nbare body',
    '[!info]\nbare\n\nrest',
    '[!info]\n- list',
    '> [!info]',
    '> [!info]\n> ```\n> code\n> ```',
    '> [!info]\n> 😀 日本語'
  ]
  for (const text of wholes) {
    b.add('callout.readAndResolve', L(text), 0, true, ['danger'], MINI)
    b.add('callout.readAndResolve', L(text), 0, true, [], MINI)
  }
  b.add('callout.readAndResolve', L('> [!info]\n> body'), 0, true, [], { kind: 'parse-error' })
  b.add('callout.readAndResolve', L('> [!info]\n> body'), 0, true, [], { kind: 'serialize-error' })
  b.add('callout.readAndResolve', L('> [!info]\n> body'), 0, false, [], MINI)
}

const runOf = (
  innerMarkdown: string,
  raw: string,
  extra: Record<string, unknown> = {}
): Record<string, unknown> => ({
  innerMarkdown,
  raw,
  end: 1,
  nested: false,
  listed: false,
  ...extra
})

const QUOTE_TEXTS: string[] = [
  '> a',
  '> a\n> b',
  '> a\n>\n> b',
  '>\n> a',
  '> a\n>',
  '>',
  '>\n>',
  '> a\n>b',
  '>a',
  '> a\n> > b',
  '> > b',
  '> > > c',
  '> a\n> - b',
  '> - a',
  '> * a',
  '> + a',
  '> 1. a',
  '> 1) a',
  '> 2. a',
  '> 2) a',
  '> 10. a',
  '> 123456789. a',
  '> 1234567890. a',
  '>  - a',
  '>   - a',
  '>     - a',
  '> -',
  '> - ',
  '> -\ta',
  '> -\u00a0a',
  '> - \u00a0',
  '> a\n>\n> - b',
  '> a\n> 1. b',
  '> a\n> 2. b',
  '> text\n>\n> 2. b',
  '> - a\nlazy',
  '> - a\nlazy\nlazier',
  '> - a\n\nnot lazy',
  '> - a\n- b',
  '> - a\n1. b',
  '> - a\n# h',
  '> - a\n####### h',
  '> - a\n#',
  '> - a\n#hash',
  '> - a\n> b',
  '> - a\n```',
  '> - a\n~~~',
  '> - a\n<div>',
  '> - a\n| table',
  '> - a\n---',
  '> - a\n***',
  '> - a\n___',
  '> - a\n===',
  '> - a\n- - -',
  '> - a\n* * *',
  '> - a\n_ _ _',
  '> - a\n--',
  '> - a\n-=-',
  '> - a\n   ---   ',
  '> - a\n    ---',
  '> - a\n    code',
  '> - a\n   lazy',
  '> - a\n\t',
  '> - a\n ',
  '> - a\n\u00a0',
  '> - a\n1234567890. not an item',
  '> - a\n0. zero',
  '> ```\n> - x\n> ```',
  '> ```\n> - x\n> ```\nlazy',
  '> ```\n> a\n>\n> b\n> ```',
  '> ~~~\n> - x\n> ~~~',
  '> ````\n> - x\n> ```\n> - y\n> ````',
  '> - a\n> ```\n> code\n> ```\nlazy',
  '> a\n>\n> ```\n> - x\n> ```',
  '> - [a\nb](u)',
  '> a\r\n>\r\n> b',
  '>\r\n> a',
  '> a\u2028b\n>\n> c',
  '> 😀\n>\n> 日本語',
  '> - 😀\nlazy 日本語',
  'x\n> a\n>\n> b',
  '> a\n>\n> b\n\n> c\n>\n> d',
  '> a\n>\n> b\ntext',
  '> a\n>\n> b\n\ntext',
  '',
  'plain',
  '> - a\n> - b\n>   - c',
  '> - a\n>   - b\n>     - c',
  '> # h\n>\n> - x',
  '> ---\n>\n> a',
  '> * * *\n> - x'
]

function quoteCases(b: Builder): void {
  const inners = ['', 'a', 'a\n', '\n', '\na', 'a\n\nb', '\n\n', 'x\r\ny', '日本語\n😀']
  inners.forEach((inner) => b.add('quote.serialize', inner))
  for (const text of QUOTE_TEXTS) {
    const lines = L(text)
    b.add('quote.read', lines, 0)
    b.add('quote.readAndResolve', lines, 0, MINI)
  }
  b.add('quote.read', L('x\n> a\n>\n> b'), 1)
  b.add('quote.read', L('x\n> a\n>\n> b'), 0)
  b.add('quote.read', L('> a\n>\n> b'), 5)
  b.add('quote.read', L('> a\n>\n> b'), 1)
  b.add('quote.readAndResolve', L('> a\n>\n> b'), 0, { kind: 'parse-error' })
  b.add('quote.readAndResolve', L('> a\n>\n> b'), 0, { kind: 'serialize-error' })

  const cases: [Record<string, unknown>, StubSpec][] = [
    [runOf('a\n\nb', '> a\n>\n> b'), MINI],
    [runOf('a\n\nb', '> a\n> b'), MINI],
    [runOf('a\n\nb', '> a\n> b', { nested: true }), MINI],
    [runOf('a\n\nb', '> a\n> b', { listed: true }), MINI],
    [runOf('- a', '> - a', { listed: true }), MINI],
    [runOf('* a', '> * a', { listed: true }), MINI],
    [runOf('* a', '> * a', { listed: false }), MINI],
    [runOf('> b', '> > b', { nested: true }), MINI],
    [runOf('a\n\n> b', '> a\n> > b', { nested: true }), MINI],
    [runOf('a\n\n- b', '> a\n> - b', { listed: true }), MINI],
    [runOf('', ''), MINI],
    [runOf('# h\n\nx', '> # h\n>\n> x'), MINI],
    [runOf('x', '> x'), table({ x: [para('x', [para('c')])] })],
    [
      runOf('x', '> x'),
      table({ x: [{ type: 'quote', props: {}, content: [], children: [] }] }, [
        [[{ type: 'quote', props: {}, content: [], children: [] }], '> x']
      ])
    ],
    [
      runOf('x', '> x'),
      table({ x: [{ type: 'quote', props: {}, content: [], children: [para('c')] }] })
    ],
    [runOf('x', '> x', { listed: true }), table({ x: [item('bulletListItem', 'x', [para('p')])] })],
    [
      runOf('x', '> x', { listed: false }),
      table({ x: [item('bulletListItem', 'x', [para('p')])] })
    ],
    [
      runOf('x', '> x', { listed: true }),
      table({ x: [item('bulletListItem', 'x')] }, [[[item('bulletListItem', 'x')], 'x']])
    ],
    [
      runOf('x', '> x'),
      table({ x: [item('checkListItem', 'x')] }, [[[item('checkListItem', 'x')], 'x']])
    ],
    [runOf('x', '> x'), table({ x: [para('x')] })],
    [
      runOf('x', '> x'),
      table({ x: [{ type: 'heading', props: {}, content: [], children: [] }, para('x')] })
    ]
  ]
  for (const [r, stub] of cases) b.add('quote.resolve', r, stub)

  const blocks: unknown[] = [
    para('x'),
    item('bulletListItem', 'a'),
    item('bulletListItem', 'a', [item('numberedListItem', 'b', [item('checkListItem', 'c')])]),
    item('bulletListItem', 'a', [para('p')]),
    item('bulletListItem', 'a', [item('bulletListItem', 'b', [para('p')])]),
    item('numberedListItem', 'a', [para('p')]),
    item('checkListItem', 'a', [para('p')]),
    para('x', [para('p')]),
    { type: 'bulletListItem' },
    { type: 'bulletListItem', children: [] },
    { type: 'bulletListItem', children: [{}] },
    {},
    { type: 'quote', children: [para('p')] }
  ]
  blocks.forEach((block) => b.add('quote.itemHoldsNonList', block))
}

function mathCases(b: Builder): void {
  const latexes = [
    '',
    'x',
    'x\n',
    '\nx',
    'a\n\nb',
    'a  \nb\t',
    '  a',
    'a\u00a0\nb',
    'a\ufeff',
    'a\r\nb',
    'a\rb',
    '\n\n\n',
    'x^2 + y^2',
    '日本語\n😀',
    '\u2028',
    'a\u2028\nb',
    ' \n \n'
  ]
  latexes.forEach((latex) => b.add('math.serialize', latex))
  const texts = [
    '$$\nx\n$$',
    '$$\nx\ny\n$$',
    '$$\n$$',
    '$$\n\n$$',
    '$$\nx\n\ny\n$$',
    '$$\nx  \n$$',
    '$$\n  x\n$$',
    '$$\nx\n$$\n',
    '$$\nx\n$$\ntext',
    '$$\nx\n$$\n\ntext',
    '$$\nx\n$$\n  \ntext',
    '$$\nx\n$$\n\u00a0\ntext',
    '$$\nx',
    '$$',
    '$$ x $$',
    ' $$\nx\n$$',
    '$$ \nx\n$$',
    '$$\nx\n $$',
    '$$\nx\r\n$$',
    '$$\r\nx\r\n$$\r\n',
    '$$\nx\n$$\n$$\ny\n$$',
    '$$\nx\n$$$',
    '$$$\nx\n$$',
    '$$\n\\begin{aligned}\na &= b\n\\end{aligned}\n$$',
    '$$\n日本語 😀\n$$',
    'text\n$$\nx\n$$',
    '$$\nx\n$$\n$$',
    '',
    '$'
  ]
  for (const text of texts) {
    const lines = L(text)
    b.add('math.read', lines, 0, true)
    b.add('math.read', lines, 0, false)
  }
  b.add('math.read', L('a\n\n$$\nx\n$$\n\nb'), 2, true)
  b.add('math.read', L('a\n\n$$\nx\n$$\n\nb'), 9, true)
  b.add('math.read', L('$$\nx\n$$'), 1, true)
}

export function calloutQuoteMathCases(b: Builder): void {
  calloutTypeCases(b)
  calloutSerializeCases(b)
  calloutReadCases(b)
  calloutResolveCases(b)
  quoteCases(b)
  mathCases(b)
}

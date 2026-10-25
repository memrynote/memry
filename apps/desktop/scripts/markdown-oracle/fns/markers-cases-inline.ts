/**
 * Cases of inline-colors and plain-checkbox: inline-content walks over block
 * JSON, and the span-tag masking of markdown text.
 */
import { cell, table } from './markers-cases-colors'
import { CaseList } from './markers-support'

const run = (text: string, styles: Record<string, unknown> = {}): object => ({
  type: 'text',
  text,
  styles
})
const block = (type: string, content: unknown, children: object[] = []): object => ({
  type,
  props: {},
  content,
  children
})
const wiki = (props: Record<string, unknown>): object => ({
  type: 'wikiLink',
  props: { target: 'A', alias: '', ...props }
})

const SPAN_SOURCES = [
  'plain text',
  '',
  '<span style="color:red">x</span>',
  'a <span style="color:red">b</span> c',
  '<span style="color:red;background-color:blue">x</span>',
  '<span style="background-color:blue;color:red">x</span>',
  '<span style="text-decoration:underline">x</span>',
  '<span style="text-decoration:Underline">x</span>',
  '<span style="text-decoration:UNDERLINE">x</span>',
  '<span style="text-decoration:none">x</span>',
  '<span style="color:red"><span style="text-decoration:underline">x</span></span>',
  '<span style="color:red;text-decoration:underline">x</span>',
  '<span style="color:red;;">x</span>',
  '<span style=" color : red ">x</span>',
  '<span style="color:">x</span>',
  '<span style="color:red;font-size:9px">x</span>',
  '<span style="color">x</span>',
  '<span style="">x</span>',
  '<span style=";">x</span>',
  '<span style="color:red;color:blue">x</span>',
  '<span style="color:a\'b">x</span>',
  '<span style="color:a<b">x</span>',
  '<span style="color:red">x</span> and <span style="color:blue">y</span>',
  '`<span style="color:red">` x</span>',
  '`<span style="color:red">x</span>` <span style="color:blue">y</span>',
  '``a `<span style="color:red">` b`` <span style="color:green">c</span>',
  '```\n<span style="color:red">x</span>\n```\n<span style="color:blue">y</span>',
  '~~~\n<span style="color:red">x</span>\n```\n<span style="color:blue">y</span>\n~~~\n<span style="color:green">z</span>',
  '```\n<span style="color:red">x</span>\n',
  '    <span style="color:red">x</span>',
  '  ```\n<span style="color:red">x</span>\n  ```',
  '<span style="color:red">x',
  'x</span>',
  '</span><span style="color:red">x</span></span>',
  '<span style="color:red"x</span>',
  '<span style="color:red">\n</span>',
  '<span style="color:\nred">x</span>',
  '<span\nstyle="color:red">x</span>',
  '<span style="color:red" >x</span>',
  '<SPAN style="color:red">x</span>',
  '<span class="a" style="color:red">x</span>',
  '<span style="color:red">x</span>\r\n<span style="color:blue">y</span>\r\n',
  '<span style="color:red">x</span>\r<span style="color:blue">y</span>',
  '<span style="color:red">😀 日本語</span>\u2028<span style="color:blue">y</span>',
  '<span style="color:\ufefffoo">x</span>',
  '<span style="color:\u00a0red\u00a0">x</span>',
  '<span style="color:red">MEMRYICO0:x:MEMRYICC;</span>',
  'MEMRYICO0:x:MEMRYICC; <span style="color:red">y</span>',
  '<span style="</span>">x</span><span style="color:red">y</span>',
  '<span style="<span style="color:red">x</span>',
  '<span style="color:red">`</span>',
  '`` <span style="color:red"> `` </span>',
  '```<span style="color:red">x</span>```',
  '````\n<span style="color:red">x</span>\n```\n````',
  '`a` `b` <span style="color:red">x</span>',
  '` ` ` `<span style="color:red">x</span>`',
  '``` `<span style="color:red">x</span>',
  '*<span style="color:red">em</span>* **<span style="background-color:#ff0">b</span>**',
  '| a |\n|---|\n| <span style="color:red">x</span> |'
]

function maskCases(c: CaseList): void {
  c.each('inlineColors.maskInlineColorSpans', SPAN_SOURCES)
  c.each('inlineColors.stripInlineStyleSpanTags', SPAN_SOURCES)
  c.each('inlineColors.stripInlineStyleSpanTags', [
    '<span style="a">b</span>',
    '<span style="a"',
    '<span style="a\n">x</span>',
    '</span></span>',
    '<span style="</span>">',
    '<span style="a"><span style="b">x</span></span>'
  ])
}

const SPAN_A = { styles: { textColor: 'red' }, source: '<span style="color:red">' }
const SPAN_B = {
  styles: { backgroundColor: 'blue', textColor: 'green', underline: true },
  source: '<span style="background-color:blue;color:green;text-decoration:underline">'
}
const SPAN_U = { styles: { underline: true }, source: '<span style="text-decoration:underline">' }

function applyCases(c: CaseList): void {
  const spans = [SPAN_A, SPAN_B, SPAN_U]
  const texts = [
    'MEMRYICO0:red:MEMRYICC;',
    'a MEMRYICO0:red:MEMRYICC; b',
    'MEMRYICO0:MEMRYICO2:both:MEMRYICC;:MEMRYICC;',
    'MEMRYICO1:x:MEMRYICC;y',
    'MEMRYICO3:unknown:MEMRYICC;',
    'MEMRYICO99999999999999999999:huge:MEMRYICC;',
    'MEMRYICO007:padded:MEMRYICC;',
    ':MEMRYICC; stray close',
    'MEMRYICO0: never closed',
    'MEMRYICO0:a:MEMRYICC;MEMRYICO1:b:MEMRYICC;',
    'MEMRYICO:x:MEMRYICC;',
    'MEMRYICO0x:x',
    'MEMRYICOMEMRYICO0:x:MEMRYICC;',
    ':MEMRYICC;MEMRYICC;',
    'MEMRYICO0:',
    'MEMRYICO0:\u00e9😀 日本:MEMRYICC;',
    'no tokens at all',
    '',
    'MEMRYICO0::MEMRYICC;'
  ]
  for (const text of texts) {
    c.add('inlineColors.applyInlineColorTokens', [
      [block('paragraph', [run(text, { bold: true })])],
      spans
    ])
    c.add('inlineColors.applyInlineColorTokens', [[block('paragraph', [run(text)])], spans])
    c.add('inlineColors.applyInlineColorTokens', [[block('codeBlock', [run(text)])], spans])
    c.add('inlineColors.applyInlineColorTokens', [
      [block('paragraph', [{ type: 'text', text }])],
      []
    ])
  }
  const multi = [
    run('a MEMRYICO0:', { bold: true }),
    run('b', { italic: true }),
    run(':MEMRYICC; c', { code: true })
  ]
  const blocks: object[][] = [
    [block('paragraph', multi)],
    [block('paragraph', [{ type: 'link', href: 'u', content: [run('MEMRYICO0:in:MEMRYICC;')] }])],
    [
      block('paragraph', [
        { type: 'link', href: 'u', content: [run('MEMRYICO0:x')] },
        run('y:MEMRYICC;')
      ])
    ],
    [block('paragraph', [wiki({ target: 'T' }), run('MEMRYICO0:z:MEMRYICC;')])],
    [
      block(
        'bulletListItem',
        [run('MEMRYICO1:a:MEMRYICC;')],
        [block('paragraph', [run('MEMRYICO0:c:MEMRYICC;')])]
      )
    ],
    [
      block(
        'codeBlock',
        [run('MEMRYICO0:x:MEMRYICC;')],
        [block('paragraph', [run('MEMRYICO0:y:MEMRYICC;')])]
      )
    ],
    [block('codeBlock', [run('MEMRYICO0:x:MEMRYICC; MEMRYICO9:'), { type: 'x' }])],
    [block('codeBlock', 'string content')],
    [block('table', table([[cell('MEMRYICO0:a:MEMRYICC;'), cell('b')]]))],
    [
      block('table', {
        type: 'tableContent',
        rows: [{ cells: [[run('MEMRYICO0:legacy:MEMRYICC;')], [run('plain')]] }]
      })
    ],
    [block('table', { type: 'tableContent', rows: [{ cells: [5, { type: 'tableCell' }, null] }] })],
    [block('paragraph', [{ type: 'text', styles: { bold: true } }, { type: 'mention' }])],
    [
      block('paragraph', [
        run('x', { textColor: 'old' }),
        run('MEMRYICO0:y:MEMRYICC;', { textColor: 'old' })
      ])
    ],
    [block('paragraph', [{ type: 'text', text: 'MEMRYICO0:y:MEMRYICC;' }])],
    [block('paragraph', null)],
    [block('image', undefined)],
    [
      block('paragraph', [run('MEMRYICO0:a'), run('b'), run('c:MEMRYICC;')]),
      block('paragraph', [run('after')])
    ],
    [block('paragraph', [run('MEMRYICO0:'), run(''), run(':MEMRYICC;')])],
    [block('paragraph', [run('MEMRYICO0:a:MEMRYICC;', { '2': 'x', bold: true })])]
  ]
  for (const b of blocks) {
    c.add('inlineColors.applyInlineColorTokens', [b, spans])
    c.add('inlineColors.applyInlineColorTokens', [b, []])
  }
}

function extractCases(c: CaseList): void {
  const colored = (text: string, extra: Record<string, unknown> = {}): object =>
    run(text, { textColor: 'red', ...extra })
  const blocks: object[][] = [
    [block('paragraph', [run('plain')])],
    [block('paragraph', [colored('red')])],
    [block('paragraph', [run('a'), colored('red'), run('b')])],
    [block('paragraph', [colored('one'), colored('two'), run('x')])],
    [
      block('paragraph', [
        colored('one'),
        colored('two', { bold: true }),
        colored('three', { textColor: 'blue' })
      ])
    ],
    [block('paragraph', [run('u', { underline: true })])],
    [block('paragraph', [run('u', { underline: true }), run('v', { underline: true }), run('w')])],
    [
      block('paragraph', [
        colored('cu', { underline: true }),
        colored('c'),
        run('u', { underline: true })
      ])
    ],
    [
      block('paragraph', [
        colored('x', { backgroundColor: 'blue' }),
        run('y', { backgroundColor: 'blue' })
      ])
    ],
    [
      block('paragraph', [
        run('x', { backgroundColor: 'blue', textColor: 'red', underline: true, bold: true })
      ])
    ],
    [block('paragraph', [run('x', { textColor: 'default', backgroundColor: 'default' })])],
    [block('paragraph', [run('x', { textColor: 'default', underline: true })])],
    [block('paragraph', [run('x', { textColor: '', backgroundColor: 'blue' })])],
    [block('paragraph', [run('x', { textColor: '' })])],
    [
      block('paragraph', [
        run('x', { textColor: 'a;b' }),
        run('y', { textColor: 'a"b' }),
        run('z', { textColor: "a'b" })
      ])
    ],
    [block('paragraph', [run('x', { textColor: 'a<b', underline: true })])],
    [block('paragraph', [run('x', { textColor: 'red', backgroundColor: 'a>b' })])],
    [block('paragraph', [run('x', { textColor: 5, underline: 'yes' })])],
    [block('paragraph', [run('', { textColor: 'red' })])],
    [
      block('paragraph', [
        { type: 'text', text: 'x' },
        { type: 'text', text: 'y', styles: null }
      ])
    ],
    [block('paragraph', [{ type: 'text', text: 'x', styles: 'str' }])],
    [
      block('paragraph', [
        colored('x'),
        { type: 'link', href: 'u', content: [colored('in'), run('out')] },
        colored('y')
      ])
    ],
    [block('paragraph', [{ type: 'link', href: 'u', content: [run('x')] }])],
    [block('paragraph', [wiki({ textColor: 'red' })])],
    [block('paragraph', [wiki({ underline: true })])],
    [
      block('paragraph', [
        wiki({ textColor: 'red', underline: true, backgroundColor: 'blue' }),
        colored('t')
      ])
    ],
    [block('paragraph', [wiki({ textColor: 'default' })])],
    [block('paragraph', [wiki({ textColor: 'a;b', underline: true })])],
    [
      block('paragraph', [
        { type: 'mention', props: { textColor: 'red' } },
        { type: 'wikiLink', props: null }
      ])
    ],
    [block('paragraph', [{ type: 'text', text: 'x', props: { textColor: 'red' } }])],
    [block('codeBlock', [colored('code')], [block('paragraph', [colored('child')])])],
    [
      block(
        'bulletListItem',
        [colored('a')],
        [
          block(
            'bulletListItem',
            [colored('b')],
            [block('paragraph', [run('c', { underline: true })])]
          )
        ]
      )
    ],
    [block('table', table([[cell('plain'), { ...cell('x'), content: [colored('x')] }]]))],
    [
      block('table', {
        type: 'tableContent',
        rows: [{ cells: [[colored('legacy')], [run('p')]] }, { cells: [[run('q')]] }]
      })
    ],
    [block('table', { type: 'tableContent', rows: [{ cells: [5, { type: 'tableCell' }] }] })],
    [block('table', { type: 'tableContent', rows: [] })],
    [block('paragraph', 'string content'), block('paragraph', undefined), block('paragraph', null)],
    [block('paragraph', [colored('x')]), block('paragraph', [colored('y')])],
    [block('quote', [colored('x')], [])],
    [{ type: 'paragraph', content: [colored('no props')] }],
    []
  ]
  for (const b of blocks) c.add('inlineColors.extractInlineColorRuns', [b])

  const markdowns = [
    'a MEMRYICO0:b:MEMRYICC; c',
    'MEMRYICO0:MEMRYICO1:x:MEMRYICC;:MEMRYICC;',
    'no tokens',
    '',
    'MEMRYICO0:',
    ':MEMRYICC;',
    'MEMRYICO10:y'
  ]
  const pairSets: [string, string][][] = [
    [],
    [
      ['MEMRYICO0:', '<span style="color:red">'],
      [':MEMRYICC;', '</span>']
    ],
    [
      ['MEMRYICO0:', '<span style="color:red">'],
      ['MEMRYICO1:', '<span style="a">'],
      [':MEMRYICC;', '</span>']
    ],
    [
      ['MEMRYICO1:', 'MEMRYICO0:'],
      ['MEMRYICO0:', 'x']
    ],
    [
      ['MEMRYICO1:', '$&$1'],
      [':MEMRYICC;', '$$']
    ],
    [['', '-']],
    [
      ['x', 'x'],
      ['x', 'y']
    ],
    [['MEMRYICO1:', 'é😀']]
  ]
  for (const md of markdowns)
    for (const pairs of pairSets) c.add('inlineColors.restoreInlineColorTokens', [md, pairs])
  c.add('inlineColors.restoreInlineColorTokens', ['abc', [['', '-']]])
}

const checkItem = (
  content: unknown,
  props: Record<string, unknown> = {},
  children: object[] = []
): object => ({
  type: 'checkListItem',
  props: { checked: false, ...props },
  content,
  children
})

const plainItem = (
  content: unknown,
  children: object[] = [],
  extra: Record<string, unknown> = {}
): object => ({
  type: 'checkListItem',
  props: { checked: false, plain: true, ...extra },
  content,
  children
})

function plainCases(c: CaseList): void {
  c.each('plainCheckbox.hasPlainCheckboxMarker', [
    '',
    'Passport {check}',
    'Passport {check}  ',
    'Passport {check}\n',
    'Passport {check}\u00a0',
    '{check}',
    '{ check }',
    'x {check} y',
    '{check}{check}',
    'Passport {CHECK}',
    '{check}\ufeff',
    '{check}\u2028',
    '日本語{check}',
    '😀 {check}'
  ])
  const blocks: object[][] = [
    [checkItem([run('Passport {check}')])],
    [checkItem([run('Passport'), run(' {check}')])],
    [checkItem([run('Passport'), run('{check}')])],
    [checkItem([run('{check}')])],
    [checkItem([run('  {check}  ')])],
    [checkItem([run('Passport '), run('{check}', { bold: true })])],
    [checkItem([run('Pass{check}port')])],
    [checkItem([run('a'), { type: 'link', href: 'u', content: [run('{check}')] }])],
    [checkItem([run('Passport {check}'), { type: 'link', href: 'u', content: [] }])],
    [checkItem([{ type: 'text', text: 'x {check}' }])],
    [checkItem([{ type: 'text', text: 5 }])],
    [checkItem([{ text: 'x {check}' }])],
    [checkItem([])],
    [checkItem('x {check}')],
    [checkItem(null)],
    [checkItem(undefined)],
    [checkItem([run('x {check}')], { plain: false })],
    [checkItem([run('x {check}')], { checked: true, plain: true })],
    [checkItem([run('x {check}\u2028')])],
    [checkItem([run('x\n{check}')])],
    [
      checkItem([run('x {check} ')], {}, [
        checkItem([run('child {check}')]),
        { type: 'paragraph', props: {}, content: [run('p {check}')], children: [] }
      ])
    ],
    [
      {
        type: 'bulletListItem',
        props: {},
        content: [run('x {check}')],
        children: [checkItem([run('deep {check}')])]
      }
    ],
    [{ type: 'checkListItem', content: [run('no props {check}')] }],
    [{ type: 'checkListItem', props: null, content: [run('null props {check}')] }],
    [checkItem([run('a {check}')]), checkItem([run('b')]), checkItem([run('c {check}')])],
    [{ type: 'paragraph', props: {}, content: [run('x {check}')], children: [] }],
    []
  ]
  for (const b of blocks) c.add('plainCheckbox.normalizePlainCheckboxes', [b])
  const serializeBlocks: object[][] = [
    [plainItem([run('Passport')])],
    [plainItem([])],
    [plainItem(undefined)],
    [plainItem(null)],
    [plainItem('str')],
    [plainItem([run('a'), run('b', { bold: true })])],
    [checkItem([run('not plain')])],
    [checkItem([run('x')], { plain: 'true' })],
    [checkItem([run('x')], { plain: false })],
    [
      plainItem(
        [run('p')],
        [
          plainItem([run('c')]),
          checkItem([run('d')]),
          { type: 'paragraph', props: {}, content: [], children: [plainItem([run('e')])] }
        ]
      )
    ],
    [{ type: 'checkListItem', props: undefined, content: [] }],
    [{ type: 'paragraph', props: { plain: true }, content: [run('x')] }],
    [plainItem([run('x')], undefined, {}), plainItem([run('y')])],
    []
  ]
  for (const b of serializeBlocks) c.add('plainCheckbox.withPlainCheckboxMarkers', [b])
}

export function inlineCases(): CaseList[] {
  const colors = new CaseList('inline-colors')
  maskCases(colors)
  applyCases(colors)
  extractCases(colors)
  const plain = new CaseList('plain-checkbox')
  plainCases(plain)
  return [colors, plain]
}

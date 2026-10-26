/**
 * Cases of block-colors, block-markers and link-card-marker: the sidecar
 * `<!-- … -->` lines and the table content they read and write.
 */
import { CaseList } from './markers-support'

const run = (text: string, styles: Record<string, unknown> = {}): object => ({
  type: 'text',
  text,
  styles
})

export const cell = (text: string, props: Record<string, unknown> = {}): object => ({
  type: 'tableCell',
  content: [run(text)],
  props: {
    colspan: 1,
    rowspan: 1,
    backgroundColor: 'default',
    textColor: 'default',
    textAlignment: 'left',
    ...props
  }
})

export const table = (rows: object[][], extra: Record<string, unknown> = {}): object => ({
  type: 'tableContent',
  columnWidths: rows[0] ? rows[0].map(() => null) : [],
  headerRows: 1,
  rows: rows.map((cells) => ({ cells })),
  ...extra
})

const TABLE_COLORED = table([
  [cell('a', { textColor: 'red' }), cell('b')],
  [cell('c'), cell('d', { backgroundColor: 'blue', textColor: 'green' })]
])
const TABLE_ALIGNED = table([
  [cell('a', { textAlignment: 'center' }), cell('b', { textAlignment: 'right' })],
  [cell('c', { textAlignment: 'justify' }), cell('d', { textAlignment: 'left' })]
])
const TABLE_PLAIN = table([[cell('a'), cell('b')]])
const TABLE_LEGACY = { type: 'tableContent', rows: [{ cells: [[run('a')], [run('b')]] }] }
const TABLE_ODD = {
  type: 'tableContent',
  rows: [
    null,
    {},
    { cells: 'x' },
    { cells: [null, 5, 'z', [], { props: [] }, { props: 'p' }, { props: null }] }
  ]
}
const NOT_TABLES: unknown[] = [
  null,
  [],
  [run('x')],
  'text',
  7,
  {},
  { rows: 'x' },
  { type: 'tableContent' },
  { rows: [] }
]

const COLOR_LINES = [
  '<!-- colors:{"textColor":"red"} -->',
  '<!-- colors:{"textColor":"red","backgroundColor":"blue"} -->',
  '<!-- colors:{"backgroundColor":"blue","textColor":"red"} -->',
  '<!-- colors:{} -->',
  '<!-- colors:{"textColor":"default"} -->',
  '<!-- colors:{"textColor":null,"x":[1,2]} -->',
  '<!-- colors:{"textColor":"red","textColor":"blue"} -->',
  '<!-- colors:{"2":"b","1":"a","textColor":"red"} -->',
  '<!-- colors:{"__proto__":1} -->',
  '<!-- colors:{"a":1e2,"b":0.5,"c":-0} -->',
  '<!-- colors:{"textColor":"é😀日本"} -->',
  '<!-- colors:{"textColor":"a\\u2028b"} -->',
  '<!-- colors:{"textColor":"x"}  -->',
  '<!--colors:{"textColor":"x"} -->',
  '<!-- colors: {"textColor":"x"} -->',
  '<!-- colors:{"textColor":"x"} -->\n',
  '<!-- colors:{"textColor":"x"} -->\r',
  ' <!-- colors:{"textColor":"x"} -->',
  '<!-- colors:{"a":{"b":1}} -->',
  '<!-- colors:{a} -->',
  '<!-- colors:{"a":"\n"} -->',
  '<!-- colors:{"a":\n1} -->',
  '<!-- colors:[1] -->',
  '<!-- colors:{"a":1}} -->',
  '<!-- colors: -->',
  '<!-- colors:{ -->',
  '<!-- COLORS:{} -->',
  'text <!-- colors:{} -->'
]

function blockColors(c: CaseList): void {
  c.each('blockColors.isBlockColorsLine', COLOR_LINES)
  c.each('blockColors.parseBlockColorsMarker', COLOR_LINES)
  const props: Record<string, unknown>[] = [
    {},
    { textColor: 'default' },
    { textColor: 'red' },
    { backgroundColor: 'blue' },
    { backgroundColor: 'blue', textColor: 'red' },
    { textColor: 'default', backgroundColor: 'default' },
    { textColor: 'default', backgroundColor: 'blue' },
    { textColor: null },
    { textColor: '' },
    { textColor: 5, backgroundColor: true },
    { textColor: 'red', other: 1, textAlignment: 'center' },
    { textColor: 'é"\\\n😀\u2028' },
    { textColor: { a: 1 }, backgroundColor: [1, 2.5, 1e21, null] }
  ]
  c.each('blockColors.hasNonDefaultColors', props)
  c.each('blockColors.serializeBlockColorsMarker', props)

  const contents: unknown[] = [
    TABLE_COLORED,
    TABLE_PLAIN,
    TABLE_ALIGNED,
    TABLE_LEGACY,
    TABLE_ODD,
    ...NOT_TABLES,
    table([[cell('a', { backgroundColor: 'blue', textColor: 'red' })]]),
    table([[cell('a', { textColor: null })], [cell('b', { textColor: 'default' })]]),
    {
      rows: [
        {
          cells: [{ props: { textColor: 'red' } }, { content: [], props: { backgroundColor: 'y' } }]
        }
      ]
    },
    { rows: [{ cells: [{ props: [] }, { props: ['x'] }] }] }
  ]
  c.each('blockColors.extractTableCellColors', contents)

  const cellColors: unknown[] = [
    { '0:0': { textColor: 'red' } },
    { '0:0': { textColor: 'red' }, '1:1': { backgroundColor: 'blue', textColor: 'green' } },
    {},
    { '0:1': {} },
    { '0:0': { textColor: 'x' }, '0:1': { textColor: 'y' } },
    { '9:9': { textColor: 'red' }, '0:9': { textColor: 'red' }, '9:0': { textColor: 'red' } },
    { '-1:0': { textColor: 'red' }, '0:-1': { textColor: 'red' }, '-0:0': { textColor: 'blue' } },
    { ' 1 : 1 ': { textColor: 'red' } },
    { '1.0:0': { textColor: 'p' }, '0:1e0': { textColor: 'q' } },
    { '0x1:0': { textColor: 'r' } },
    { '1.5:0': { textColor: 'red' }, 'a:b': { textColor: 'red' }, '0': { textColor: 'red' } },
    { ':': { textColor: 'red' } },
    { '0:0:5': { textColor: 'red' } },
    { '0:0': 'ab' },
    { '0:0': ['x'] },
    { '0:0': 5 },
    { '0:0': null },
    { '0:0': { '2': 'a', '1': 'b', textColor: 'red' } },
    { '1e21:0': { textColor: 'red' }, 'Infinity:0': { textColor: 'red' }, '0:': { textColor: 'z' } }
  ]
  for (const content of [TABLE_COLORED, TABLE_LEGACY, TABLE_PLAIN, TABLE_ODD, ...NOT_TABLES]) {
    for (const colors of cellColors.slice(0, 4))
      c.add('blockColors.applyTableCellColors', [content, colors])
  }
  for (const colors of cellColors) {
    c.add('blockColors.applyTableCellColors', [TABLE_COLORED, colors])
    c.add('blockColors.serializeTableCellColorsMarker', [colors])
  }
  c.add('blockColors.applyTableCellColors', [
    { rows: [{ cells: [{ props: ['p', 'q'] }, { props: 'str' }] }] },
    { '0:0': { textColor: 'red' }, '0:1': { textColor: 'red' } }
  ])

  const tableLines = [
    '<!-- table-colors:{"0:0":{"textColor":"red"}} -->',
    '<!-- table-colors:{} -->',
    '<!-- table-colors:[] -->',
    '<!-- table-colors:{"0:0":{"textColor":"red"},"1:1":{"backgroundColor":"b"}} -->',
    '<!-- table-colors:{"0:0":5} -->',
    '<!-- table-colors:{"2":1,"0:1":{}} -->',
    '<!-- table-colors:{"a":{"b":1}} -->',
    '<!-- table-colors:{bad} -->',
    '<!-- table-colors:{"a":"\u2028"} -->',
    '<!-- table-colors:{"a":"x"}\u2028 -->',
    '<!-- table-colors:{"a":"x"}\n -->',
    '<!-- table-colors:{"a":"x"}\r -->',
    '<!-- table-colors:{"a":"é"} -->',
    '<!-- table-colors:{"a":1} --> ',
    '<!-- table-colors:{"a":1} -->x',
    '<!-- table-colors: {} -->'
  ]
  c.each('blockColors.isTableCellColorsLine', tableLines)
  c.each('blockColors.parseTableCellColorsMarker', tableLines)
}

const ALIGN_LINES = [
  '<!-- align:center -->',
  '<!-- align:right -->',
  '<!-- align:justify -->',
  '<!-- align:left -->',
  '<!-- align:Center -->',
  '<!-- align: center -->',
  '<!-- align:center  -->',
  '<!-- align:center -->\n',
  ' <!-- align:center -->',
  '<!--align:center-->',
  '<!-- align:centerx -->',
  ''
]

const ALIGN_TABLE_LINES = [
  '<!-- table-align:{"0:0":"center"} -->',
  '<!-- table-align:{"0:0":"center","1:2":"right","3:1":"justify"} -->',
  '<!-- table-align:{} -->',
  '<!-- table-align:{"0:0":"left"} -->',
  '<!-- table-align:{"0:0":"center","1:1":"nope"} -->',
  '<!-- table-align:{"0:0":5} -->',
  '<!-- table-align:{"0:0":null} -->',
  '<!-- table-align:[] -->',
  '<!-- table-align:{"2":"right","1":"center","a":"justify"} -->',
  '<!-- table-align:{"0:0":"center","0:0":"right"} -->',
  '<!-- table-align:{"__proto__":"center"} -->',
  '<!-- table-align:{bad} -->',
  '<!-- table-align:{"a":"center"}\n -->',
  '<!-- table-align:{"a":{"b":"center"}} -->',
  '<!-- table-align: {} -->'
]

const LAYOUT_LINES = [
  '<!-- table-layout:{"columnWidths":[100,200]} -->',
  '<!-- table-layout:{"columnWidths":[null,150.5,null]} -->',
  '<!-- table-layout:{"columnWidths":[1e21,5e-7]} -->',
  '<!-- table-layout:{"columnWidths":[]} -->',
  '<!-- table-layout:{"columnWidths":[null,null]} -->',
  '<!-- table-layout:{"columnWidths":[0]} -->',
  '<!-- table-layout:{"columnWidths":[-5]} -->',
  '<!-- table-layout:{"columnWidths":["100"]} -->',
  '<!-- table-layout:{"columnWidths":[true]} -->',
  '<!-- table-layout:{"columnWidths":{}} -->',
  '<!-- table-layout:{"columnWidths":5} -->',
  '<!-- table-layout:{"other":[1]} -->',
  '<!-- table-layout:{} -->',
  '<!-- table-layout:[] -->',
  '<!-- table-layout:{"columnWidths":[1e400]} -->',
  '<!-- table-layout:{"columnWidths":[100,],} -->',
  '<!-- table-layout:{"columnWidths":[100.0,2.50,1E2]} -->',
  '<!-- table-layout:{"columnWidths":[100],"columnWidths":[5]} -->'
]

function blockMarkers(c: CaseList): void {
  c.each('blockMarkers.isBlockAlignLine', ALIGN_LINES)
  c.each('blockMarkers.parseBlockAlignMarker', ALIGN_LINES)
  c.each('blockMarkers.isTableAlignLine', ALIGN_TABLE_LINES)
  c.each('blockMarkers.parseTableCellAlignmentsMarker', ALIGN_TABLE_LINES)
  c.each('blockMarkers.isTableLayoutLine', LAYOUT_LINES)
  c.each('blockMarkers.parseTableLayoutMarker', LAYOUT_LINES)
  c.each('blockMarkers.serializeBlockAlignMarker', [
    {},
    { textAlignment: 'left' },
    { textAlignment: 'center' },
    { textAlignment: 'right' },
    { textAlignment: 'justify' },
    { textAlignment: 'bogus' },
    { textAlignment: 5 },
    { textAlignment: null },
    { textAlignment: 'center -->\n<!-- x' }
  ])

  const contents: unknown[] = [
    TABLE_ALIGNED,
    TABLE_PLAIN,
    TABLE_COLORED,
    TABLE_LEGACY,
    TABLE_ODD,
    ...NOT_TABLES,
    {
      rows: [
        {
          cells: [
            { props: { textAlignment: 'center' } },
            { props: [] },
            { props: { textAlignment: 'left' } }
          ]
        }
      ]
    },
    {
      rows: [
        { cells: [{ props: { textAlignment: 'justify' } }] },
        { cells: [{ props: { textAlignment: 'right' } }] }
      ]
    }
  ]
  c.each('blockMarkers.extractTableCellAlignments', contents)
  const alignments: unknown[] = [
    { '0:0': 'center' },
    { '0:0': 'center', '1:1': 'right', '5:5': 'justify' },
    {},
    { '0:1': 'right', '0:0': 'center' },
    { '-1:0': 'right', ':': 'center', '0:0:0': 'right', ' 0 : 1 ': 'justify' },
    { '0x0:0': 'center', '1e0:0': 'right', '0:': 'justify' },
    { '1.5:0': 'right', abc: 'center', '': 'center' }
  ]
  for (const al of alignments) {
    c.add('blockMarkers.serializeTableCellAlignmentsMarker', [al])
    for (const content of [
      TABLE_ALIGNED,
      TABLE_PLAIN,
      TABLE_LEGACY,
      TABLE_ODD,
      ...NOT_TABLES.slice(0, 4)
    ]) {
      c.add('blockMarkers.applyTableCellAlignments', [content, al])
    }
  }
  c.add('blockMarkers.applyTableCellAlignments', [
    { rows: [{ cells: [{ props: ['a'] }, { props: 'p' }, { props: null }] }] },
    { '0:0': 'center', '0:1': 'center', '0:2': 'center' }
  ])

  const layoutContents: unknown[] = [
    table([[cell('a'), cell('b')]], { columnWidths: [100, 200] }),
    table([[cell('a'), cell('b')]], { columnWidths: [null, 120.5] }),
    table([[cell('a'), cell('b')]], { columnWidths: [null, null] }),
    table([[cell('a'), cell('b')]], { columnWidths: [0, -1, 'x', true, 5] }),
    table([[cell('a'), cell('b')]], { columnWidths: [1e21, 5e-7, 1.0, 100.25] }),
    table([[cell('a'), cell('b')]], { columnWidths: [] }),
    table([[cell('a'), cell('b')]], { columnWidths: 'x' }),
    table([[cell('a'), cell('b'), cell('c')]]),
    { type: 'tableContent', rows: [{ cells: [1, 2, 3] }] },
    { type: 'tableContent', rows: [], columnWidths: [4] },
    { type: 'tableContent', rows: [{}] },
    { type: 'tableContent', rows: [null] },
    { columnWidths: [5], rows: 'x' },
    ...NOT_TABLES
  ]
  c.each('blockMarkers.extractTableLayout', layoutContents)
  const layouts: unknown[] = [
    { columnWidths: [100, 200] },
    { columnWidths: [null, 200] },
    { columnWidths: [100] },
    { columnWidths: [100, 200, 300, 400] },
    { columnWidths: [] },
    { columnWidths: [null] },
    { columnWidths: [1e21, 5e-7, 1.0, 0.1] },
    { columnWidths: [0, -3, 7] }
  ]
  for (const layout of layouts) {
    c.add('blockMarkers.serializeTableLayoutMarker', [layout])
    for (const content of layoutContents.slice(0, 14))
      c.add('blockMarkers.applyTableLayout', [content, layout])
  }

  markerLines(c)
  patches(c)
}

const para = (props: Record<string, unknown>, content: unknown = [run('x')]): object => ({
  type: 'paragraph',
  props,
  content,
  children: []
})

const wikiLink = (props: Record<string, unknown> = {}): object => ({
  type: 'wikiLink',
  props: { target: 'A', alias: '', ...props }
})

function markerLines(c: CaseList): void {
  const blocks: object[] = [
    para({}),
    para({ textColor: 'default', backgroundColor: 'default', textAlignment: 'left' }),
    para({ textColor: 'red' }),
    para({ textAlignment: 'center' }),
    para({ textColor: 'red', backgroundColor: 'blue', textAlignment: 'right' }),
    para({ textAlignment: 'bogus' }),
    { type: 'table', props: { textColor: 'red' }, content: TABLE_COLORED },
    { type: 'table', props: {}, content: TABLE_ALIGNED },
    {
      type: 'table',
      props: {},
      content: table([[cell('a', { textColor: 'red', textAlignment: 'center' })]], {
        columnWidths: [120]
      })
    },
    {
      type: 'table',
      props: { textColor: 'red', textAlignment: 'justify' },
      content: table([[cell('a', { backgroundColor: 'b', textAlignment: 'right' }), cell('b')]], {
        columnWidths: [null, 80]
      })
    },
    { type: 'table', props: {}, content: TABLE_PLAIN },
    { type: 'table', props: {}, content: TABLE_LEGACY },
    para({}, [wikiLink()]),
    para({}, [wikiLink({ size: 'small' })]),
    para({ textAlignment: 'center' }, [wikiLink({ size: 'medium', cover: true, preview: true })]),
    para({}, [wikiLink({ cover: true })]),
    para({}, [wikiLink({ preview: true }), run(' ')]),
    para({}, [run('  '), wikiLink({ size: 'small' }), run('\u00a0\t')]),
    para({}, [wikiLink({ size: 'small' }), run('x')]),
    para({}, [wikiLink({ size: 'small' }), wikiLink()]),
    para({}, [wikiLink({ size: 'huge', cover: 'yes' })]),
    { type: 'heading', props: {}, content: [wikiLink({ size: 'small' })] },
    { type: 'image', props: { textColor: 'red' }, content: undefined }
  ]
  for (const block of blocks) c.add('blockMarkers.sidecarMarkerLines', [block])
  for (const block of [para({}, [wikiLink({ size: 'small' })]), para({}, [wikiLink()])]) {
    c.add('linkCard.serializeLinkCardMarker', [block])
  }
}

function patches(c: CaseList): void {
  const lines = [
    ...COLOR_LINES,
    ...ALIGN_LINES,
    ...ALIGN_TABLE_LINES.slice(0, 5),
    ...LAYOUT_LINES.slice(0, 8),
    '<!-- table-colors:{"0:0":{"textColor":"red"}} -->',
    '<!-- table-colors:{} -->',
    '<!-- link-card:{"size":"small"} -->',
    '<!-- link-card:{"cover":true,"preview":true,"size":"medium"} -->',
    '<!-- link-card:{} -->',
    '<!-- unknown:{} -->',
    'plain text'
  ]
  const blocks: object[] = [
    para({ a: 1 }),
    { type: 'paragraph', content: [] },
    { type: 'table', props: {}, content: TABLE_COLORED },
    {
      type: 'table',
      props: { textColor: 'blue' },
      content: table([[cell('a'), cell('b')]], { columnWidths: [10, null] })
    },
    para({}, [wikiLink()]),
    para({}, [run('[[Target|Alias]]')])
  ]
  for (const line of lines) {
    for (const block of blocks) c.add('blockMarkers.parseSidecarMarkerLine', [line, block])
  }
  c.add('blockMarkers.parseSidecarMarkerLine', [
    '<!-- colors:{"textColor":"red"} -->',
    { type: 'paragraph', props: { '3': 'x', textColor: 'a' }, content: [] }
  ])
}

const LINK_LINES = [
  '<!-- link-card:{"size":"small"} -->',
  '<!-- link-card:{"size":"medium"} -->',
  '<!-- link-card:{"size":"none"} -->',
  '<!-- link-card:{"size":"large"} -->',
  '<!-- link-card:{"size":null} -->',
  '<!-- link-card:{"size":5} -->',
  '<!-- link-card:{"cover":true} -->',
  '<!-- link-card:{"cover":false,"preview":true} -->',
  '<!-- link-card:{"cover":"true"} -->',
  '<!-- link-card:{"preview":null} -->',
  '<!-- link-card:{"preview":1} -->',
  '<!-- link-card:{"preview":true,"cover":true,"size":"small"} -->',
  '<!-- link-card:{"extra":1,"cover":true} -->',
  '<!-- link-card:{"extra":1} -->',
  '<!-- link-card:{} -->',
  '<!-- link-card:[] -->',
  '<!-- link-card:{bad} -->',
  '<!-- link-card:{"cover":true}\u2028 -->',
  '<!-- link-card:{"size":"small"} --> ',
  '<!--link-card:{"size":"small"} -->',
  '<!-- link-card:{"size":"small","size":"medium"} -->'
]

function linkCard(c: CaseList): void {
  c.each('linkCard.isLinkCardLine', LINK_LINES)
  c.each('linkCard.parseLinkCardMarker', LINK_LINES)
  const texts = [
    '[[A]]',
    '[[A|alias]]',
    '[[ A | alias ]]',
    '[[A|]]',
    '[[|a]]',
    '[[]]',
    '[[ ]]',
    '[[A]',
    '[[A]]x',
    'x[[A]]',
    '[[A|b|c]]',
    '[[A|b]c]]',
    '[[a]b]]',
    '[[日本語|😀]]',
    '[[A\nB]]',
    '[[A]][[B]]',
    ' [[A]]'
  ]
  const displays: object[] = [
    { size: 'small' },
    { cover: true },
    { size: 'medium', cover: true, preview: true },
    { preview: false }
  ]
  const styleSets: Record<string, unknown>[] = [
    {},
    { bold: true },
    { bold: true, italic: true, underline: true, strike: true, code: true },
    { textColor: 'red', backgroundColor: 'blue' },
    { textColor: 'default', backgroundColor: 'default', bold: false }
  ]
  for (const display of displays) {
    for (const text of texts) c.add('linkCard.applyLinkCard', [para({}, [run(text)]), display])
    for (const styles of styleSets)
      c.add('linkCard.applyLinkCard', [para({}, [run('[[A|b]]', styles)]), display])
    c.add('linkCard.applyLinkCard', [para({}, [run('[[A'), run(']]')]), display])
    c.add('linkCard.applyLinkCard', [para({}, [run('[[A'), run(']]', { bold: true })]), display])
    c.add('linkCard.applyLinkCard', [para({}, [run('[[A'), { type: 'text', text: ']]' }]), display])
    c.add('linkCard.applyLinkCard', [
      para({}, [{ type: 'text', text: '[[A]]', styles: null }, run('', {})]),
      display
    ])
    c.add('linkCard.applyLinkCard', [
      para({}, [{ type: 'text', text: '[[A]]', styles: [] }]),
      display
    ])
    c.add('linkCard.applyLinkCard', [para({}, [{ type: 'text', text: 5 }]), display])
    c.add('linkCard.applyLinkCard', [
      para({}, [run('[[A]]'), { type: 'link', content: [] }]),
      display
    ])
    c.add('linkCard.applyLinkCard', [para({}, []), display])
    c.add('linkCard.applyLinkCard', [para({}, null), display])
    c.add('linkCard.applyLinkCard', [
      { type: 'heading', props: {}, content: [run('[[A]]')] },
      display
    ])
    c.add('linkCard.applyLinkCard', [para({}, [wikiLink()]), display])
    c.add('linkCard.applyLinkCard', [
      para({}, [run(' '), wikiLink({ size: 'small', x: 1 }), run('')]),
      display
    ])
    c.add('linkCard.applyLinkCard', [para({}, [wikiLink(), wikiLink()]), display])
    c.add('linkCard.applyLinkCard', [para({}, [{ type: 'wikiLink', props: null }]), display])
    c.add('linkCard.applyLinkCard', [para({}, [{ type: 'wikiLink' }]), display])
    c.add('linkCard.applyLinkCard', [
      para({ keep: 1 }, [wikiLink({ cover: true, size: 'medium' })]),
      display
    ])
  }
  for (const size of ['none', 'small', 'medium', 'large', 5, null, undefined]) {
    for (const cover of [true, false, 'x', undefined]) {
      for (const preview of [true, undefined]) {
        c.add('linkCard.serializeLinkCardMarker', [para({}, [wikiLink({ size, cover, preview })])])
      }
    }
  }
}

export function colorMarkerCases(): CaseList[] {
  const lists = [
    new CaseList('block-colors'),
    new CaseList('block-markers'),
    new CaseList('link-card')
  ]
  blockColors(lists[0])
  blockMarkers(lists[1])
  linkCard(lists[2])
  return lists
}

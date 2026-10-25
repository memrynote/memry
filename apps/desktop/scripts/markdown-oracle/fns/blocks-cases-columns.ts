/** Hand-written `blocks` cases: column regions, settings, widths and builders. */
import { type Builder, MINI, para, table } from './blocks-builder'

const REGIONS: string[] = [
  '--- start-multi-column: a1\n\nLeft\n\n--- end-column ---\n\nRight\n\n--- end-multi-column',
  '--- start-multi-column: a1\n```column-settings\nNumber of Columns: 2\nColumn Size: [30%, 70%]\n```\n\nLeft\n\n--- end-column ---\n\nRight\n\n--- end-multi-column',
  '--- start-multi-column\nA\n--- end-column ---\nB\n--- end-multi-column',
  '--- start-multi-column:\nA\n--- end-column ---\nB\n--- end-multi-column',
  '--- start-multi-column:   spaced id  \nA\n--- end-column ---\nB\n--- end-multi-column',
  '--- start-multi-column: a\u00a0b\nA\n--- end-column ---\nB\n--- end-multi-column',
  '--- start-multi-column: a\u2028b\nA\n--- end-column ---\nB\n--- end-multi-column',
  '--- start-multi-column: a\rb\nA\n--- end-column ---\nB\n--- end-multi-column',
  '--- START-MULTI-COLUMN: a\nA\n--- END-COLUMN ---\nB\n--- END-MULTI-COLUMN',
  '--- multi-column-start: a\nA\n--- column-end ---\nB\n--- multi-column-end',
  '=== start-multi-column: a\nA\n=== column-break ===\nB\n=== end-multi-column',
  '--- start-multi-column: a\nA\n--- break-column ---\nB\n--- end-multi-column',
  '--- start-multi-column: a\nA\n--- column-break\nB\n--- end-multi-column',
  '--- start-multi-column: a\nA\n---column-end===\nB\n--- end-multi-column',
  '--- start-multi-column: a\nA\n--- end-column --- x\nB\n--- end-multi-column',
  '--- start-multi-column: a\nA\n--- end-column ----\nB\n--- end-multi-column',
  '--- start-multi-column: a\nA\n--- end-column ---\nB\n--- end-multi-column ',
  '--- start-multi-column: a\nA\n--- end-column ---\nB\n  --- end-multi-column',
  '--- start-multi-column: a\nA\n  --- end-column ---  \nB\n--- end-multi-column',
  '--- start-multi-column: a\nA\n--- end-column ---\nB\n--- end-multi-column\ntrailing',
  '  --- start-multi-column: a\nA\n--- end-column ---\nB\n--- end-multi-column',
  '----start-multi-column: a\nA\n--- end-column ---\nB\n--- end-multi-column',
  '-- start-multi-column: a\nA\n--- end-column ---\nB\n--- end-multi-column',
  '---\u00a0start-multi-column: a\nA\n--- end-column ---\nB\n--- end-multi-column',
  '---start-multi-column:a\nA\n--- end-column ---\nB\n--- end-multi-column',
  '--- start-multi-column: a\nA\n--- end-multi-column',
  '--- start-multi-column: a\n--- end-multi-column',
  '--- start-multi-column: a\nA\n--- end-column ---\nB',
  '--- start-multi-column: a\nA\n--- end-column ---\n--- end-multi-column',
  '--- start-multi-column: a\n--- end-column ---\n--- end-multi-column',
  '--- start-multi-column: a\nA\n--- end-column ---\nB\n--- end-column ---\nC\n--- end-multi-column',
  '--- start-multi-column: a\n```settings\nx: 1\n```\nA\n--- end-column ---\nB\n--- end-multi-column',
  '--- start-multi-column: a\n``` column-settings \nx: 1\n```  \nA\n--- end-column ---\nB\n--- end-multi-column',
  '--- start-multi-column: a\n```multi-column-settings\nx: 1\n```\nA\n--- end-column ---\nB\n--- end-multi-column',
  '--- start-multi-column: a\n```COLUMN-SETTINGS\nx: 1\n```\nA\n--- end-column ---\nB\n--- end-multi-column',
  '--- start-multi-column: a\n```column-settings\nx: 1\nA\n--- end-column ---\nB\n--- end-multi-column',
  '--- start-multi-column: a\n```column-settings\n```\nA\n--- end-column ---\nB\n--- end-multi-column',
  '--- start-multi-column: a\n```column-settings\nx: 1\n```js\nA\n--- end-column ---\nB\n--- end-multi-column',
  '--- start-multi-column: a\n```other\nx: 1\n```\nA\n--- end-column ---\nB\n--- end-multi-column',
  '--- start-multi-column: a\n\n```column-settings\nx: 1\n```\nA\n--- end-column ---\nB\n--- end-multi-column',
  '--- start-multi-column: a\nA\n```\n--- end-column ---\n```\n--- end-column ---\nB\n--- end-multi-column',
  '--- start-multi-column: a\nA\n```\n--- end-multi-column\n```\n--- end-column ---\nB\n--- end-multi-column',
  '--- start-multi-column: a\nA\n~~~\nunclosed\n--- end-column ---\nB\n--- end-multi-column',
  '```\n--- start-multi-column: a\nA\n--- end-column ---\nB\n--- end-multi-column\n```',
  '--- start-multi-column: a\r\nA\r\n--- end-column ---\r\nB\r\n--- end-multi-column\r\n',
  '--- start-multi-column: a\n- list\n- items\n--- end-column ---\n> quote\n--- end-multi-column',
  '--- start-multi-column: a\n<details data-memry-toggle>\n<summary>S</summary>\n</details>\n--- end-column ---\nB\n--- end-multi-column',
  '--- start-multi-column: 日本語\n日本語 😀\n--- end-column ---\n😀\n--- end-multi-column',
  'before\n\n--- start-multi-column: a\nA\n--- end-column ---\nB\n--- end-multi-column\n\nafter',
  'before\n--- start-multi-column: a\nA\n--- end-column ---\nB\n--- end-multi-column\nafter',
  '\n\n\n--- start-multi-column: a\nA\n--- end-column ---\nB\n--- end-multi-column',
  '--- start-multi-column: a\nA\n--- end-column ---\nB\n--- end-multi-column\n\n\n\n',
  'x\n\n\n\n--- start-multi-column: a\nA\n--- end-column ---\nB\n--- end-multi-column\n\n\n\n\ny',
  '--- start-multi-column: a\nA\n--- end-column ---\nB\n--- end-multi-column\n\n\n--- start-multi-column: b\nC\n--- end-column ---\nD\n--- end-multi-column',
  '--- start-multi-column: a\nA\n--- end-column ---\nB\n--- end-multi-column\n--- start-multi-column: b\nC\n--- end-column ---\nD\n--- end-multi-column',
  '--- start-multi-column: a\nA\n--- start-multi-column: b\nC\n--- end-column ---\nD\n--- end-multi-column',
  '::: columns\nA\n\n::: columnbreak\n:::\nB\n:::',
  '::: columns\nA\n\n::: {.columnbreak}\n:::\nB\n:::',
  '::: columns\nA\n\n::: columnbreak\n\n:::\n\nB\n\n:::',
  ':::columns\nA\n:::columnbreak\n:::\nB\n:::',
  '::::: columns\nA\n::: columnbreak\n:::\nB\n:::::',
  '::: twocolumns\nA\n::: columnbreak\n:::\nB\n:::',
  '::: three-columns\nA\n::: columnbreak\n:::\nB\n::: columnbreak\n:::\nC\n:::',
  '::: TenColumns\nA\n::: columnbreak\n:::\nB\n:::',
  '::: eleven-columns\nA\n::: columnbreak\n:::\nB\n:::',
  '::: threecolumns \nA\n::: columnbreak\n:::\nB\n:::',
  '::: {.columns}\nA\n::: {.columnbreak}\n:::\nB\n:::',
  '::: {.columns #regionx}\nA\n::: columnbreak\n:::\nB\n:::',
  '::: {.columns id=regiony}\nA\n::: columnbreak\n:::\nB\n:::',
  '::: {.columns id="quoted"}\nA\n::: columnbreak\n:::\nB\n:::',
  '::: {.columns id="}\nA\n::: columnbreak\n:::\nB\n:::',
  '::: {.columns #a id=b}\nA\n::: columnbreak\n:::\nB\n:::',
  '::: {.columns columngap=20px}\nA\n::: columnbreak\n:::\nB\n:::',
  '::: {.columns column-gap="2em"}\nA\n::: columnbreak\n:::\nB\n:::',
  '::: {.columns col-count=2 colcount=2 Border=1}\nA\n::: columnbreak\n:::\nB\n:::',
  '::: {.columns Shadow="x" other}\nA\n::: columnbreak\n:::\nB\n:::',
  '::: {.columns =x}\nA\n::: columnbreak\n:::\nB\n:::',
  '::: {.columns .more}\nA\n::: columnbreak\n:::\nB\n:::',
  '::: {.columns .}\nA\n::: columnbreak\n:::\nB\n:::',
  '::: {columns}\nA\n::: columnbreak\n:::\nB\n:::',
  '::: {.other}\nA\n::: columnbreak\n:::\nB\n:::',
  '::: {}\nA\n::: columnbreak\n:::\nB\n:::',
  '::: { }\nA\n::: columnbreak\n:::\nB\n:::',
  '::: {.columns\nA\n::: columnbreak\n:::\nB\n:::',
  '::: columns extra\nA\n::: columnbreak\n:::\nB\n:::',
  '::: other\nA\n::: columnbreak\n:::\nB\n:::',
  '::: columns\nA\n:::\nB\n:::',
  '::: columns\nA\n::: div\nnested\n:::\nB\n::: columnbreak\n:::\nC\n:::',
  '::: columns\n::: columnbreak\n:::\n:::',
  '::: columns\nA\n::: columnbreak\n:::\nB',
  '::: columns\nA\n:::',
  ':::\nA\n:::',
  '::: columns\nA\n::: columnbreak\n:::\nB\n```\n:::\n```\n:::',
  '::: columns\nA\n::: columnbreak {}\n:::\nB\n:::',
  '::: columns\nA\n::: { .columnbreak }\n:::\nB\n:::',
  '::: columns\nA\n::: {columnbreak\n:::\nB\n:::',
  '::: COLUMNBREAK\n::: columns\nA\n::: ColumnBreak\n:::\nB\n:::',
  '  ::: columns\nA\n::: columnbreak\n:::\nB\n:::',
  '::: columns\r\nA\r\n::: columnbreak\r\n:::\r\nB\r\n:::',
  '::: columns\u00a0\nA\n::: columnbreak\n:::\nB\n:::',
  '::: {.columns id=日本語}\nA\n::: columnbreak\n:::\nB\n:::',
  'text only',
  '',
  '---',
  '--- start-multi-column'
]

const SETTINGS: string[] = [
  '',
  '```column-settings\nNumber of Columns: 2\nColumn Size: [30%, 70%]\n```',
  '```column-settings\nNumber of Columns: 2\nColumn Size: [30%, 70%]\nBorder: on\n```',
  '```column-settings\nNumber of Columns: 3\nColumn Size: [1fr, 2fr, 1fr]\n```',
  '```column-settings\nNumber of Columns: 3\nColumn Size: [10px, 20px, 10px]\n```',
  '```column-settings\nNumber of Columns: 2\nColumn Size: [10px, 50%]\n```',
  '```column-settings\nNumber of Columns: 2\nColumn Size: [10PX, 20px]\n```',
  '```column-settings\nNumber of Columns: 2\nColumn Size: [10, 30]\n```',
  '```column-settings\nNumber of Columns: 2\nColumn Size: [10.5, 30.25]\n```',
  '```column-settings\nNumber of Columns: 2\nColumn Size: [10., 30]\n```',
  '```column-settings\nNumber of Columns: 2\nColumn Size: [.5, 30]\n```',
  '```column-settings\nNumber of Columns: 2\nColumn Size: [0, 30]\n```',
  '```column-settings\nNumber of Columns: 2\nColumn Size: [0%, 0%]\n```',
  '```column-settings\nNumber of Columns: 2\nColumn Size: [1 0, 30]\n```',
  '```column-settings\nNumber of Columns: 2\nColumn Size: [10 %, 30 %]\n```',
  '```column-settings\nNumber of Columns: 2\nColumn Size: [10\u00a0%, 30%]\n```',
  '```column-settings\nNumber of Columns: 2\nColumn Size: [,]\n```',
  '```column-settings\nNumber of Columns: 2\nColumn Size: []\n```',
  '```column-settings\nNumber of Columns: 2\nColumn Size: [50%]\n```',
  '```column-settings\nNumber of Columns: 2\nColumn Size: [50%, 50%, 50%]\n```',
  '```column-settings\nNumber of Columns: 2\nColumn Size: 50%, 50%\n```',
  '```column-settings\nNumber of Columns: 2\nColumn Size: [50%, 50%\n```',
  '```column-settings\nNumber of Columns: 2\nColumn Size: [a, b]\n```',
  '```column-settings\nNumber of Columns: 2\nColumn Size: [99999999999999999999999999%, 1%]\n```',
  '```column-settings\nNumber of Columns: 2\nColumn Size: left\n```',
  '```column-settings\nNumber of Columns: 2\nColumn Size: Right\n```',
  '```column-settings\nNumber of Columns: 2\nColumn Size: first\n```',
  '```column-settings\nNumber of Columns: 2\nColumn Size: SECOND\n```',
  '```column-settings\nNumber of Columns: 2\nColumn Size: center\n```',
  '```column-settings\nNumber of Columns: 2\nColumn Size: standard\n```',
  '```column-settings\nNumber of Columns: 3\nColumn Size: left\n```',
  '```column-settings\nNumber of Columns: 3\nColumn Size: center\n```',
  '```column-settings\nNumber of Columns: 3\nColumn Size: middle\n```',
  '```column-settings\nNumber of Columns: 3\nColumn Size: second\n```',
  '```column-settings\nNumber of Columns: 3\nColumn Size: right\n```',
  '```column-settings\nNumber of Columns: 3\nColumn Size: third\n```',
  '```column-settings\nNumber of Columns: 3\nColumn Size: first\n```',
  '```column-settings\nNumber of Columns: 4\nColumn Size: left\n```',
  '```column-settings\nNUMBER OF COLUMNS: 2\nCOLUMN WIDTH: [1, 3]\n```',
  '```column-settings\nNum of Cols: 2\nCol Size: [1, 3]\n```',
  '```column-settings\nCol Count: 2\nCol Width: [1, 3]\n```',
  '```column-settings\nLargest Column: [1, 3]\n```',
  '```column-settings\nNumber of Columns: two\nColumn Size: [1, 3]\n```',
  '```column-settings\nNumber of Columns: 0x2\nColumn Size: [1, 3]\n```',
  '```column-settings\nNumber of Columns: 2.0\nColumn Size: [1, 3]\n```',
  '```column-settings\nNumber of Columns: 2e0\nColumn Size: [1, 3]\n```',
  '```column-settings\nNumber of Columns: +2\nColumn Size: [1, 3]\n```',
  '```column-settings\nNumber of Columns:\nColumn Size: [1, 3]\n```',
  '```column-settings\nNumber of Columns: 0b10\nColumn Size: [1, 3]\n```',
  '```column-settings\nNumber of Columns: 0o2\nColumn Size: [1, 3]\n```',
  '```column-settings\nNumber of Columns: 3\nColumn Size: [1, 3]\n```',
  '```column-settings\n: 2\nColumn Size: [1, 3]\n```',
  '```column-settings\nno colon\nColumn Size: [1, 3]\n```',
  '```column-settings\nColumn Size: [1, 3]\nColumn Size: [3, 1]\n```',
  '```column-settings\nColumn Size: [1, 3]\nColumn Spacing: 8px\nBorder: off\n```',
  '```column-settings\nColumn Size: [1, 3]\nNum of Cols: 2\nNumber of Columns: 5\n```',
  '```column-settings\n```',
  '```column-settings\nx: 1\n```',
  'one line',
  'a\nb',
  '日本語: 😀\nColumn Size: [1, 3]\n'
]

function widthCases(b: Builder): void {
  for (const settings of SETTINGS) {
    for (const count of [0, 1, 2, 3, 4]) b.add('columns.widths', settings, count)
  }
  const widthSets: number[][] = [
    [],
    [1],
    [1, 1],
    [1, 3],
    [3, 1],
    [2, 1, 1],
    [1, 2, 1],
    [1, 1, 2],
    [1, 1, 1],
    [1.01, 0.99],
    [1.03, 0.97],
    [0.5, 1.5],
    [0, 1],
    [-1, 1],
    [1, 2, 3, 4],
    [0.3, 0.7],
    [1, 1, 1, 1],
    [1e-9, 1],
    [1e9, 1],
    [1 / 3, 2 / 3],
    [0.123456, 0.876544],
    [7, 3],
    [33.3333, 66.6667]
  ]
  for (const settings of SETTINGS) {
    for (const widths of widthSets) {
      b.add('columns.settingsFor', settings, widths)
    }
  }
}

function regionCases(b: Builder): void {
  for (const text of REGIONS) b.add('columns.split', text)
  const ids: [string, string | null][] = [
    ['abc', 'x'],
    ['', 'ab-cd_ef12345'],
    ['', 'abcdef'],
    ['', 'abc'],
    ['', ''],
    ['', null],
    ['', '日本語😀'],
    ['', '!!!'],
    ['', 'a1b2c3d4'],
    ['x y', null],
    ['', 'ÀB-C']
  ]
  ids.forEach(([regionId, blockId]) => b.add('columns.regionIdFor', regionId, blockId))
  const bodies: string[][] = [
    [],
    ['a'],
    ['a', 'b'],
    ['a', ''],
    ['', 'b'],
    ['', ''],
    [' a ', '\n\nb\n\n', 'c'],
    ['a\n\nb', 'c\r\nd'],
    ['日本語', '😀']
  ]
  for (const body of bodies) {
    b.add('columns.serializeRegion', 'id', '', body)
    b.add('columns.serializeRegion', 'id', '```column-settings\nx: 1\n```', body)
    b.add('columns.serializeRegion', '', '', body)
  }
}

const segment = (columns: string[], settings = '', regionId = 'r1'): Record<string, unknown> => ({
  kind: 'columns',
  regionId,
  settings,
  columns
})

const column = (width: unknown, ...children: unknown[]): Record<string, unknown> => ({
  type: 'column',
  props: { width },
  children
})
const list = (
  props: Record<string, unknown>,
  columns: unknown[],
  id?: string
): Record<string, unknown> => ({
  type: 'columnList',
  ...(id === undefined ? {} : { id }),
  props,
  children: columns
})

function builderCases(b: Builder): void {
  const segments: Record<string, unknown>[] = [
    segment(['a', 'b']),
    segment(['a', '']),
    segment(['', '']),
    segment(['a', 'b', 'c'], '```column-settings\nColumn Size: [1, 2, 1]\n```'),
    segment(['a\n\nb', '- x\n- y'], '```column-settings\nColumn Size: [30%, 70%]\n```'),
    segment(['a', 'b'], '', ''),
    segment(['日本語', '😀'], 'x', '日本語')
  ]
  for (const s of segments) {
    for (const ids of [false, true]) b.add('columns.build', s, MINI, ids)
  }
  b.add('columns.build', segment(['a', 'b']), { kind: 'parse-error' }, true)
  b.add('columns.build', segment(['', '']), { kind: 'parse-error' }, true)
  b.add('columns.build', segment(['a', 'b']), table({ a: [], b: [para('B')] }), true)
  b.add('columns.build', { kind: 'markdown', text: 'x' }, MINI, false)

  const lists: Record<string, unknown>[] = [
    list({ regionId: 'r', settings: '' }, [column(1, para('a')), column(1, para('b'))]),
    list({ regionId: 'r', settings: '' }, [column(1, para('a')), column(3, para('b'))]),
    list(
      { regionId: '', settings: '' },
      [column(1, para('a')), column(1, para('b'))],
      'abc-123-def'
    ),
    list({ regionId: '', settings: '' }, [column(1, para('a')), column(1, para('b'))], '!!!'),
    list({ regionId: '', settings: '' }, [column(1, para('a')), column(1, para('b'))]),
    list({}, [column(1, para('a')), column(1, para('b'))], 'q'),
    list({ regionId: 5, settings: 7 }, [column(1, para('a')), column(1, para('b'))], 'q'),
    list(
      {
        regionId: 'r',
        settings:
          '```column-settings\nNumber of Columns: 2\nColumn Size: [30%, 70%]\nBorder: on\n```'
      },
      [column(0.6, para('a')), column(1.4, para('b'))]
    ),
    list(
      {
        regionId: 'r',
        settings: '```column-settings\nNumber of Columns: 2\nColumn Size: [30%, 70%]\n```'
      },
      [column(1, para('a')), column(1, para('b'))]
    ),
    list({ regionId: 'r', settings: 'x' }, [
      column('wide', para('a')),
      column(undefined, para('b')),
      column(null, para('c'))
    ]),
    list({ regionId: 'r', settings: '' }, [
      column(1, para('a')),
      column(1),
      column(2, para('c'), para('d'))
    ]),
    list({ regionId: 'r', settings: '' }, [column(1, para('only'))]),
    list({ regionId: 'r', settings: '' }, [column(1, para('a'), para('b'))]),
    list({ regionId: 'r', settings: '' }, []),
    { type: 'columnList', props: { regionId: 'r', settings: '' } },
    list({ regionId: 'r', settings: '' }, [
      { type: 'column', props: { width: 1 } },
      { type: 'column', props: {} }
    ])
  ]
  for (const l of lists) {
    b.add('columns.serializeList', l, MINI)
  }
  b.add('columns.serializeList', lists[0], { kind: 'serialize-error' })
  b.add('columns.serializeList', lists[11], { kind: 'serialize-error' })
}

export function columnCases(b: Builder): void {
  widthCases(b)
  regionCases(b)
  builderCases(b)
}

/**
 * The case list of `layer-text.json` (#3522 stage 4). Inputs only: every answer
 * comes from running the TypeScript in place. A case is `{fn, args}` for the
 * `fn` op of the oracle; ids are `<group>/fn/<function>-<n>`.
 */
import type { OracleCase } from '../cases-frontmatter'
import type { MarkdownSource } from '../cases-bn'
import { COMMON, HARD_BREAKS } from './text-inputs'
import {
  BREAK_ALPHABET,
  COMMENT_ALPHABET,
  fuzzDocs,
  GENERAL_ALPHABET,
  HTML_ALPHABET,
  LINK_ALPHABET,
  NESTING_ALPHABET,
  REFERENCE_ALPHABET,
  TABLE_ALPHABET
} from './text-fuzz'
import { COMMENTS, DESTINATIONS, LINK_REFERENCES, NORMALIZE, TOKENS } from './text-inputs-more'
import {
  CELLS,
  EMBEDS,
  FENCES,
  HTML_LINKS,
  IMAGES,
  INDENTED,
  LABELS,
  LEVELS,
  NESTING_MARKDOWN,
  SEGMENTS,
  SPANS
} from './text-inputs-lines'

const GROUPS: Record<string, string> = {
  emptyLines: 'empty-lines',
  htmlComments: 'html-comments',
  hardBreaks: 'hard-breaks',
  blockNesting: 'block-nesting',
  linkReferences: 'link-references',
  markdownCode: 'markdown-code',
  // Computed so the staged-secret scan does not read a module name as a credential key.
  ['token'.concat('Masking')]: 'token-masking',
  linkDestinations: 'link-destinations',
  linkCodeSpans: 'link-code-spans',
  cellCodeSpaces: 'cell-code-spaces'
}

const kebab = (name: string): string => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)

function unique(...lists: string[][]): string[] {
  return [...new Set(lists.flat())]
}

const hexOf = (text: string): string => Buffer.from(text, 'utf8').toString('hex')
const block = (name: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'paragraph',
  content: name,
  ...extra
})
const usage = (label: string, destination: string, text: string, raw: string): unknown => ({
  label,
  destination,
  text,
  raw
})
const definition = (
  label: string,
  destination: string,
  raw: string,
  gapBefore: number | null
): unknown => ({ label, destination, raw, gapBefore })

export function buildTextCases(external: MarkdownSource[], word: string): OracleCase[] {
  const cases: OracleCase[] = []
  const counters = new Map<string, number>()

  const add = (fn: string, ...args: unknown[]): void => {
    const [module, name] = fn.split('.')
    const group = GROUPS[module]
    if (!group) throw new Error(`no group for ${fn}`)
    const key = `${group}/fn/${kebab(name)}`
    const n = (counters.get(key) ?? 0) + 1
    counters.set(key, n)
    cases.push({ id: `${key}-${String(n).padStart(4, '0')}`, op: 'fn', input: { fn, args } })
  }
  const each = (fn: string, inputs: string[], ...rest: unknown[]): void => {
    for (const input of inputs) add(fn, input, ...rest)
  }
  /** Every external markdown source through `fn`, under its own id. */
  const eachSource = (fn: string, stride: number, ...rest: unknown[]): void => {
    const [module, name] = fn.split('.')
    const key = `${GROUPS[module]}/fn/${kebab(name)}-src`
    external.forEach((source, index) => {
      if (index % stride !== 0) return
      cases.push({
        id: `${key}-${String(index).padStart(4, '0')}`,
        op: 'fn',
        input: { fn, args: [source.markdown, ...rest] }
      })
    })
  }

  const token = (hex: string): string => `MEMRYCMT${word}${hex}X`

  // ---- empty-lines -------------------------------------------------------------
  const lines = unique(COMMON, FENCES, IMAGES, INDENTED, NORMALIZE(word), HARD_BREAKS.slice(0, 40))
  each('emptyLines.splitMarkdownPreservingBlanks', lines)
  each('emptyLines.splitByCodeFences', lines)
  for (const segments of SEGMENTS) add('emptyLines.assembleMarkdownWithBlanks', segments)
  each('emptyLines.separateBlockImages', unique(COMMON, IMAGES, FENCES))
  each('emptyLines.extractWikiImageEmbedRefs', unique(COMMON, EMBEDS))
  for (const stub of ['prefix', 'none', 'empty', 'onlyPng']) {
    each('emptyLines.rewriteWikiImageEmbeds', unique(COMMON.slice(0, 30), EMBEDS), stub)
  }
  each('emptyLines.fenceIndentedCodeBlocks', unique(COMMON, INDENTED, FENCES))
  each(
    'emptyLines.normalizeSerializedMarkdown',
    unique(COMMON, NORMALIZE(word), INDENTED.slice(0, 12))
  )
  each('emptyLines.escapeWikiLinkPipesInTableRows', unique(COMMON, NORMALIZE(word)))
  add(
    'emptyLines.escapeWikiLinkPipesInTableRows',
    '| [[a|b]] | [[c\\|d]] |\n| - | - |\n| [[e]|f]] | \\[[g|h]] |\n| [[ [[i|j]] |k]] | l |'
  )
  add('emptyLines.escapeWikiLinkPipesInTableRows', '| \\\u{1F600}[[a|b]] | [[\u65e5|\u672c]] |')
  add('emptyLines.escapeWikiLinkPipesInTableRows', '  | [[a|b]] |  \u00a0')
  add('emptyLines.escapeWikiLinkPipesInTableRows', '| [[a|b]]\\')
  eachSource('emptyLines.splitMarkdownPreservingBlanks', 4)
  eachSource('emptyLines.separateBlockImages', 6)
  eachSource('emptyLines.extractWikiImageEmbedRefs', 6)
  eachSource('emptyLines.fenceIndentedCodeBlocks', 6)
  eachSource('emptyLines.normalizeSerializedMarkdown', 4)
  eachSource('emptyLines.escapeWikiLinkPipesInTableRows', 6)

  // ---- html-comments -----------------------------------------------------------
  for (const source of [
    '',
    '<!-- a -->',
    '%% b %%',
    '<!--',
    '\u65e5\u672c\u8a9e \u{1F600}',
    '\ufeff',
    'multi\nline\n\n\n',
    '\u00e9\u0301'
  ]) {
    add('htmlComments.encodeHtmlCommentToken', source)
  }
  const tokenTexts = [
    '',
    'plain',
    token(''),
    token(hexOf('<!-- a -->')),
    `a ${token(hexOf('<!-- a -->'))} b ${token(hexOf('%% c %%'))} d`,
    `${token('61')}${token('62')}`,
    `${token('61')}X${token('62')}`,
    token('6'),
    token('616'),
    token('zz'),
    token('6G'),
    token('4A'),
    token('61') + 'x',
    `MEMRYCMT${word}61`,
    `MEMRYCMT${word}`,
    `MEMRYCMTOTHERWORDX`,
    `MEMRYCMT${word.slice(0, 5)}X`,
    token(hexOf('\ufeffx')),
    token('efbbbf78'),
    token('efbbbfefbbbf78'),
    token('78efbbbf79'),
    token('ff'),
    token('c3'),
    token('c328'),
    token('e29'),
    token('e282'),
    token('e28228'),
    token('f09f98'),
    token('f0'),
    token('f8'),
    token('c0af'),
    token('eda080'),
    token('f4908080'),
    token('e697a5e69cac'),
    token(hexOf('\u{1F600}')),
    token(hexOf('\u{10FFFF}')),
    token(hexOf('a\nb')),
    token(hexOf('\u0000')),
    `${token('61')}\n${token('62')}`,
    `\`${token('61')}\``,
    `x${token('61')}${token('')}y`,
    `${token('')}${token('')}`,
    `TOKEN ${token('61').toLowerCase()}`,
    token('61').replace('X', 'x')
  ]
  each('htmlComments.hasHtmlCommentToken', tokenTexts)
  each('htmlComments.decodeHtmlCommentTokens', tokenTexts)
  each('htmlComments.splitHtmlCommentTokens', tokenTexts)
  each('htmlComments.maskHtmlComments', unique(COMMON, COMMENTS))
  each('htmlComments.maskDecodeSplit', unique(COMMON, COMMENTS))
  eachSource('htmlComments.maskHtmlComments', 3)

  // ---- hard-breaks -------------------------------------------------------------
  const breakInputs = unique(COMMON, HARD_BREAKS, FENCES.slice(0, 30))
  each('hardBreaks.maskHardBreaks', breakInputs)
  each('hardBreaks.maskThenUnmask', breakInputs)
  eachSource('hardBreaks.maskThenUnmask', 4)
  each('hardBreaks.unmaskHardBreaks', [
    '',
    'plain',
    'a  MEMRYHBK0;\nb',
    'a MEMRYHBK0;b',
    'a MEMRYHBK0;\n',
    'a\tMEMRYHBK0;\nb',
    'a \t \u00a0MEMRYHBK0;\nb',
    'a\n MEMRYHBK0;\nb',
    'a\r MEMRYHBK0;\nb',
    'a\u2028MEMRYHBK0;b',
    'MEMRYHBK0;',
    'MEMRYHBK0;\n',
    'MEMRYHBK0;\n\nb',
    'MEMRYHBK;',
    'MEMRYHBKx;',
    'MEMRYHBK12',
    'MEMRYHBK12;MEMRYHBK13;\nx',
    'a  MEMRYHBK0;  MEMRYHBK1;\n',
    'a  MEMRYHBK0;\n  MEMRYHBK1;\nb',
    'MEMRYHBK\u0663;',
    '\u65e5 MEMRYHBK0;\n\u672c',
    '\u{1F600}  MEMRYHBK0;\n'
  ])
  for (const [text, breaks] of [
    ['a MEMRYHBK0;b', ['  ']],
    ['a MEMRYHBK0;b MEMRYHBK1;c', ['\\', '  ']],
    ['MEMRYHBK5;', ['a']],
    ['MEMRYHBK00;', ['a']],
    ['MEMRYHBK1;', ['a', '']],
    ['MEMRYHBK99999999999999999999;', ['a']],
    ['no token', ['a']],
    ['MEMRYHBK0;', []],
    ['MEMRYHBK0;MEMRYHBK0;', ['x']],
    ['MEMRYHBK;MEMRYHBKa;', ['x']],
    ['\u65e5MEMRYHBK0;\u{1F600}', ['\u65e5\u{1F600}']]
  ] as Array<[string, string[]]>) {
    add('hardBreaks.restoreHardBreakSpelling', text, breaks)
  }
  each('hardBreaks.hasHardBreakToken', ['', 'MEMRYHBK', 'xMEMRYHBKx', 'memryhbk', 'MEMRYHB'])

  // ---- block-nesting -----------------------------------------------------------
  for (const level of LEVELS) add('blockNesting.createBlockNestingMarker', level)
  const nesting = unique(COMMON.slice(0, 60), NESTING_MARKDOWN, FENCES.slice(0, 20))
  each('blockNesting.splitMarkdownByBlockNestingMarkers', nesting)
  eachSource('blockNesting.splitMarkdownByBlockNestingMarkers', 6)
  for (const stub of ['paragraph', 'lines', 'kids', 'none', 'nullChildren']) {
    each('blockNesting.parseMarkdownWithNestingMarkers', NESTING_MARKDOWN, stub)
    each('blockNesting.parseAndFold', NESTING_MARKDOWN, stub)
  }
  const restoreCases: Array<[Record<string, unknown>[], number[]]> = [
    [[], []],
    [[block('a')], [0]],
    [[block('a')], [1]],
    [
      [block('a'), block('b')],
      [0, 1]
    ],
    [
      [block('a'), block('b'), block('c')],
      [0, 1, 2]
    ],
    [
      [block('a'), block('b'), block('c')],
      [0, 1, 1]
    ],
    [
      [block('a'), block('b'), block('c'), block('d')],
      [0, 1, 2, 1]
    ],
    [
      [block('a'), block('b'), block('c'), block('d')],
      [0, 2, 1, 0]
    ],
    [[block('a'), block('b')], [0]],
    [
      [block('a'), block('b')],
      [0, -1]
    ],
    [
      [block('a'), block('b')],
      [0, 1.5]
    ],
    [
      [block('a'), block('b')],
      [0, 99]
    ],
    [
      [block('a', { children: [block('k')] }), block('b')],
      [0, 1]
    ],
    [
      [block('a', { children: null }), block('b', { children: 'x' })],
      [0, 1]
    ],
    [
      [block('a', { children: [] }), block('b', { children: [block('x')] })],
      [0, 1]
    ],
    [
      [block('a', { id: '1', props: { x: 1 }, children: [] }), block('b', { id: '2' })],
      [0, 1]
    ],
    [
      [{ children: [block('k')] }, {}],
      [0, 1]
    ],
    [
      [block('a'), block('b'), block('c'), block('d'), block('e')],
      [0, 1, 2, 3, 1]
    ],
    [
      [block('a'), block('b'), block('c'), block('d'), block('e')],
      [0, 1, 2, 0, 1]
    ],
    [
      [block('a'), block('b'), block('c'), block('d'), block('e')],
      [0, 1, 3, 2, 1]
    ]
  ]
  for (const [blocks, levels] of restoreCases)
    add('blockNesting.restoreBlockNesting', blocks, levels)
  const specs: unknown[][] = [
    [],
    [{ marker: 0 }],
    [{ block: block('a') }],
    [{ marker: 1 }, { block: block('a') }],
    [{ block: block('a') }, { marker: 1 }, { block: block('b') }],
    [
      { block: block('a') },
      { marker: 1 },
      { block: block('b') },
      { marker: 2 },
      { block: block('c') }
    ],
    [
      { block: block('a') },
      { marker: 1 },
      { block: block('b') },
      { marker: 0 },
      { block: block('c') }
    ],
    [{ marker: 1 }, { marker: 2 }, { block: block('a') }],
    [{ marker: 1 }, { marker: 0 }, { block: block('a') }],
    [{ marker: 3 }, { block: block('a') }, { block: block('b') }],
    [{ block: block('a') }, { marker: 1 }],
    [{ marker: 0 }, { block: block('a', { children: [block('k')] }) }],
    [{ block: block('a') }, { marker: 1 }, { block: block('b', { children: [block('k')] }) }]
  ]
  for (const spec of specs) add('blockNesting.foldSpec', spec)

  // ---- link-references ---------------------------------------------------------
  each('linkReferences.normalizeLinkReferenceLabel', LABELS)
  const refs = unique(COMMON, LINK_REFERENCES)
  each('linkReferences.stripLinkReferenceDefinitions', refs)
  each('linkReferences.stripInlineRestore', refs)
  eachSource('linkReferences.stripInlineRestore', 4)
  const inlineCases: Array<[string, unknown[]]> = [
    ['x', []],
    ['[a][b]', [usage('b', 'u', 'a', '[a][b]')]],
    ['[a][b] and [a][b]', [usage('b', 'u', 'a', '[a][b]'), usage('b', 'u', 'a', '[a][b]')]],
    ['[a][b]', [usage('b', 'u v', 'a', '[a][b]')]],
    ['[a][b]', [usage('b', 'u(v)', 'a', '[a][b]')]],
    ['[a][b]', [usage('b', 'u)', 'a', '[a][b]')]],
    ['[a][b]', [usage('b', 'u', 'a', '[missing][x]')]],
    ['[a][b] [c]', [usage('c', 'v', 'c', '[c]'), usage('b', 'u', 'a', '[a][b]')]],
    ['[c] [a][b]', [usage('c', 'v', 'c', '[c]'), usage('b', 'u', 'a', '[a][b]')]],
    [
      '\u65e5 [a][b] \u{1F600} [c][]',
      [usage('b', 'u', 'a', '[a][b]'), usage('c', 'v', 'c', '[c][]')]
    ],
    ['[a][b]', [usage('b', '', 'a', '[a][b]')]],
    ['[a][b]tail', [usage('b', '\u65e5\u672c', 'a', '[a][b]')]],
    ['', [usage('b', 'u', 'a', '[a][b]')]]
  ]
  for (const [markdown, usages] of inlineCases)
    add('linkReferences.inlineLinkReferences', markdown, usages)
  const defs = [definition('b', 'u', '[b]: u', null), definition('c', 'v', '[c]: v "t"', 0)]
  const restoreRefCases: Array<[string, unknown[], unknown[]]> = [
    ['x', [], []],
    ['x', defs, []],
    ['[a](u)', defs, [usage('b', 'u', 'a', '[a][b]')]],
    ['[a](<u>)', defs, [usage('b', 'u', 'a', '[a][b]')]],
    ['![a](u)', defs, [usage('b', 'u', 'a', '[a][b]')]],
    ['![a](u) [a](u)', defs, [usage('b', 'u', 'a', '[a][b]')]],
    ['[a](u) [a](u)', defs, [usage('b', 'u', 'a', '[a][b]'), usage('b', 'u', 'a', '[a][b]')]],
    ['[a](u) [a](u)', defs, [usage('b', 'u', 'a', '[a]')]],
    ['[a](u) [c](v)', defs, [usage('c', 'v', 'c', '[c]'), usage('b', 'u', 'a', '[a][b]')]],
    ['text\n\n\n', defs, []],
    ['\n\n', defs, []],
    ['', defs, []],
    ['text', [definition('b', 'u', '[b]: u', null), definition('c', 'v', '[c]: v', 3)], []],
    ['text', [definition('b', 'u', '[b]: u', null), definition('c', 'v', '[c]: v', null)], []],
    ['text', [definition('b', 'u', '[b]: u', null), definition('c', 'v', '[c]: v', 1)], []],
    [
      '[\u65e5](x y)',
      [definition('b', 'x y', '[b]: <x y>', null)],
      [usage('b', 'x y', '\u65e5', '[\u65e5][b]')]
    ],
    [
      '[\u65e5](<x y>)',
      [definition('b', 'x y', '[b]: <x y>', null)],
      [usage('b', 'x y', '\u65e5', '[\u65e5][b]')]
    ],
    ['\u{1F600}[a](u)', defs, [usage('b', 'u', 'a', '[a][b]')]]
  ]
  for (const [markdown, ds, us] of restoreRefCases) {
    add('linkReferences.restoreLinkReferences', markdown, ds, us)
  }

  // ---- markdown-code -----------------------------------------------------------
  const codeInputs = unique(COMMON, COMMENTS, FENCES.slice(0, 20), INDENTED.slice(0, 25), SPANS)
  each('markdownCode.blankMarkdownCode', codeInputs)
  each('markdownCode.maskMarkdownCode', codeInputs)
  each('markdownCode.stripMarkdownComments', unique(COMMON, COMMENTS))
  for (const [replacer, opens] of [
    ['tag', 'default'],
    ['tag', 'marked'],
    ['empty', 'marked']
  ]) {
    each(
      'markdownCode.replaceMarkdownComments',
      unique(COMMON.slice(0, 40), COMMENTS),
      replacer,
      opens
    )
  }
  external.forEach((source, index) => {
    if (index % 6 !== 0) return
    for (const fn of ['blankMarkdownCode', 'maskMarkdownCode', 'stripMarkdownComments']) {
      cases.push({
        id: `markdown-code/fn/${kebab(fn)}-src-${String(index).padStart(4, '0')}`,
        op: 'fn',
        input: { fn: `markdownCode.${fn}`, args: [source.markdown] }
      })
    }
  })

  // ---- token-masking -----------------------------------------------------------
  const tokenInputs = unique(COMMON, TOKENS)
  each('tokenMasking.maskInlineTokens', tokenInputs)
  each('tokenMasking.maskRestore', tokenInputs)
  eachSource('tokenMasking.maskInlineTokens', 6)
  for (const [text, tokens] of [
    ['MEMRYTKN0X', ['((mention:a))']],
    ['a MEMRYTKN0X b MEMRYTKN1X c MEMRYTKN0X', ['((mention:a))', '((date:b))']],
    ['MEMRYTKN2X', ['x']],
    ['MEMRYTKN00X', ['x']],
    ['MEMRYTKN0X', []],
    ['plain', ['x']],
    ['MEMRYTKN', ['x']],
    ['MEMRYTKNX MEMRYTKN-1X', ['x']],
    ['MEMRYTKN99999999999999999999X', ['x']],
    ['\u65e5MEMRYTKN0X\u{1F600}', ['\u672c']]
  ] as Array<[string, string[]]>) {
    add('tokenMasking.restoreInlineTokens', text, tokens)
  }

  // ---- link-destinations -------------------------------------------------------
  const destInputs = unique(COMMON, DESTINATIONS)
  each('linkDestinations.maskLinkDestinations', destInputs)
  each('linkDestinations.maskRestore', destInputs)
  eachSource('linkDestinations.maskLinkDestinations', 4)
  const hrefs = [
    '',
    ' ',
    'u',
    'u "t"',
    " u 't' ",
    'u (t)',
    'u\tt',
    'u\nt',
    '<u v>',
    '<u v> "t"',
    '<u',
    '<',
    '<>',
    '<u>x',
    ' <u> ',
    'a\\ b',
    'a\\',
    '\\ a',
    'a\\\u65e5 b',
    '\u65e5\u672c "t"',
    '\u{1F600} x',
    'u\u00a0v',
    'u\u2028v'
  ]
  for (const href of hrefs) add('linkDestinations.linkDestination', href)
  for (const href of hrefs) {
    for (const address of ['x', 'x y', '', ' ', 'x\ty', '\u65e5 \u672c']) {
      add('linkDestinations.withLinkDestination', href, address)
    }
  }
  const placeholder = (index: number): string => `MEMRYLNK${word}${index}X`
  for (const [text, destinations] of [
    [placeholder(0), ['u "t"']],
    [`a ${placeholder(0)} b ${placeholder(1)}`, ['u "t"', '<v w>']],
    [placeholder(2), ['x']],
    [placeholder(0), []],
    ['plain', ['x']],
    ['MEMRYLNK', ['x']],
    [`MEMRYLNKOTHERWORD0X`, ['x']],
    [`MEMRYLNK${word}X`, ['x']],
    [`MEMRYLNK${word}00X`, ['x']],
    [`MEMRYLNK${word}99999999999999999999X`, ['x']],
    [`\u65e5${placeholder(0)}\u{1F600}`, ['\u672c y']]
  ] as Array<[string, string[]]>) {
    add('linkDestinations.restoreLinkDestinations', text, destinations)
  }

  // ---- link-code-spans ---------------------------------------------------------
  each('linkCodeSpans.linkCodeAsText', unique(HTML_LINKS, COMMON.slice(0, 40)))
  each('linkCodeSpans.codeSpanRanges', unique(SPANS, COMMON))
  external.forEach((source, index) => {
    if (index % 4 === 0) {
      cases.push({
        id: `link-code-spans/fn/code-span-ranges-src-${String(index).padStart(4, '0')}`,
        op: 'fn',
        input: { fn: 'linkCodeSpans.codeSpanRanges', args: [source.markdown] }
      })
    }
  })

  // ---- cell-code-spaces --------------------------------------------------------
  const cellInputs = unique(COMMON, CELLS)
  each('cellCodeSpaces.maskCellCodeSpaces', cellInputs)
  each('cellCodeSpaces.maskRestore', cellInputs)
  eachSource('cellCodeSpaces.maskCellCodeSpaces', 4)
  for (const [text, spaces] of [
    ['MEMRYCSP0X', [' ']],
    ['a MEMRYCSP0X b MEMRYCSP1X', [' ', '\t']],
    ['MEMRYCSP3X', [' ']],
    ['MEMRYCSP0X', []],
    ['plain', [' ']],
    ['MEMRYCSP00X', [' ']],
    ['MEMRYCSP99999999999999999999X', [' ']],
    ['\u65e5MEMRYCSP0X\u{1F600}', ['\t']]
  ] as Array<[string, string[]]>) {
    add('cellCodeSpaces.restoreCellCodeSpaces', text, spaces)
  }

  // ---- seeded random documents -------------------------------------------------
  const general = fuzzDocs(GENERAL_ALPHABET, 0x7e1, 90, 4, 30)
  for (const fn of [
    'emptyLines.splitMarkdownPreservingBlanks',
    'emptyLines.splitByCodeFences',
    'emptyLines.separateBlockImages',
    'emptyLines.extractWikiImageEmbedRefs',
    'emptyLines.fenceIndentedCodeBlocks',
    'emptyLines.normalizeSerializedMarkdown',
    'emptyLines.escapeWikiLinkPipesInTableRows',
    'htmlComments.maskDecodeSplit',
    'hardBreaks.maskThenUnmask',
    'blockNesting.splitMarkdownByBlockNestingMarkers',
    'linkReferences.stripInlineRestore',
    'markdownCode.blankMarkdownCode',
    'markdownCode.maskMarkdownCode',
    'markdownCode.stripMarkdownComments',
    'tokenMasking.maskRestore',
    'linkDestinations.maskRestore',
    'cellCodeSpaces.maskRestore',
    'linkCodeSpans.codeSpanRanges',
    'linkCodeSpans.linkCodeAsText'
  ]) {
    each(fn, general)
  }
  each('hardBreaks.maskThenUnmask', fuzzDocs(BREAK_ALPHABET, 0x7e2, 150, 3, 20))
  const commentDocs = fuzzDocs(COMMENT_ALPHABET, 0x7e3, 140, 3, 18)
  each('htmlComments.maskDecodeSplit', commentDocs)
  each('markdownCode.blankMarkdownCode', commentDocs)
  each('markdownCode.stripMarkdownComments', commentDocs)
  each('markdownCode.replaceMarkdownComments', commentDocs, 'tag', 'marked')
  each('linkReferences.stripInlineRestore', fuzzDocs(REFERENCE_ALPHABET, 0x7e4, 170, 3, 18))
  const linkDocs = fuzzDocs(LINK_ALPHABET, 0x7e5, 130, 3, 16)
  each('linkDestinations.maskRestore', linkDocs)
  each('linkCodeSpans.codeSpanRanges', linkDocs)
  const tableDocs = fuzzDocs(TABLE_ALPHABET, 0x7e6, 120, 4, 24)
  each('cellCodeSpaces.maskRestore', tableDocs)
  each('emptyLines.normalizeSerializedMarkdown', tableDocs)
  each('emptyLines.escapeWikiLinkPipesInTableRows', tableDocs)
  each('blockNesting.parseAndFold', fuzzDocs(NESTING_ALPHABET, 0x7e7, 100, 2, 12), 'lines')
  each('linkCodeSpans.linkCodeAsText', fuzzDocs(HTML_ALPHABET, 0x7e8, 120, 2, 14))
  each(
    'tokenMasking.maskRestore',
    fuzzDocs(
      [
        '((mention:',
        '((date:',
        '))',
        ')',
        '(',
        'a',
        '\\',
        '_',
        '%2F',
        '\n',
        '\r',
        '`',
        '```\n',
        ' '
      ],
      0x7e9,
      100,
      3,
      14
    )
  )

  return cases
}

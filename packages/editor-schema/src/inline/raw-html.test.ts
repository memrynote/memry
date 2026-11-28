import { describe, expect, it } from 'vitest'
import { encodeHtmlCommentToken } from '@memry/shared/html-comments'
import {
  RAW_HTML_BOUND,
  RAW_HTML_MAX_NESTING as CAP,
  maskRawHtml,
  restoreRawHtml,
  scanRawHtml,
  spelledTags
} from './raw-html'

/** The source of each range the scan hides in `markdown`. */
function hidden(markdown: string): string[] {
  return scanRawHtml(markdown, true).map(({ start, end }) => markdown.slice(start, end))
}

describe('scanRawHtml', () => {
  it.each([
    ['<kbd>Ctrl</kbd>', ['<kbd>', '</kbd>']],
    ['a <x-y> b', ['<x-y>']],
    ['<KBD>', ['<KBD>']],
    ['<kq a="1 2" b=\'3\' c=4 d>', ['<kq a="1 2" b=\'3\' c=4 d>']],
    ['<kq/> <kq />', ['<kq/>', '<kq />']],
    ['<!x>', ['<!x>']],
    ['<?x?>', ['<?x?>']],
    ['<![CDATA[x]]>', ['<![CDATA[x]]>']],
    [
      '<div> <p> <details> <summary>s</summary> <article>',
      ['<div>', '<p>', '<details>', '<summary>', '</summary>', '<article>']
    ],
    ['<script>kq9</script>', ['<script>', '</script>']],
    ['<input type=text>', ['<input type=text>']],
    ['<x a="*b*">', ['<x a="*b*">']],
    ['\\<kq>', ['<kq>']],
    ['<x a="<kbd>">', ['<x a="<kbd>">']]
  ])('hides each whole tag of %j', (markdown, expected) => {
    expect(hidden(markdown)).toEqual(expected)
  })

  it.each([
    'b strong i em u s del strike code a img br'
      .split(' ')
      .flatMap((name) => [
        `<${name}>`,
        `</${name}>`,
        `<${name.toUpperCase()}>`,
        `<${name} x="y">`,
        `<${name}/>`
      ]),
    ['<span style="color:red">x</span>', '<span style=x>y</span>', '<span STYLE>y</span>'],
    ['<details data-memry-toggle>', '<details open data-memry-toggle>'],
    ['<input type=checkbox>', '<input checked type="checkbox">', '<input type=CHECKBOX>']
  ])('leaves a tag the editor handles: %j', (...tags) => {
    for (const tag of tags) expect(hidden(`a ${tag} b`)).toEqual([])
  })

  it('pairs a closing span with the innermost open span', () => {
    expect(hidden('<span style="c">a</span>')).toEqual([])
    expect(hidden('<span>a</span>')).toEqual(['<span>', '</span>'])
    expect(hidden('<span style="c"><span>a</span></span>')).toEqual(['<span>', '</span>'])
    expect(hidden('</span> <span style="c">a</span> </span>')).toEqual(['</span>', '</span>'])
    expect(hidden('<span/> </span>')).toEqual(['<span/>', '</span>'])
  })

  it('hides only the angle bracket of a tag it cannot read whole', () => {
    expect(hidden('<kq\nb>')).toEqual(['<'])
    expect(hidden('a <div')).toEqual(['<'])
    expect(hidden('a <?x')).toEqual(['<'])
    expect(hidden('a <![CDATA[x')).toEqual(['<'])
    expect(hidden('<kq a=>')).toEqual(['<'])
    expect(hidden('<kq a="x>')).toEqual(['<'])
    expect(hidden('<kq a="1"b="2">')).toEqual(['<'])
    expect(hidden('<!1>')).toEqual(['<'])
    expect(hidden('<https://e.com> <a@b.co>')).toEqual(['<', '<'])
    expect(hidden('<details>\nx')).toEqual(['<details>'])
    expect(hidden('<span\nstyle="c">')).toEqual(['<'])
    expect(hidden('<details data-memry-toggle\n>')).toEqual(['<'])
  })

  it('hides only the angle bracket of a tag with a pipe in it', () => {
    expect(hidden('<x a="|">')).toEqual(['<'])
    expect(hidden('| <x a="b"> | <y> |')).toEqual(['<x a="b">', '<y>'])
  })

  it.each([
    '< kq>',
    '<1>',
    '<>',
    '</>',
    '</ kq>',
    '<!-- c -->',
    '<!--',
    'a < b',
    'a<',
    '<<',
    '1 <= 2',
    '<-',
    '<='
  ])('leaves %j, which opens no construct', (markdown) => {
    expect(hidden(markdown)).toEqual([])
  })

  it('leaves a tag that is not text: in a fence, in a code span, or opening a link address', () => {
    expect(hidden('```\n<kbd>\n```')).toEqual([])
    expect(hidden('~~~js\n<kbd>\n~~~\n<kbd>')).toEqual(['<kbd>'])
    expect(hidden('`<kbd>` `` <x> `` <kbd>')).toEqual(['<kbd>'])
    expect(hidden('[a](<x>) [b](  <y z>) ![c](<w>)')).toEqual([])
    expect(hidden('[a](u<x>)')).toEqual(['<x>'])
    expect(hidden('x](<kbd>)')).toEqual(['<kbd>'])
    expect(hidden('\\[a\\](<kbd>)')).toEqual(['<kbd>'])
    expect(hidden('[a [b](<x>) c](<y>)')).toEqual([])
  })

  it('reads a backtick that does not close, or is escaped, as text', () => {
    expect(hidden('a ` <kbd>')).toEqual(['<kbd>'])
    expect(hidden('a \\`<kbd>\\` b')).toEqual(['<kbd>'])
    expect(hidden('a `` <kbd> ` b')).toEqual(['<kbd>'])
    expect(hidden('a `<kbd>` b <kbd>')).toEqual(['<kbd>'])
  })

  it('reads a tag before a backtick whole, as the parser does', () => {
    expect(hidden('<x a="`"> `b`')).toEqual(['<x a="`">'])
  })

  it('keeps the open spans across lines', () => {
    expect(hidden('<span>\nb\n</span>')).toEqual(['<span>', '</span>'])
  })

  it('reads a tag whole only within the bound', () => {
    const fits = `<x a="${'y'.repeat(RAW_HTML_BOUND - 9)}">`
    expect(fits).toHaveLength(RAW_HTML_BOUND - 1)
    expect(hidden(fits)).toEqual([fits])
    const exact = `<x a="${'y'.repeat(RAW_HTML_BOUND - 8)}">`
    expect(exact).toHaveLength(RAW_HTML_BOUND)
    expect(hidden(exact)).toEqual([exact])
    expect(hidden(`<x a="${'y'.repeat(RAW_HTML_BOUND - 7)}">`)).toEqual(['<'])
  })

  it('counts the bound in UTF-16 units', () => {
    const fill = '😀'.repeat((RAW_HTML_BOUND - 8) / 2)
    const tag = `<x a="${fill}">`
    expect(tag).toHaveLength(RAW_HTML_BOUND)
    expect(hidden(tag)).toEqual([tag])
    expect(hidden(`<x a="${fill}😀">`)).toEqual(['<'])
  })

  it.each([
    '<a '.repeat(200_000),
    '<x a="'.repeat(100_000),
    '<x a=\'"'.repeat(100_000),
    '<!'.repeat(200_000),
    '<?'.repeat(200_000),
    '<![CDATA['.repeat(100_000),
    `<x ${'a '.repeat(100_000)}`,
    '`<x '.repeat(100_000),
    `${'`'.repeat(1000)} <x a="`
  ])('reads a long line of unfinished constructs in linear time (%#)', (markdown) => {
    const started = performance.now()
    scanRawHtml(markdown, true)
    expect(performance.now() - started).toBeLessThan(2000)
  })
})

describe('the nesting cap', () => {
  it('hides a handled tag opened past the cap, and the closing tag of that one', () => {
    const text = `${'<b>'.repeat(CAP + 1)}x${'</b>'.repeat(CAP + 1)}`
    const [open, close, ...rest] = scanRawHtml(text, true)
    expect(rest).toEqual([])
    expect(text.slice(open.start, open.end)).toBe('<b>')
    expect(open.start).toBe(CAP * 3)
    // The first closing tag closes the innermost open tag, the one the cap hid.
    expect(text.slice(close.start, close.end)).toBe('</b>')
    expect(close.start).toBe((CAP + 1) * 3 + 1)
  })

  it('keeps every tag of a text that nests no deeper than the cap', () => {
    expect(hidden(`${'<b>'.repeat(CAP)}x${'</b>'.repeat(CAP)}`)).toEqual([])
    expect(hidden('<b>x</b>'.repeat(50 * CAP))).toEqual([])
  })

  it('counts every kind of handled tag together, and across lines', () => {
    const text = '<b><i><u><s><code>\n'.repeat(21)
    expect(hidden(text)).toEqual(['<b>', '<i>', '<u>', '<s>', '<code>'])
  })

  it('counts a span with a style, and pairs its closing tag with it', () => {
    const text = `${'<span style="c">'.repeat(CAP + 1)}x${'</span>'.repeat(CAP + 1)}`
    expect(hidden(text)).toEqual(['<span style="c">', '</span>'])
  })

  it('counts a tag that closes on a later line, and hides only its angle bracket', () => {
    expect(hidden('<b\n'.repeat(CAP + 1))).toEqual(['<'])
    expect(hidden(`${'<b '.repeat(CAP)}<b\n`)).toEqual(['<'])
  })

  it('counts a self-closing tag, which the HTML parse opens', () => {
    expect(hidden('<b/>'.repeat(CAP + 1))).toEqual(['<b/>'])
  })

  it('does not count a tag that holds nothing', () => {
    expect(hidden('<br><img src=a><hr><input type=checkbox><br/>'.repeat(5 * CAP))).toEqual([])
  })

  it('reads a closing tag that closes nothing as it was', () => {
    expect(hidden(`${'</b>'.repeat(5 * CAP)}<b>`)).toEqual([])
  })

  it('counts nothing in text read as a run, which the writer spells, and escapes each', () => {
    const spans = scanRawHtml('<b>'.repeat(5 * CAP), false)
    expect(spans).toHaveLength(5 * CAP)
    expect(spans.every((span) => span.escaped)).toBe(true)
  })

  it('counts no escaped tag in a note', () => {
    expect(scanRawHtml('\\<b>'.repeat(5 * CAP), true).every((span) => span.escaped)).toBe(true)
    expect(hidden(`${'\\<b>'.repeat(5 * CAP)}<b>x</b>`)).toHaveLength(5 * CAP)
  })
})

describe('spelledTags', () => {
  it('finds each tag a run spells whole, and not a lone angle bracket', () => {
    const text = 'a <x a="*"> b <y c="_"> < d <e'
    expect(spelledTags(text).map(({ start, end }) => text.slice(start, end))).toEqual([
      '<x a="*">',
      '<y c="_">'
    ])
  })

  it('reads text as it is, not as markdown', () => {
    const text = 'a `<x a="*">` [b](<y>)'
    expect(spelledTags(text).map(({ start, end }) => text.slice(start, end))).toEqual([
      '<x a="*">',
      '<y>'
    ])
  })
})

describe('a backslash before a handled tag', () => {
  /** What each hidden range of `markdown` is, and whether it is escaped. */
  const ranges = (markdown: string): Array<[string, boolean]> =>
    scanRawHtml(markdown, true).map(({ start, end, escaped }) => [
      markdown.slice(start, end),
      escaped === true
    ])

  it.each([
    [
      '\\<b>x\\</b>',
      [
        ['<b>', true],
        ['</b>', true]
      ]
    ],
    ['\\<a href="u">', [['<a href="u">', true]]],
    ['\\<br/>', [['<br/>', true]]],
    ['\\<details data-memry-toggle>', []],
    [
      '\\<span style="color:red">x\\</span>',
      [
        ['<span style="color:red">', true],
        ['</span>', true]
      ]
    ],
    ['\\<span>', [['<span>', true]]],
    ['\\<input type=checkbox>', [['<input type=checkbox>', true]]],
    ['\\\\<b>', []],
    ['\\\\\\<b>', [['<b>', true]]],
    ['\\<kq>', [['<kq>', false]]],
    ['\\</details>', [['</details>', false]]],
    ['\\<input type=text>', [['<input type=text>', false]]],
    ['\\<b x', []],
    ['\\<kq x', [['<', false]]],
    ['\\<b a="|">', [['<', true]]],
    ['`\\<b>`', []],
    ['```\n\\<b>\n```', []]
  ] as Array<[string, Array<[string, boolean]>]>)('hides the tag in %j', (markdown, expected) => {
    expect(ranges(markdown)).toEqual(expected)
  })
})

describe('a comment token inside a hidden tag', () => {
  it('is written back as the comment when it is on one line, and stays a token otherwise', () => {
    const one = encodeHtmlCommentToken('<!-- c -->')
    const lines = encodeHtmlCommentToken('<!-- m\nn -->')
    const obsidian = encodeHtmlCommentToken('%% o %%')
    const { sources } = maskRawHtml(`<kq a="${one}"> <kq a="${lines}"> <kq a="${obsidian}"> <kq>`)
    expect(sources).toEqual([
      '<kq a="<!-- c -->">',
      `<kq a="${lines}">`,
      `<kq a="${obsidian}">`,
      '<kq>'
    ])
  })
})

describe('maskRawHtml and restoreRawHtml', () => {
  it('takes the backslash of an escaped tag and gives the tag back as text', () => {
    const { markdown, sources } = maskRawHtml('a \\<b>x\\</b> \\\\ \\<kq>')
    expect(markdown).toMatch(
      /^a ;MEMRYRAW[A-Z]{12}0;x;MEMRYRAW[A-Z]{12}1; \\\\ \\;MEMRYRAW[A-Z]{12}2;$/
    )
    expect(sources).toEqual(['<b>', '</b>', '<kq>'])
  })

  it('hides every tag and gives it back', () => {
    const markdown = 'a <kbd>Ctrl</kbd> and <x a="*b*"> or <div and <script>kq9</script>'
    const { markdown: masked, sources } = maskRawHtml(markdown)
    expect(masked).not.toContain('<')
    expect(masked).toMatch(/^a ;MEMRYRAW[A-Z]{12}0;Ctrl;MEMRYRAW[A-Z]{12}1; and /)
    expect(sources).toEqual(['<kbd>', '</kbd>', '<x a="*b*">', '<', '<script>', '</script>'])
    expect(restoreRawHtml(masked, sources)).toBe(markdown)
  })

  it('bounds a token with characters that are no markup, no word and no space', () => {
    const { markdown: masked } = maskRawHtml('a_<kbd>_b *<x>* ~<y>~')
    expect(masked.match(/;MEMRYRAW[A-Z]{12}\d+;/g)).toHaveLength(3)
    expect(masked.replace(/MEMRYRAW[A-Z]{12}\d+/g, '')).toBe('a_;;_b *;;* ~;;~')
  })

  it('returns the text itself when nothing is hidden', () => {
    const markdown = 'plain <b>text</b> `<kbd>`'
    expect(maskRawHtml(markdown)).toEqual({ markdown, sources: [] })
    expect(restoreRawHtml('MEMRYRAW0', [])).toBe('MEMRYRAW0')
  })

  it('leaves a placeholder-shaped text that no token matches', () => {
    expect(restoreRawHtml(';MEMRYRAWABCDEFGHIJKL0;', ['<x>'])).toBe(';MEMRYRAWABCDEFGHIJKL0;')
  })
})

import type { MarkdownSource } from './cases-bn'
import type { OracleCase } from './cases-frontmatter'
import { memryParseCases } from './cases-parse'

/**
 * Inputs of `serialize.json`: the block serializer of the converter
 * (`serializeBlocks`). `serialize-seed` cases run it on the blocks
 * `prepareFragmentSeed` builds from the same markdown as `memry-parse.json`;
 * `serialize-blocks` cases hand it blocks directly, for the shapes markdown
 * cannot make (every prop of every block type, inline specs, table spans).
 * Expected outputs come from the oracle; nothing here states an answer.
 */

type Json = Record<string, unknown>
type Styles = Record<string, unknown>

const t = (text: string, styles: Styles = {}): Json => ({ type: 'text', text, styles })
const link = (href: string, content: unknown): Json => ({ type: 'link', href, content })
const inline = (type: string, props: Json): Json => ({ type, props })

function block(type: string, content?: unknown, props: Json = {}, children: Json[] = []): Json {
  const out: Json = { type, props, children }
  if (content !== undefined) out.content = typeof content === 'string' ? [t(content)] : content
  return out
}

const table = (rows: unknown[][], extra: Json = {}): Json =>
  block('table', {
    type: 'tableContent',
    rows: rows.map((cells) => ({ cells })),
    ...extra
  })

function add(cases: OracleCase[], slug: string, blocks: Json[]): void {
  cases.push({
    id: `serialize-blocks/serialize-blocks/${slug}`,
    op: 'serialize-blocks',
    input: { blocks }
  })
}

function textBlocks(cases: OracleCase[]): void {
  add(cases, 'empty-list', [])
  add(cases, 'paragraph', [block('paragraph', 'Hello world')])
  add(cases, 'paragraph-empty', [block('paragraph', [])])
  add(cases, 'paragraph-no-content', [block('paragraph')])
  add(cases, 'paragraph-empty-string', [block('paragraph', '')])
  add(cases, 'two-paragraphs', [block('paragraph', 'a'), block('paragraph', 'b')])
  add(cases, 'empty-between', [
    block('paragraph', 'a'),
    block('paragraph', []),
    block('paragraph', 'b')
  ])
  for (const level of [1, 2, 3, 4, 5, 6])
    add(cases, `heading-${level}`, [block('heading', 'Title', { level })])
  add(cases, 'heading-default-level', [block('heading', 'Title')])
  add(cases, 'heading-toggle', [
    block('heading', 'T', { level: 2, isToggleable: true }, [block('paragraph', 'inside')])
  ])
  add(cases, 'heading-toggle-empty', [block('heading', [], { level: 1, isToggleable: true })])
  add(cases, 'quote', [block('quote', 'A quote')])
  add(cases, 'quote-multiline', [block('quote', [t('one\ntwo')])])
  add(cases, 'quote-empty', [block('quote', [])])
  add(cases, 'divider', [block('paragraph', 'a'), block('divider'), block('paragraph', 'b')])
  add(cases, 'code', [block('codeBlock', [t('let a = 1\nlet b = 2')], { language: 'ts' })])
  add(cases, 'code-no-language', [block('codeBlock', [t('x')])])
  add(cases, 'code-empty', [block('codeBlock', [], { language: 'js' })])
  add(cases, 'code-backticks', [block('codeBlock', [t('a ``` b\n````')], { language: '' })])
  add(cases, 'code-trailing-newline', [block('codeBlock', [t('a\n')], { language: 'sh' })])
  add(cases, 'code-leading-newline', [block('codeBlock', [t('\na')], { language: 'sh' })])
  add(cases, 'code-marks-dropped', [
    block('codeBlock', [t('a', { bold: true })], { language: 'sh' })
  ])
  add(cases, 'diagram', [block('diagram', [t('graph TD\nA-->B')])])
  add(cases, 'diagram-empty', [block('diagram', [])])
  add(cases, 'math', [block('mathBlock', undefined, { latex: 'x^2\n+ y' })])
  add(cases, 'math-empty', [block('mathBlock')])
  add(cases, 'hard-break', [block('paragraph', [t('a\nb'), t(' c\n\nd')])])
  add(cases, 'leading-trailing-break', [block('paragraph', [t('\na\n')])])
  add(cases, 'special-characters', [block('paragraph', 'a * b _ c # d [e] <f> & g | h \\ i ` j')])
  add(cases, 'nbsp-and-unicode', [block('paragraph', 'a\u00a0b \u2028 c \ufeff d é 😀')])
  add(cases, 'html-text', [block('paragraph', '<b>not bold</b> &amp; <!-- no -->')])
  add(cases, 'placeholder-char', [block('paragraph', 'a\ufffcb')])
}

function styleCases(cases: OracleCase[]): void {
  const names = ['bold', 'italic', 'underline', 'strike', 'code']
  for (const name of names)
    add(cases, `style-${name}`, [block('paragraph', [t('a '), t('b', { [name]: true }), t(' c')])])
  add(cases, 'style-bold-italic', [block('paragraph', [t('x', { bold: true, italic: true })])])
  add(cases, 'style-all', [
    block('paragraph', [
      t('x', { bold: true, italic: true, underline: true, strike: true, code: true })
    ])
  ])
  add(cases, 'style-order-irrelevant', [block('paragraph', [t('x', { strike: true, bold: true })])])
  add(cases, 'style-false-ignored', [block('paragraph', [t('x', { bold: false })])])
  add(cases, 'style-colors', [
    block('paragraph', [t('x', { textColor: 'red', backgroundColor: 'blue' })])
  ])
  add(cases, 'style-color-default', [block('paragraph', [t('x', { textColor: 'default' })])])
  add(cases, 'style-color-with-bold', [
    block('paragraph', [t('x', { textColor: '#ff0000', bold: true })])
  ])
  add(cases, 'style-underline-run', [
    block('paragraph', [t('a', { underline: true }), t('b', { underline: true })])
  ])
  add(cases, 'style-unknown', [block('paragraph', [t('x', { sparkle: true })])])
  add(cases, 'emphasis-nested', [
    block('paragraph', [
      t('alpha ', { bold: true }),
      t('x y', { bold: true, italic: true }),
      t(' omega', { bold: true })
    ])
  ])
  add(cases, 'emphasis-edge-space', [block('paragraph', [t('bold ', { bold: true }), t('after')])])
  add(cases, 'emphasis-leading-space', [block('paragraph', [t('a'), t(' bold', { bold: true })])])
  add(cases, 'emphasis-only-space', [block('paragraph', [t('a'), t(' ', { bold: true }), t('b')])])
  add(cases, 'emphasis-strike-italic', [
    block('paragraph', [t('a', { strike: true, italic: true }), t('b', { strike: true })])
  ])
  add(cases, 'emphasis-breaks', [block('paragraph', [t('a\nb', { bold: true })])])
  add(cases, 'emphasis-code-span', [
    block('paragraph', [
      t('a', { bold: true }),
      t(' x ', { bold: true }),
      t('c', { code: true, bold: true })
    ])
  ])
  add(cases, 'emphasis-two-runs', [
    block('paragraph', [t('a', { bold: true }), t('-'), t('b', { bold: true })])
  ])
  add(cases, 'emphasis-run-of-three', [
    block('paragraph', [
      t('a', { italic: true }),
      t('b', { italic: true, bold: true }),
      t('c', { italic: true })
    ])
  ])
}

function linkCases(cases: OracleCase[]): void {
  add(cases, 'link', [block('paragraph', [link('https://example.com', [t('site')])])])
  add(cases, 'link-string-content', [block('paragraph', [link('https://example.com', 'site')])])
  add(cases, 'link-bare-url', [
    block('paragraph', [link('https://example.com', [t('https://example.com')])])
  ])
  add(cases, 'link-empty-text', [block('paragraph', [link('https://example.com', [])])])
  add(cases, 'link-styled', [
    block('paragraph', [link('https://e.com', [t('a '), t('b', { bold: true }), t(' c')])])
  ])
  add(cases, 'link-all-bold', [
    block('paragraph', [
      link('https://e.com', [t('a', { bold: true }), t('b', { bold: true, italic: true })])
    ])
  ])
  add(cases, 'link-with-break', [block('paragraph', [link('https://e.com', [t('a\nb')])])])
  add(cases, 'link-bold-break', [
    block('paragraph', [
      link('https://e.com', [t('a', { bold: true }), t('\n'), t('b', { bold: true })])
    ])
  ])
  add(cases, 'link-in-list-break', [block('bulletListItem', [link('https://e.com', [t('a\nb')])])])
  add(cases, 'link-parens-balanced', [block('paragraph', [link('https://e.com/a(b)c', [t('x')])])])
  add(cases, 'link-parens-unbalanced', [block('paragraph', [link('https://e.com/a(b', [t('x')])])])
  add(cases, 'link-parens-escaped', [
    block('paragraph', [link('https://e.com/a\\(b\\)', [t('x')])])
  ])
  add(cases, 'link-href-space', [block('paragraph', [link('https://e.com/a b "title"', [t('x')])])])
  add(cases, 'link-href-angle', [block('paragraph', [link('<https://e.com>', [t('x')])])])
  add(cases, 'link-code-span-text', [
    block('paragraph', [link('https://e.com', [t('see `a*b` here')])])
  ])
  add(cases, 'link-empty-href', [block('paragraph', [link('', [t('x')])])])
  add(cases, 'link-adjacent', [
    block('paragraph', [link('https://a.com', [t('a')]), link('https://b.com', [t('b')])])
  ])
}

function listCases(cases: OracleCase[]): void {
  add(cases, 'bullets', [block('bulletListItem', 'a'), block('bulletListItem', 'b')])
  add(cases, 'numbered', [block('numberedListItem', 'a'), block('numberedListItem', 'b')])
  add(cases, 'numbered-start', [
    block('numberedListItem', 'a', { start: 5 }),
    block('numberedListItem', 'b')
  ])
  add(cases, 'numbered-start-one', [block('numberedListItem', 'a', { start: 1 })])
  add(cases, 'numbered-start-zero', [block('numberedListItem', 'a', { start: 0 })])
  add(cases, 'checks', [
    block('checkListItem', 'a', { checked: false }),
    block('checkListItem', 'b', { checked: true })
  ])
  add(cases, 'check-plain', [
    block('checkListItem', 'a', { plain: true }),
    block('checkListItem', [], { plain: true })
  ])
  add(cases, 'toggle-item', [
    block('toggleListItem', 't', { open: true }, [block('paragraph', 'body')])
  ])
  add(cases, 'mixed-lists', [
    block('bulletListItem', 'a'),
    block('numberedListItem', 'b'),
    block('checkListItem', 'c')
  ])
  add(cases, 'nested-bullets', [
    block('bulletListItem', 'a', {}, [
      block('bulletListItem', 'b', {}, [block('bulletListItem', 'c')])
    ])
  ])
  add(cases, 'nested-numbered', [
    block('numberedListItem', 'a', {}, [
      block('numberedListItem', 'b'),
      block('numberedListItem', 'c')
    ])
  ])
  add(cases, 'nested-mixed', [
    block('bulletListItem', 'a', {}, [
      block('numberedListItem', 'b', {}, [block('checkListItem', 'c')])
    ])
  ])
  add(cases, 'list-child-paragraph', [block('bulletListItem', 'a', {}, [block('paragraph', 'p')])])
  add(cases, 'list-child-code', [
    block('bulletListItem', 'a', {}, [block('codeBlock', [t('x')], { language: 'js' })])
  ])
  add(cases, 'list-child-quote', [block('bulletListItem', 'a', {}, [block('quote', 'q')])])
  add(cases, 'list-child-then-list', [
    block('bulletListItem', 'a', {}, [block('paragraph', 'p'), block('bulletListItem', 'b')])
  ])
  add(cases, 'list-child-table', [
    block('bulletListItem', 'a', {}, [table([[[t('h')]], [[t('v')]]])])
  ])
  add(cases, 'list-empty-items', [block('bulletListItem', []), block('bulletListItem', 'a')])
  add(cases, 'list-then-paragraph', [
    block('bulletListItem', 'a'),
    block('paragraph', 'p'),
    block('bulletListItem', 'b')
  ])
  add(cases, 'paragraph-children', [
    block('paragraph', 'a', {}, [block('paragraph', 'child'), block('bulletListItem', 'li')])
  ])
  add(cases, 'quote-children', [block('quote', 'a', {}, [block('paragraph', 'child')])])
  add(cases, 'task-nested-in-list', [
    block('bulletListItem', 'a', {}, [
      block('taskBlock', undefined, { taskId: 't1', title: 'Do it', checked: true })
    ])
  ])
}

function tableCases(cases: OracleCase[]): void {
  const c = (s: string, styles: Styles = {}): unknown[] => [t(s, styles)]
  add(cases, 'table-basic', [
    table([
      [c('a'), c('b')],
      [c('c'), c('d')]
    ])
  ])
  add(cases, 'table-header-row', [
    table(
      [
        [c('a'), c('b')],
        [c('c'), c('d')]
      ],
      { headerRows: 1 }
    )
  ])
  add(cases, 'table-header-col', [
    table(
      [
        [c('a'), c('b')],
        [c('c'), c('d')]
      ],
      { headerCols: 1 }
    )
  ])
  add(cases, 'table-header-both', [
    table(
      [
        [c('a'), c('b')],
        [c('c'), c('d')]
      ],
      { headerRows: 1, headerCols: 1 }
    )
  ])
  add(cases, 'table-widths', [table([[c('a'), c('b')]], { columnWidths: [100, undefined] })])
  add(cases, 'table-pipe', [table([[c('a|b'), c('c')]], { headerRows: 1 })])
  add(cases, 'table-long-cell', [
    table(
      [
        [c('x'.repeat(30)), c('y')],
        [c('é'.repeat(12)), c('😀😀😀😀😀😀')]
      ],
      { headerRows: 1 }
    )
  ])
  add(cases, 'table-bold', [
    table(
      [[c('a', { bold: true }), [t('b', { bold: true }), t('c', { italic: true, bold: true })]]],
      { headerRows: 1 }
    )
  ])
  add(cases, 'table-code-merge', [
    table([[[t('a', { code: true }), t('b', { code: true }), t('c')]]])
  ])
  add(cases, 'table-link', [
    table([[[link('https://e.com', [t('x')]), t(' y')]]], { headerRows: 1 })
  ])
  add(cases, 'table-link-bold', [table([[[link('https://e.com', [t('x', { bold: true })])]]])])
  add(cases, 'table-hard-break', [table([[[t('a\nb')]]])])
  add(cases, 'table-empty-cell', [
    table(
      [
        [[], c('a')],
        [c('b'), []]
      ],
      { headerRows: 1 }
    )
  ])
  add(cases, 'table-string-cell', [table([['a', 'b']])])
  add(cases, 'table-null-cell', [table([[null, 'b']])])
  add(cases, 'table-cell-object', [
    table([
      [
        { type: 'tableCell', content: c('a'), props: {} },
        { type: 'tableCell', content: c('b'), props: { colspan: 1 } }
      ]
    ])
  ])
  add(cases, 'table-colspan', [
    table([[{ type: 'tableCell', content: c('wide'), props: { colspan: 2 } }], [c('a'), c('b')]], {
      headerRows: 1
    })
  ])
  add(cases, 'table-rowspan', [
    table([[{ type: 'tableCell', content: c('tall'), props: { rowspan: 2 } }, c('b')], [c('c')]], {
      headerRows: 1
    })
  ])
  add(cases, 'table-no-rows', [block('table', { type: 'tableContent', rows: [] })])
  add(cases, 'table-then-text', [table([[c('a')]]), block('paragraph', 'after')])
  add(cases, 'table-inline-image', [
    table([[[inline('inlineImage', { src: 'a.png', alt: 'pic', width: 300 })]]])
  ])
  add(cases, 'table-checkbox', [
    table([[[inline('inlineCheckbox', { checked: true }), t('done')]]])
  ])
  add(cases, 'table-wiki', [table([[[inline('wikiLink', { target: 'Note', alias: 'n' })]]])])
  add(cases, 'table-comment', [
    table([[[t('a '), inline('htmlComment', { source: '<!-- c -->' }), t(' b')]]])
  ])
  add(cases, 'table-comment-in-bold', [
    table([
      [
        [
          t('a ', { bold: true }),
          inline('htmlComment', { source: '<!-- c -->' }),
          t(' b', { bold: true })
        ]
      ]
    ])
  ])
}

function inlineSpecCases(cases: OracleCase[]): void {
  const wrap = (...items: unknown[]): Json[] => [block('paragraph', items)]
  add(cases, 'wiki-link', wrap(inline('wikiLink', { target: 'Note', alias: '' })))
  add(cases, 'wiki-link-alias', wrap(inline('wikiLink', { target: 'Note', alias: 'shown' })))
  add(cases, 'wiki-link-same-alias', wrap(inline('wikiLink', { target: 'Note', alias: 'Note' })))
  add(
    cases,
    'wiki-link-bold',
    wrap(inline('wikiLink', { target: 'Note', alias: '', bold: true, italic: true }))
  )
  add(
    cases,
    'wiki-link-all-marks',
    wrap(
      inline('wikiLink', {
        target: 'N',
        bold: true,
        italic: true,
        underline: true,
        strike: true,
        code: true
      })
    )
  )
  add(cases, 'wiki-link-code', wrap(inline('wikiLink', { target: 'N', code: true })))
  add(
    cases,
    'link-mention',
    wrap(inline('linkMention', { url: 'https://example.com/a_b*c~d(e)!?x=1&y=é' }))
  )
  add(cases, 'hash-tag', wrap(t('see '), inline('hashTag', { tag: 'project' })))
  add(cases, 'hash-tag-empty', wrap(inline('hashTag', { tag: '' })))
  add(
    cases,
    'date-mention',
    wrap(
      inline('dateMention', {
        anchorId: 'a1',
        dateISO: '2026-01-02',
        hasTime: false,
        dateFormat: 'relative',
        remind: 'none',
        timeFormat: 'system'
      })
    )
  )
  add(
    cases,
    'date-mention-time',
    wrap(
      inline('dateMention', {
        anchorId: 'a2',
        dateISO: '2026-01-02T10:30:00.000Z',
        hasTime: true,
        dateFormat: 'full',
        remind: '15m',
        timeFormat: '24h'
      })
    )
  )
  add(
    cases,
    'date-mention-defaults',
    wrap(inline('dateMention', { anchorId: 'a3', dateISO: '2026-01-02' }))
  )
  add(
    cases,
    'date-mention-non-latin1',
    wrap(inline('dateMention', { anchorId: 'ş', dateISO: '2026-01-02' }))
  )
  add(cases, 'inline-image', wrap(inline('inlineImage', { src: 'a.png', alt: 'alt', width: 0 })))
  add(
    cases,
    'inline-image-width',
    wrap(inline('inlineImage', { src: 'a.png', alt: 'alt', width: '250' }))
  )
  add(cases, 'inline-checkbox', wrap(inline('inlineCheckbox', { checked: true }), t('x')))
  add(cases, 'inline-checkbox-string', wrap(inline('inlineCheckbox', { checked: 'true' })))
  add(cases, 'comment-alone', wrap(inline('htmlComment', { source: '<!-- note -->' })))
  add(
    cases,
    'comment-between',
    wrap(t('a '), inline('htmlComment', { source: '<!-- c -->' }), t(' b'))
  )
  add(cases, 'comment-percent', wrap(t('a '), inline('htmlComment', { source: '%%hidden%%' })))
  add(
    cases,
    'comment-in-bold',
    wrap(
      t('a ', { bold: true }),
      inline('htmlComment', { source: '<!-- c -->' }),
      t(' b', { bold: true })
    )
  )
  add(
    cases,
    'comment-in-italic-code',
    wrap(
      t('a ', { italic: true, code: true }),
      inline('htmlComment', { source: '<!-- c -->' }),
      t(' b', { italic: true })
    )
  )
  add(
    cases,
    'comment-no-space-bold',
    wrap(
      t('a', { bold: true }),
      inline('htmlComment', { source: '<!-- c -->' }),
      t('b', { bold: true })
    )
  )
  add(cases, 'comment-in-list', [
    block('bulletListItem', [t('a '), inline('htmlComment', { source: '<!-- c -->' })])
  ])
  add(cases, 'unknown-inline', wrap(inline('mystery', {})))
}

function mediaCases(cases: OracleCase[]): void {
  const img = (props: Json): Json => block('image', undefined, props)
  add(cases, 'image', [img({ url: 'a.png', name: 'pic' })])
  add(cases, 'image-no-name', [img({ url: 'a.png' })])
  add(cases, 'image-no-url', [img({ name: 'pic' })])
  add(cases, 'image-width', [img({ url: 'a.png', name: 'pic', previewWidth: 300 })])
  add(cases, 'image-default-width', [img({ url: 'a.png', name: 'pic', previewWidth: 600 })])
  add(cases, 'image-caption', [img({ url: 'a.png', name: 'pic', caption: 'cap' })])
  add(cases, 'image-caption-width', [
    img({ url: 'a.png', name: 'pic', caption: 'cap', previewWidth: '320' })
  ])
  add(cases, 'image-caption-same-as-name', [img({ url: 'a.png', name: 'cap', caption: 'cap' })])
  add(cases, 'image-caption-escapes', [img({ url: 'a"b.png', name: 'p<i>c', caption: 'a & <b>' })])
  add(cases, 'image-link', [img({ url: 'a.png', name: 'pic', showPreview: false })])
  add(cases, 'image-link-caption', [
    img({ url: 'a.png', name: 'pic', showPreview: false, caption: 'cap' })
  ])
  add(cases, 'image-parens-url', [img({ url: 'a(1).png', name: 'pic' })])
  add(cases, 'video', [block('video', undefined, { url: 'v.mp4', name: 'clip' })])
  add(cases, 'video-caption', [block('video', undefined, { url: 'v.mp4', caption: 'cap' })])
  add(cases, 'video-link', [
    block('video', undefined, { url: 'v.mp4', name: 'clip', showPreview: false })
  ])
  add(cases, 'video-empty', [block('video')])
  add(cases, 'audio', [block('audio', undefined, { url: 'a.mp3' })])
  add(cases, 'audio-caption', [block('audio', undefined, { url: 'a.mp3', caption: 'cap' })])
  add(cases, 'audio-link', [
    block('audio', undefined, { url: 'a "x".mp3', name: 'song', showPreview: false })
  ])
  add(cases, 'file', [
    block('file', undefined, {
      url: 'memry-file://x/doc.pdf',
      name: 'doc.pdf',
      size: 12,
      mimeType: 'application/pdf'
    })
  ])
  add(cases, 'file-empty', [block('file')])
  add(cases, 'youtube', [
    block('youtubeEmbed', undefined, { videoId: 'abc', videoUrl: 'https://youtu.be/abc' })
  ])
  add(cases, 'youtube-alt', [
    block('youtubeEmbed', undefined, { videoUrl: 'https://youtu.be/abc', alt: 'talk' })
  ])
  add(cases, 'bookmark', [block('bookmark', undefined, { url: 'https://example.com', title: 'x' })])
  add(cases, 'whiteboard', [block('whiteboard', undefined, { canvasId: 'c1' })])
  add(cases, 'whiteboard-empty', [block('whiteboard')])
}

function memryBlockCases(cases: OracleCase[]): void {
  add(cases, 'task', [
    block('taskBlock', undefined, { taskId: 't1', title: 'Write', checked: false })
  ])
  add(cases, 'task-checked', [
    block('taskBlock', undefined, { taskId: 't1', title: 'Write', checked: true })
  ])
  add(cases, 'task-with-subtask', [
    block('taskBlock', undefined, { taskId: 't1', title: 'A' }, [
      block('taskBlock', undefined, { taskId: 't2', title: 'B', parentTaskId: 't1' })
    ])
  ])
  add(cases, 'callout', [block('callout', 'body', { type: 'info' })])
  add(cases, 'callout-empty', [block('callout', [], { type: 'warning' })])
  add(cases, 'callout-no-content', [block('callout', undefined, { type: 'tip' })])
  add(cases, 'callout-fold', [block('callout', 'body', { type: 'note', fold: 'open' })])
  add(cases, 'callout-fold-closed', [
    block('callout', [t('a\nb')], { type: 'note', fold: 'closed' })
  ])
  add(cases, 'callout-default-type', [block('callout', 'body')])
  add(cases, 'callout-children', [
    block('callout', 'a', { type: 'info' }, [block('paragraph', 'child')])
  ])
  add(cases, 'toggle-list-item-nested', [
    block('bulletListItem', 'a', {}, [block('toggleListItem', 't', {}, [block('paragraph', 'c')])])
  ])
  add(cases, 'column-list', [
    block('columnList', undefined, {}, [
      block('column', undefined, { width: 1 }, [block('paragraph', 'a')]),
      block('column', undefined, { width: 1 }, [block('paragraph', 'b')])
    ])
  ])
  add(cases, 'unknown-block', [block('mystery', 'x')])
  add(cases, 'sidecar-props', [
    block('paragraph', 'colored', {
      textColor: 'red',
      backgroundColor: 'blue',
      textAlignment: 'center'
    })
  ])
}

export function serializeBlocksCases(): OracleCase[] {
  const cases: OracleCase[] = []
  textBlocks(cases)
  styleCases(cases)
  linkCases(cases)
  listCases(cases)
  tableCases(cases)
  inlineSpecCases(cases)
  mediaCases(cases)
  memryBlockCases(cases)
  return cases
}

/** The memry-parse inputs, serialized after the seed: callouts, quotes, columns, every layer. */
export function serializeSeedCases(external: MarkdownSource[]): OracleCase[] {
  return memryParseCases(external).map((c) => ({
    id: c.id.replace('/memry-parse/', '/serialize-seed/'),
    op: 'serialize-seed',
    input: c.input
  }))
}

export function serializeCases(external: MarkdownSource[]): OracleCase[] {
  return [...serializeBlocksCases(), ...serializeSeedCases(external)]
}

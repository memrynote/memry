import { describe, expect, it } from 'vitest'
import {
  applyInlineColorTokens,
  extractInlineColorRuns,
  maskInlineColorSpans,
  restoreInlineColorTokens
} from './inline-colors'

describe('extractInlineColorRuns / restoreInlineColorTokens (serialize side)', () => {
  it('wraps colored runs in token runs and restores them as span html', () => {
    const blocks = [
      {
        type: 'heading',
        props: { level: 3 },
        content: [
          { type: 'text', text: 'He', styles: {} },
          { type: 'text', text: 'llo', styles: { textColor: 'red' } },
          { type: 'text', text: ' world', styles: {} }
        ],
        children: []
      }
    ]

    const { blocks: wrapped, replacements } = extractInlineColorRuns(blocks)

    const content = (wrapped[0] as { content: Array<{ text: string; styles: object }> }).content
    expect(content).toHaveLength(5)
    expect(content[1].text).not.toBe('llo')
    expect(content[2]).toEqual({ type: 'text', text: 'llo', styles: {} })

    const markdown = `### ${content.map((c) => c.text).join('')}`
    const restored = restoreInlineColorTokens(markdown, replacements)
    expect(restored).toBe('### He<span style="color:red">llo</span> world')
  })

  it('keeps non-color styles on the wrapped run and emits both color decls', () => {
    const blocks = [
      {
        type: 'paragraph',
        props: {},
        content: [
          {
            type: 'text',
            text: 'x',
            styles: { bold: true, textColor: 'blue', backgroundColor: 'yellow' }
          }
        ],
        children: []
      }
    ]

    const { blocks: wrapped, replacements } = extractInlineColorRuns(blocks)
    const content = (wrapped[0] as { content: Array<{ text: string; styles: object }> }).content
    expect(content[1].styles).toEqual({ bold: true })

    const restored = restoreInlineColorTokens(content.map((c) => c.text).join(''), replacements)
    expect(restored).toBe('<span style="color:blue;background-color:yellow">x</span>')
  })

  it('wraps underlined runs and emits a text-decoration decl', () => {
    const blocks = [
      {
        type: 'paragraph',
        props: {},
        content: [
          { type: 'text', text: 'keep ', styles: {} },
          { type: 'text', text: 'under', styles: { underline: true } }
        ],
        children: []
      }
    ]

    const { blocks: wrapped, replacements } = extractInlineColorRuns(blocks)
    const content = (wrapped[0] as { content: Array<{ text: string; styles: object }> }).content
    expect(content[2]).toEqual({ type: 'text', text: 'under', styles: {} })

    const restored = restoreInlineColorTokens(content.map((c) => c.text).join(''), replacements)
    expect(restored).toBe('keep <span style="text-decoration:underline">under</span>')
  })

  it('nests underline in its own span instead of merging it into the color span', () => {
    const blocks = [
      {
        type: 'paragraph',
        props: {},
        content: [
          { type: 'text', text: 'x', styles: { bold: true, textColor: 'red', underline: true } }
        ],
        children: []
      }
    ]

    const { blocks: wrapped, replacements } = extractInlineColorRuns(blocks)
    const content = (wrapped[0] as { content: Array<{ text: string; styles: object }> }).content
    // bold stays on the run (markdown carries it); color and underline move out
    expect(content[2].styles).toEqual({ bold: true })

    const restored = restoreInlineColorTokens(content.map((c) => c.text).join(''), replacements)
    // Merging these into one style attribute would make already-released clients
    // reject the whole span and drop the color.
    expect(restored).toBe(
      '<span style="color:red"><span style="text-decoration:underline">x</span></span>'
    )
  })

  it('keeps one color span while opening a nested span only for the underlined run', () => {
    const blocks = [
      {
        type: 'paragraph',
        props: {},
        content: [
          { type: 'text', text: 'AAA', styles: { textColor: 'red', underline: true } },
          { type: 'text', text: 'BBB', styles: { textColor: 'red' } }
        ],
        children: []
      }
    ]

    const { blocks: wrapped, replacements } = extractInlineColorRuns(blocks)
    const content = (wrapped[0] as { content: Array<{ text: string }> }).content
    const restored = restoreInlineColorTokens(content.map((c) => c.text).join(''), replacements)
    // BBB must not be swallowed into AAA's underline span
    expect(restored).toBe(
      '<span style="color:red"><span style="text-decoration:underline">AAA</span>BBB</span>'
    )
  })

  it('still emits underline when a color value is unsafe', () => {
    const blocks = [
      {
        type: 'paragraph',
        props: {},
        content: [{ type: 'text', text: 'x', styles: { textColor: 'red;evil', underline: true } }],
        children: []
      }
    ]

    const { blocks: wrapped, replacements } = extractInlineColorRuns(blocks)
    const content = (wrapped[0] as { content: Array<{ text: string }> }).content
    const restored = restoreInlineColorTokens(content.map((c) => c.text).join(''), replacements)
    expect(restored).toBe('<span style="text-decoration:underline">x</span>')
  })

  it('leaves code block content unwrapped', () => {
    const blocks = [
      {
        type: 'codeBlock',
        props: { language: 'js' },
        content: [{ type: 'text', text: 'const a = 1', styles: { underline: true } }],
        children: []
      }
    ]

    const { blocks: wrapped, replacements } = extractInlineColorRuns(blocks)
    // the fence is literal; the parse side skips fences so a span here is forever
    expect(replacements.size).toBe(0)
    expect(wrapped[0]).toBe(blocks[0])
  })

  it('wraps runs inside BlockNote 0.47 tableCell objects', () => {
    const blocks = [
      {
        type: 'table',
        props: {},
        content: {
          type: 'tableContent',
          rows: [
            {
              cells: [
                {
                  type: 'tableCell',
                  props: {},
                  content: [{ type: 'text', text: 'u', styles: { underline: true } }]
                }
              ]
            }
          ]
        },
        children: []
      }
    ]

    const { blocks: wrapped } = extractInlineColorRuns(blocks as never)
    const cell = (
      wrapped[0] as unknown as {
        content: { rows: Array<{ cells: Array<{ content: unknown[] }> }> }
      }
    ).content.rows[0].cells[0]
    expect(cell.content).toHaveLength(3)
  })

  it('ignores underline:false and leaves untouched blocks referentially intact', () => {
    const blocks = [
      {
        type: 'paragraph',
        props: {},
        content: [{ type: 'text', text: 'plain', styles: { underline: false } }],
        children: []
      }
    ]

    const { blocks: wrapped, replacements } = extractInlineColorRuns(blocks)
    expect(replacements.size).toBe(0)
    expect(wrapped[0]).toBe(blocks[0])
  })

  it('ignores default colors and leaves untouched blocks referentially intact', () => {
    const blocks = [
      {
        type: 'paragraph',
        props: {},
        content: [{ type: 'text', text: 'plain', styles: { textColor: 'default' } }],
        children: []
      }
    ]

    const { blocks: wrapped, replacements } = extractInlineColorRuns(blocks)
    expect(replacements.size).toBe(0)
    expect(wrapped[0]).toBe(blocks[0])
  })

  it('wraps colored runs inside links and nested children', () => {
    const blocks = [
      {
        type: 'paragraph',
        props: {},
        content: [
          {
            type: 'link',
            href: 'https://example.com',
            content: [{ type: 'text', text: 'link', styles: { textColor: 'green' } }]
          }
        ],
        children: [
          {
            type: 'paragraph',
            props: {},
            content: [{ type: 'text', text: 'child', styles: { backgroundColor: 'pink' } }],
            children: []
          }
        ]
      }
    ]

    const { blocks: wrapped, replacements } = extractInlineColorRuns(blocks)
    // two open tokens + the shared close token
    expect(replacements.size).toBe(3)
    const link = (wrapped[0] as { content: Array<{ content?: unknown[] }> }).content[0]
    expect(link.content).toHaveLength(3)
    const child = (wrapped[0] as { children: Array<{ content: unknown[] }> }).children[0]
    expect(child.content).toHaveLength(3)
  })
})

describe('maskInlineColorSpans / applyInlineColorTokens (parse side)', () => {
  it('masks span tags into tokens and applies styles to parsed runs', () => {
    const { text, spans } = maskInlineColorSpans('### He<span style="color:red">llo</span> world')
    expect(text).not.toContain('<span')
    expect(text).not.toContain('</span>')
    expect(spans).toHaveLength(1)
    expect(spans[0].styles).toEqual({ textColor: 'red' })

    // simulate a parser that keeps the masked text verbatim in one run
    const parsed = [
      {
        type: 'heading',
        props: { level: 3 },
        content: [{ type: 'text', text: text.replace(/^### /, ''), styles: {} }],
        children: []
      }
    ]
    const applied = applyInlineColorTokens(parsed, spans)
    expect((applied[0] as { content: unknown[] }).content).toEqual([
      { type: 'text', text: 'He', styles: {} },
      { type: 'text', text: 'llo', styles: { textColor: 'red' } },
      { type: 'text', text: ' world', styles: {} }
    ])
  })

  it('parses combined color and background-color decls in any order', () => {
    const { spans } = maskInlineColorSpans(
      '<span style="background-color: yellow; color: blue">x</span>'
    )
    expect(spans[0].styles).toEqual({ textColor: 'blue', backgroundColor: 'yellow' })
  })

  it('merges span colors with styles the parser already produced', () => {
    const { text, spans } = maskInlineColorSpans('<span style="color:red">**bold** plain</span>')
    // simulate the parser splitting the bold run, tokens staying in the text runs
    const openEnd = text.indexOf('**bold**')
    const parsed = [
      {
        type: 'paragraph',
        props: {},
        content: [
          { type: 'text', text: text.slice(0, openEnd), styles: {} },
          { type: 'text', text: 'bold', styles: { bold: true } },
          { type: 'text', text: text.slice(openEnd + '**bold**'.length), styles: {} }
        ],
        children: []
      }
    ]
    const applied = applyInlineColorTokens(parsed, spans)
    expect((applied[0] as { content: unknown[] }).content).toEqual([
      { type: 'text', text: 'bold', styles: { bold: true, textColor: 'red' } },
      { type: 'text', text: ' plain', styles: { textColor: 'red' } }
    ])
  })

  it('masks an underline span and applies underline to parsed runs', () => {
    const { text, spans } = maskInlineColorSpans(
      'keep <span style="text-decoration:underline">under</span> tail'
    )
    expect(text).not.toContain('<span')
    expect(spans).toHaveLength(1)
    expect(spans[0].styles).toEqual({ underline: true })

    const parsed = [
      {
        type: 'paragraph',
        props: {},
        content: [{ type: 'text', text, styles: {} }],
        children: []
      }
    ]
    const applied = applyInlineColorTokens(parsed, spans)
    expect((applied[0] as { content: unknown[] }).content).toEqual([
      { type: 'text', text: 'keep ', styles: {} },
      { type: 'text', text: 'under', styles: { underline: true } },
      { type: 'text', text: ' tail', styles: {} }
    ])
  })

  it('parses combined color and underline decls in any order', () => {
    const { spans } = maskInlineColorSpans(
      '<span style="text-decoration: underline; color: blue">x</span>'
    )
    expect(spans[0].styles).toEqual({ textColor: 'blue', underline: true })
  })

  it('reads underline case-insensitively, the way CSS defines it', () => {
    const { spans } = maskInlineColorSpans('<span style="text-decoration: Underline">x</span>')
    expect(spans[0].styles).toEqual({ underline: true })
  })

  it('merges nested color and underline spans back onto one run', () => {
    const { text, spans } = maskInlineColorSpans(
      '<span style="color:red"><span style="text-decoration:underline">x</span></span>'
    )
    const parsed = [
      { type: 'paragraph', props: {}, content: [{ type: 'text', text, styles: {} }], children: [] }
    ]
    const applied = applyInlineColorTokens(parsed, spans)
    expect((applied[0] as { content: unknown[] }).content).toEqual([
      { type: 'text', text: 'x', styles: { textColor: 'red', underline: true } }
    ])
  })

  it('unmasks tokens inside BlockNote 0.47 tableCell objects', () => {
    const { text, spans } = maskInlineColorSpans('<span style="text-decoration:underline">u</span>')
    const parsed = [
      {
        type: 'table',
        props: {},
        content: {
          type: 'tableContent',
          rows: [
            {
              cells: [
                { type: 'tableCell', props: {}, content: [{ type: 'text', text, styles: {} }] }
              ]
            }
          ]
        },
        children: []
      }
    ]
    const applied = applyInlineColorTokens(parsed as never, spans)
    const cell = (
      applied[0] as unknown as {
        content: { rows: Array<{ cells: Array<{ content: unknown[] }> }> }
      }
    ).content.rows[0].cells[0]
    // an unrecognized cell shape would leave MEMRYICO… tokens in the vault file
    expect(cell.content).toEqual([{ type: 'text', text: 'u', styles: { underline: true } }])
  })

  it('does not mask text-decoration values other than underline', () => {
    const md = '<span style="text-decoration:line-through">a</span>'
    const { text, spans } = maskInlineColorSpans(md)
    expect(text).toBe(md)
    expect(spans).toHaveLength(0)
  })

  it('leaves spans inside fenced code blocks and inline code untouched', () => {
    const md = [
      '```html',
      '<span style="color:red">code</span>',
      '```',
      'inline `<span style="color:red">code</span>` tail'
    ].join('\n')
    const { text, spans } = maskInlineColorSpans(md)
    expect(text).toBe(md)
    expect(spans).toHaveLength(0)
  })

  it('does not mask spans with other attributes or non-color styles', () => {
    const md = '<span class="x">a</span> <span style="font-weight:bold">b</span>'
    const { text: masked } = maskInlineColorSpans(md)
    expect(masked).toContain('<span class="x">')
    expect(masked).toContain('<span style="font-weight:bold">')
  })

  it('leaves documents with only bare close tags unmasked', () => {
    const { text, spans } = maskInlineColorSpans('plain </span> tail')
    expect(text).toBe('plain </span> tail')
    expect(spans).toHaveLength(0)
  })

  it('drops a stray close token once a real span was masked', () => {
    const { text, spans } = maskInlineColorSpans(
      '<span style="color:red">x</span> mid </span> tail'
    )
    const parsed = [
      {
        type: 'paragraph',
        props: {},
        content: [{ type: 'text', text, styles: {} }],
        children: []
      }
    ]
    const applied = applyInlineColorTokens(parsed, spans)
    expect((applied[0] as { content: unknown[] }).content).toEqual([
      { type: 'text', text: 'x', styles: { textColor: 'red' } },
      { type: 'text', text: ' mid ', styles: {} },
      { type: 'text', text: ' tail', styles: {} }
    ])
  })

  it('restores tokens verbatim inside code blocks', () => {
    // an indented code block slips past line-based fence tracking; the apply
    // step must restore the original source instead of styling it
    const { text, spans } = maskInlineColorSpans('    <span style="color:red">x</span>')
    const parsed = [
      {
        type: 'codeBlock',
        props: {},
        content: [{ type: 'text', text: text.trim(), styles: {} }],
        children: []
      }
    ]
    const applied = applyInlineColorTokens(parsed, spans)
    expect((applied[0] as { content: Array<{ text: string }> }).content[0].text).toBe(
      '<span style="color:red">x</span>'
    )
  })
})

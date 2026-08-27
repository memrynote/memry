import { describe, expect, it, vi } from 'vitest'
import {
  isEmptyParagraph,
  parseMarkdownPreservingBlanks,
  sanitizeBlockIds,
  serializeBlocksPreservingBlanks
} from './markdown-utils'

function collectIds(blocks: Array<{ id?: string; children?: unknown[] }>): string[] {
  const ids: string[] = []

  for (const block of blocks) {
    if ('id' in block) ids.push(block.id ?? '')
    if (Array.isArray(block.children)) {
      ids.push(...collectIds(block.children as Array<{ id?: string; children?: unknown[] }>))
    }
  }

  return ids
}

describe('parseMarkdownPreservingBlanks', () => {
  it('does not create blank-line placeholder blocks with empty ids', async () => {
    let id = 0
    const editor = {
      tryParseMarkdownToBlocks: vi.fn(async (markdown: string) =>
        markdown
          .split('\n')
          .filter((line) => line.trim())
          .map((line) => ({
            id: `parsed-${++id}`,
            type: line.trimStart().startsWith('- [') ? 'checkListItem' : 'paragraph',
            props: line.includes('[x]') ? { isChecked: true } : { isChecked: false },
            content: [{ type: 'text', text: line.trim(), styles: {} }],
            children: []
          }))
      )
    }

    const blocks = await parseMarkdownPreservingBlanks(
      editor,
      [
        'Intro',
        '',
        '',
        '- [ ] Parent task {task:parent-1}',
        '  - [x] Child task {task:child-1}'
      ].join('\n')
    )

    expect(collectIds(blocks as any[])).not.toContain('')
  })

  it('parses callouts and valid embed markers while leaving invalid embeds as text', async () => {
    const editor = {
      tryParseMarkdownToBlocks: vi.fn(async (markdown: string) => [
        {
          type: 'paragraph',
          props: {},
          content: [{ type: 'text', text: markdown, styles: {} }],
          children: []
        }
      ]),
      blocksToMarkdownLossy: vi.fn(async (blocks: any[]) =>
        blocks.map((block) => block.content?.[0]?.text ?? '').join('\n')
      )
    }

    const blocks = await parseMarkdownPreservingBlanks(
      editor,
      [
        'Intro',
        '![embed](https://www.youtube.com/watch?v=dQw4w9WgXcQ)',
        '![embed](https://example.com/not-youtube)',
        '',
        '> [!warning]',
        '> Body line'
      ].join('\n')
    )

    expect(blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'youtubeEmbed',
          props: {
            videoId: 'dQw4w9WgXcQ',
            videoUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
          }
        }),
        expect.objectContaining({
          type: 'callout',
          props: { type: 'warning' },
          content: [{ type: 'text', text: 'Body line', styles: {} }]
        })
      ])
    )
    expect(editor.tryParseMarkdownToBlocks).toHaveBeenCalledWith(
      expect.stringContaining('https://example.com/not-youtube')
    )
  })

  it('leaves foreign and titled callout markers as markdown instead of claiming them', async () => {
    // `> [!note]` and `> [!warning] A title` are bytes Memry never writes —
    // claiming them would rewrite an Obsidian vault on the next save (#1846).
    const editor = {
      tryParseMarkdownToBlocks: vi.fn(async (markdown: string) => [
        {
          type: 'paragraph',
          props: {},
          content: [{ type: 'text', text: markdown, styles: {} }],
          children: []
        }
      ]),
      blocksToMarkdownLossy: vi.fn(async (blocks: any[]) =>
        blocks.map((block) => block.content?.[0]?.text ?? '').join('\n')
      )
    }

    const blocks = await parseMarkdownPreservingBlanks(
      editor,
      ['> [!note]\n> An Obsidian type', '', '> [!warning] A title\n> and a body'].join('\n')
    )

    expect(blocks.some((b) => (b.type as string) === 'callout')).toBe(false)
    expect(editor.tryParseMarkdownToBlocks).toHaveBeenCalledWith(expect.stringContaining('[!note]'))
  })

  it('heals a bare callout marker whose body sits directly below (#1846)', async () => {
    const editor = {
      tryParseMarkdownToBlocks: vi.fn(async (markdown: string) => [
        {
          type: 'paragraph',
          props: {},
          content: [{ type: 'text', text: markdown, styles: {} }],
          children: []
        }
      ]),
      blocksToMarkdownLossy: vi.fn(async (blocks: any[]) =>
        blocks.map((block) => block.content?.[0]?.text ?? '').join('\n')
      )
    }

    const blocks = await parseMarkdownPreservingBlanks(editor, '[!info]\nHer text line')

    expect(blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'callout',
          props: { type: 'info' },
          content: [{ type: 'text', text: 'Her text line', styles: {} }]
        })
      ])
    )
  })

  it('parses bookmark markers into bookmark blocks with derived domain', async () => {
    const editor = {
      tryParseMarkdownToBlocks: vi.fn(async (markdown: string) => [
        {
          type: 'paragraph',
          props: {},
          content: [{ type: 'text', text: markdown, styles: {} }],
          children: []
        }
      ])
    }

    const blocks = await parseMarkdownPreservingBlanks(
      editor,
      ['Intro', '![bookmark](https://www.example.com/article)', 'Outro'].join('\n')
    )

    expect(blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'bookmark',
          props: { url: 'https://www.example.com/article', domain: 'example.com' }
        })
      ])
    )
  })

  it('applies color markers to the first block of the following chunk', async () => {
    const editor = {
      tryParseMarkdownToBlocks: vi.fn(async (markdown: string) =>
        markdown
          .split('\n')
          .filter((line) => line.trim())
          .map((line) => ({
            type: 'paragraph',
            props: {},
            content: [{ type: 'text', text: line.trim(), styles: {} }],
            children: []
          }))
      )
    }

    const blocks = await parseMarkdownPreservingBlanks(
      editor,
      [
        'Intro',
        '<!-- colors:{"textColor":"red"} -->',
        'Colored line',
        'Plain line',
        '<!-- colors:{"textColor":"blue","backgroundColor":"yellow"} -->',
        'Second colored'
      ].join('\n')
    )

    expect(blocks).toEqual([
      expect.objectContaining({
        props: {},
        content: [{ type: 'text', text: 'Intro', styles: {} }]
      }),
      expect.objectContaining({
        props: { textColor: 'red' },
        content: [{ type: 'text', text: 'Colored line', styles: {} }]
      }),
      expect.objectContaining({
        props: {},
        content: [{ type: 'text', text: 'Plain line', styles: {} }]
      }),
      expect.objectContaining({
        props: { textColor: 'blue', backgroundColor: 'yellow' },
        content: [{ type: 'text', text: 'Second colored', styles: {} }]
      })
    ])
  })

  it('applies inline color spans to parsed runs', async () => {
    const editor = {
      tryParseMarkdownToBlocks: vi.fn(async (markdown: string) =>
        markdown
          .split('\n')
          .filter((line) => line.trim())
          .map((line) => ({
            type: 'paragraph',
            props: {},
            content: [{ type: 'text', text: line.trim(), styles: {} }],
            children: []
          }))
      )
    }

    const blocks = await parseMarkdownPreservingBlanks(
      editor,
      'He<span style="color:red">llo</span> world'
    )

    expect(blocks).toEqual([
      expect.objectContaining({
        content: [
          { type: 'text', text: 'He', styles: {} },
          { type: 'text', text: 'llo', styles: { textColor: 'red' } },
          { type: 'text', text: ' world', styles: {} }
        ]
      })
    ])
  })

  it('parses file block markers in place', async () => {
    const editor = {
      tryParseMarkdownToBlocks: vi.fn(async (markdown: string) => [
        {
          type: 'paragraph',
          props: {},
          content: [{ type: 'text', text: markdown, styles: {} }],
          children: []
        }
      ])
    }

    const blocks = await parseMarkdownPreservingBlanks(
      editor,
      [
        'Intro',
        '<!-- file:{"url":"memry-file://local/voice.wav","name":"voice.wav","size":1572864,"mimeType":"audio/wav"} -->',
        'Tail'
      ].join('\n')
    )

    expect(blocks).toEqual([
      expect.objectContaining({
        type: 'paragraph',
        content: [{ type: 'text', text: 'Intro', styles: {} }]
      }),
      {
        type: 'file',
        props: {
          url: 'memry-file://local/voice.wav',
          name: 'voice.wav',
          size: 1572864,
          mimeType: 'audio/wav'
        }
      },
      expect.objectContaining({
        type: 'paragraph',
        content: [{ type: 'text', text: 'Tail', styles: {} }]
      })
    ])
  })
})

describe('sanitizeBlockIds', () => {
  it('removes empty ids recursively and preserves valid ids', () => {
    const blocks = [
      {
        id: '',
        type: 'taskBlock',
        props: { taskId: 'task-1', title: 'Parent', checked: false, parentTaskId: '' },
        content: undefined,
        children: [
          {
            id: '',
            type: 'paragraph',
            props: {},
            content: [],
            children: []
          },
          {
            id: 'valid-child',
            type: 'paragraph',
            props: {},
            content: [],
            children: []
          }
        ]
      }
    ]

    const sanitized = sanitizeBlockIds(blocks as any[])

    expect(collectIds(sanitized as any[])).toEqual(['valid-child'])
  })

  it('returns the original array when ids do not need sanitizing', () => {
    const blocks = [
      {
        id: 'valid',
        type: 'paragraph',
        props: {},
        content: [{ type: 'text', text: 'Text', styles: {} }],
        children: []
      }
    ] as any[]

    expect(sanitizeBlockIds(blocks)).toBe(blocks)
  })
})

describe('serializeBlocksPreservingBlanks', () => {
  it('serializes task blocks, embeds, callouts, blank paragraphs, and content groups', async () => {
    const editor = {
      blocksToMarkdownLossy: vi.fn(async (blocks: any[]) =>
        blocks
          .map((block) => {
            if (block.type === 'callout') return 'Callout body\n'
            return block.content?.[0]?.text ?? ''
          })
          .filter(Boolean)
          .join('\n')
      )
    }

    const markdown = await serializeBlocksPreservingBlanks(editor, [
      {
        type: 'paragraph',
        props: {},
        content: [{ type: 'text', text: 'Intro', styles: {} }],
        children: []
      },
      { type: 'paragraph', props: {}, content: [], children: [] },
      {
        type: 'taskBlock',
        props: { taskId: 'parent-1', title: 'Parent task', checked: false },
        children: [
          {
            type: 'taskBlock',
            props: {
              taskId: 'child-1',
              title: 'Child task',
              checked: true,
              parentTaskId: 'parent-1'
            },
            children: []
          },
          {
            type: 'paragraph',
            props: {},
            content: [{ type: 'text', text: 'Ignored child paragraph', styles: {} }],
            children: []
          }
        ]
      },
      {
        type: 'youtubeEmbed',
        props: { videoUrl: 'https://youtu.be/dQw4w9WgXcQ' },
        children: []
      },
      {
        type: 'bookmark',
        props: { url: 'https://example.com/article', domain: 'example.com' },
        children: []
      },
      {
        type: 'callout',
        props: { type: 'success' },
        children: []
      },
      {
        type: 'paragraph',
        props: {},
        content: [{ type: 'text', text: 'Tail', styles: {} }],
        children: []
      }
    ] as any[])

    expect(markdown).toContain('Intro')
    expect(markdown).toContain('- [ ] Parent task {task:parent-1}')
    expect(markdown).toContain('  - [x] Child task {task:child-1}')
    expect(markdown).toContain('![embed](https://youtu.be/dQw4w9WgXcQ)')
    expect(markdown).toContain('![bookmark](https://example.com/article)')
    expect(markdown).toContain('> [!success]\n> Callout body')
    expect(markdown).toContain('Tail')
  })

  it('serializes colored blocks alone with a color marker line', async () => {
    const editor = {
      blocksToMarkdownLossy: vi.fn(async (blocks: any[]) =>
        blocks.map((block) => block.content?.[0]?.text ?? '').join('\n')
      )
    }

    const markdown = await serializeBlocksPreservingBlanks(editor, [
      {
        type: 'paragraph',
        props: {},
        content: [{ type: 'text', text: 'Intro', styles: {} }],
        children: []
      },
      {
        type: 'paragraph',
        props: { textColor: 'red', backgroundColor: 'default' },
        content: [{ type: 'text', text: 'Colored line', styles: {} }],
        children: []
      },
      {
        type: 'paragraph',
        props: { textColor: 'blue', backgroundColor: 'yellow' },
        content: [{ type: 'text', text: 'Second colored', styles: {} }],
        children: []
      },
      {
        type: 'paragraph',
        props: { textColor: 'default', backgroundColor: 'default' },
        content: [{ type: 'text', text: 'Tail', styles: {} }],
        children: []
      }
    ] as any[])

    expect(markdown).toContain('<!-- colors:{"textColor":"red"} -->\nColored line')
    expect(markdown).toContain(
      '<!-- colors:{"textColor":"blue","backgroundColor":"yellow"} -->\nSecond colored'
    )
    // colored blocks are serialized alone, not grouped with neighbors
    expect(editor.blocksToMarkdownLossy).toHaveBeenCalledWith([
      expect.objectContaining({ props: { textColor: 'red', backgroundColor: 'default' } })
    ])
    // default-colored blocks emit no marker
    expect(markdown).not.toContain('colors:{}')
    const tailIndex = markdown.indexOf('Tail')
    expect(markdown.lastIndexOf('<!-- colors:', tailIndex)).toBeLessThan(
      markdown.indexOf('Second colored')
    )
  })

  it('serializes inline textColor styles as span html', async () => {
    const editor = {
      blocksToMarkdownLossy: vi.fn(async (blocks: any[]) =>
        blocks
          .map((block) =>
            Array.isArray(block.content)
              ? block.content.map((content: any) => content.text ?? '').join('')
              : ''
          )
          .filter(Boolean)
          .join('\n')
      )
    }

    const markdown = await serializeBlocksPreservingBlanks(editor, [
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
    ] as any[])

    expect(markdown).toBe('He<span style="color:red">llo</span> world')
  })

  it('serializes file blocks as markers without leaking rendered UI text', async () => {
    const editor = {
      blocksToMarkdownLossy: vi.fn(async (blocks: any[]) =>
        blocks
          .map((block) => {
            if (block.type === 'file') return 'voice.wav\n1.5 MB\nDownload'
            return block.content?.[0]?.text ?? ''
          })
          .filter(Boolean)
          .join('\n')
      )
    }

    const markdown = await serializeBlocksPreservingBlanks(editor, [
      {
        type: 'paragraph',
        props: {},
        content: [{ type: 'text', text: 'Intro', styles: {} }],
        children: []
      },
      {
        type: 'file',
        props: {
          url: 'memry-file://local/voice.wav',
          name: 'voice.wav',
          size: 1572864,
          mimeType: 'audio/wav'
        },
        children: []
      },
      {
        type: 'paragraph',
        props: {},
        content: [{ type: 'text', text: 'Tail', styles: {} }],
        children: []
      }
    ] as any[])

    expect(markdown).toContain('Intro')
    expect(markdown).toContain(
      '<!-- file:{"url":"memry-file://local/voice.wav","name":"voice.wav","size":1572864,"mimeType":"audio/wav"} -->'
    )
    expect(markdown).toContain('Tail')
    expect(markdown).not.toContain('1.5 MB')
    expect(markdown).not.toContain('Download')
    expect(editor.blocksToMarkdownLossy).not.toHaveBeenCalledWith([
      expect.objectContaining({ type: 'file' })
    ])
  })

  it('round-trips nested paragraph indentation with hidden markdown markers', async () => {
    const editor = {
      tryParseMarkdownToBlocks: vi.fn(async (markdown: string) =>
        markdown
          .split(/\n\n+/)
          .filter((line) => line.trim())
          .map((line) => ({
            type: 'paragraph',
            props: {},
            content: [{ type: 'text', text: line.trim(), styles: {} }],
            children: []
          }))
      ),
      blocksToMarkdownLossy: vi.fn(async (blocks: any[]) =>
        blocks
          .map((block) =>
            Array.isArray(block.content)
              ? block.content.map((content: any) => content.text ?? '').join('')
              : ''
          )
          .filter(Boolean)
          .join('\n\n')
      )
    }

    const markdown = await serializeBlocksPreservingBlanks(editor, [
      {
        type: 'paragraph',
        props: {},
        content: [{ type: 'text', text: 'Parent', styles: {} }],
        children: [
          {
            type: 'paragraph',
            props: {},
            content: [{ type: 'text', text: 'Child', styles: {} }],
            children: []
          }
        ]
      },
      {
        type: 'paragraph',
        props: {},
        content: [{ type: 'text', text: 'Sibling', styles: {} }],
        children: []
      }
    ] as any[])

    expect(markdown).toContain('<!-- memry:block-nesting-level=1 -->')
    expect(markdown).toContain('<!-- memry:block-nesting-level=0 -->')

    const blocks = await parseMarkdownPreservingBlanks(editor, markdown)
    expect(blocks).toEqual([
      expect.objectContaining({
        content: [{ type: 'text', text: 'Parent', styles: {} }],
        children: [
          expect.objectContaining({
            content: [{ type: 'text', text: 'Child', styles: {} }],
            children: []
          })
        ]
      }),
      expect.objectContaining({
        content: [{ type: 'text', text: 'Sibling', styles: {} }],
        children: []
      })
    ])
  })

  it('normalizes remark output to `-` bullets, tight lists, and single-newline paragraphs', async () => {
    // BlockNote's raw serializer emits `*` bullets, a blank line per list item,
    // and `\` hard breaks. The renderer save path must run the same normalizer as
    // the main/CRDT path so typed notes are not rewritten to that loose style on
    // disk. The mock reproduces remark's raw shape; the assertion is on the
    // normalized result.
    const editor = {
      blocksToMarkdownLossy: vi.fn(async (blocks: any[]) => {
        if (blocks[0]?.type === 'bulletListItem') return '* kaan\n\n* sevde\n\n* karaca'
        return 'line1\\\nline2\\\nline3'
      })
    }

    const list = await serializeBlocksPreservingBlanks(editor, [
      { type: 'bulletListItem', props: {}, content: [{ type: 'text', text: 'kaan' }], children: [] }
    ] as any[])
    expect(list).toBe('- kaan\n- sevde\n- karaca')

    const paragraph = await serializeBlocksPreservingBlanks(editor, [
      { type: 'paragraph', props: {}, content: [{ type: 'text', text: 'line1' }], children: [] }
    ] as any[])
    expect(paragraph).toBe('line1\nline2\nline3')
  })
})

describe('toggle blocks (#1643)', () => {
  /** Text in, text out — enough to see which markdown the two paths produce. */
  const textEditor = {
    tryParseMarkdownToBlocks: vi.fn(async (markdown: string) =>
      markdown
        .split(/\n\n+/)
        .filter((chunk) => chunk.trim())
        .map((chunk) => ({
          type: 'paragraph',
          props: {},
          content: [{ type: 'text', text: chunk.trim(), styles: {} }],
          children: []
        }))
    ),
    blocksToMarkdownLossy: vi.fn(async (blocks: any[]) =>
      blocks
        .map((block) =>
          Array.isArray(block.content)
            ? block.content.map((content: any) => content.text ?? '').join('')
            : ''
        )
        .filter(Boolean)
        .join('\n\n')
    )
  }

  const toggle = (summary: string, children: unknown[] = []) => ({
    type: 'toggleListItem',
    props: {},
    content: [{ type: 'text', text: summary, styles: {} }],
    children
  })

  const paragraph = (text: string) => ({
    type: 'paragraph',
    props: {},
    content: [{ type: 'text', text, styles: {} }],
    children: []
  })

  it('serializes a toggle and its children into one <details> region', async () => {
    const markdown = await serializeBlocksPreservingBlanks(textEditor, [
      toggle('Details', [paragraph('Hidden')])
    ] as any[])

    expect(markdown).toBe(
      [
        '<details data-memry-toggle>',
        '<summary>Details</summary>',
        '',
        'Hidden',
        '',
        '</details>'
      ].join('\n')
    )
  })

  it('parses that region back into a toggleListItem with its children', async () => {
    const markdown = await serializeBlocksPreservingBlanks(textEditor, [
      toggle('Outer', [paragraph('One'), toggle('Inner', [paragraph('Deep')])])
    ] as any[])

    const blocks = await parseMarkdownPreservingBlanks(textEditor, markdown)

    expect(blocks).toEqual([
      expect.objectContaining({
        type: 'toggleListItem',
        content: [{ type: 'text', text: 'Outer', styles: {} }],
        children: [
          expect.objectContaining({ content: [{ type: 'text', text: 'One', styles: {} }] }),
          expect.objectContaining({
            type: 'toggleListItem',
            content: [{ type: 'text', text: 'Inner', styles: {} }],
            children: [
              expect.objectContaining({ content: [{ type: 'text', text: 'Deep', styles: {} }] })
            ]
          })
        ]
      })
    ])
  })

  it('re-serializes to the same bytes over six passes', async () => {
    // Two passes cannot tell "converged" from "grows a fixed amount every save".
    const first = await serializeBlocksPreservingBlanks(textEditor, [
      paragraph('Before'),
      toggle('Outer', [paragraph('One'), toggle('Inner', [paragraph('Deep')])]),
      paragraph('After')
    ] as any[])
    expect(first).toContain('<summary>Inner</summary>')

    let current = first
    for (let pass = 0; pass < 6; pass++) {
      const blocks = await parseMarkdownPreservingBlanks(textEditor, current)
      current = await serializeBlocksPreservingBlanks(textEditor, blocks)
      expect(current).toBe(first)
    }
  })

  it('writes the fold as the open attribute, and omits it when collapsed (#1847)', async () => {
    // #given the same toggle in each state. Main serializes through the very
    // same `serializeToggleBlock`, and `blocknote-converter.test.ts` asserts the
    // two agree; what this pins is the bytes each state reaches the vault as.
    const expanded = { ...toggle('Details', [paragraph('Hidden')]), props: { open: true } }
    const collapsed = { ...toggle('Details', [paragraph('Hidden')]), props: { open: false } }

    // #when
    const body = ['<summary>Details</summary>', '', 'Hidden', '', '</details>']

    // #then
    expect(await serializeBlocksPreservingBlanks(textEditor, [expanded] as any[])).toBe(
      ['<details data-memry-toggle open>', ...body].join('\n')
    )
    // byte-identical to every toggle already on disk, prop or no prop
    expect(await serializeBlocksPreservingBlanks(textEditor, [collapsed] as any[])).toBe(
      ['<details data-memry-toggle>', ...body].join('\n')
    )
    expect(
      await serializeBlocksPreservingBlanks(textEditor, [
        toggle('Details', [paragraph('Hidden')])
      ] as any[])
    ).toBe(['<details data-memry-toggle>', ...body].join('\n'))
  })

  it('parses the open attribute back into the prop (#1847)', async () => {
    const markdown = await serializeBlocksPreservingBlanks(textEditor, [
      { ...toggle('Details', [paragraph('Hidden')]), props: { open: true } }
    ] as any[])

    expect(await parseMarkdownPreservingBlanks(textEditor, markdown)).toEqual([
      expect.objectContaining({
        type: 'toggleListItem',
        props: expect.objectContaining({ open: true })
      })
    ])
  })

  it('leaves a plain <details> the app never wrote as markdown', async () => {
    const markdown = ['<details>', '<summary>Theirs</summary>', '', 'Body', '', '</details>'].join(
      '\n'
    )

    const blocks = await parseMarkdownPreservingBlanks(textEditor, markdown)

    expect(blocks.some((block) => block.type === 'toggleListItem')).toBe(false)
  })
})

describe('isEmptyParagraph', () => {
  it('detects only empty paragraph blocks', () => {
    expect(isEmptyParagraph({ type: 'heading', content: [] } as any)).toBe(false)
    expect(isEmptyParagraph({ type: 'paragraph', content: undefined } as any)).toBe(true)
    expect(isEmptyParagraph({ type: 'paragraph', content: [] } as any)).toBe(true)
    expect(isEmptyParagraph({ type: 'paragraph', content: [], children: [{}] } as any)).toBe(false)
    expect(isEmptyParagraph({ type: 'paragraph', content: ['text'] } as any)).toBe(false)
  })
})

/**
 * #1639 — the non-collaborative save path's half of the table cell colour
 * marker. Its twin (`blocknote-converter.ts`) is pinned by round trips through
 * a real ServerBlockNoteEditor; what is under test here is the plumbing: the
 * marker goes in front of the table, and comes back onto the same cell.
 */
describe('table cell colours (#1639)', () => {
  const TABLE_MD = ['| Name | Status |', '| --- | --- |', '| Ship | Done |'].join('\n')

  const cell = (text: string, colors: Record<string, string> = {}) => ({
    type: 'tableCell',
    content: [{ type: 'text', text, styles: {} }],
    props: { colspan: 1, rowspan: 1, textAlignment: 'left', ...colors }
  })

  const table = (colors: Record<string, string> = {}) => ({
    type: 'table',
    props: {},
    content: {
      type: 'tableContent',
      columnWidths: [null, null],
      headerRows: 1,
      rows: [
        { cells: [cell('Name'), cell('Status')] },
        { cells: [cell('Ship', colors), cell('Done')] }
      ]
    },
    children: []
  })

  /** A table in, GFM out — and back, ignoring the cell text the marker never touches. */
  const tableEditor = {
    tryParseMarkdownToBlocks: vi.fn(async (markdown: string) =>
      markdown.includes('|') ? [table()] : []
    ),
    blocksToMarkdownLossy: vi.fn(async () => TABLE_MD)
  }

  it('writes the marker in front of the table it belongs to', async () => {
    // #given the cell menu was used on the second row's first cell
    const blocks = [table({ backgroundColor: 'red', textColor: 'blue' })]

    // #when
    const markdown = await serializeBlocksPreservingBlanks(tableEditor, blocks as any[])

    // #then
    expect(markdown).toBe(
      `<!-- table-colors:{"1:0":{"textColor":"blue","backgroundColor":"red"}} -->\n${TABLE_MD}`
    )
  })

  it('writes nothing extra for a table nobody has coloured', async () => {
    const markdown = await serializeBlocksPreservingBlanks(tableEditor, [table()] as any[])

    expect(markdown).toBe(TABLE_MD)
  })

  it('reads the marker back onto the cell it names', async () => {
    // #given the note as it sits on disk
    const markdown = `<!-- table-colors:{"1:0":{"backgroundColor":"red"}} -->\n${TABLE_MD}`

    // #when
    const blocks = await parseMarkdownPreservingBlanks(tableEditor, markdown)

    // #then the colour is on the cell, and the marker is not a paragraph of its own
    expect(blocks).toHaveLength(1)
    expect((blocks[0] as any).content.rows[1].cells[0].props).toMatchObject({
      backgroundColor: 'red',
      colspan: 1
    })
    expect((blocks[0] as any).content.rows[0].cells[0].props).not.toHaveProperty('backgroundColor')
  })
})

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
      ])
    }

    const blocks = await parseMarkdownPreservingBlanks(
      editor,
      [
        'Intro',
        '![embed](https://www.youtube.com/watch?v=dQw4w9WgXcQ)',
        '![embed](https://example.com/not-youtube)',
        '',
        '> [!warning] Heads up',
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
          content: [{ type: 'text', text: 'Heads up\nBody line', styles: {} }]
        })
      ])
    )
    expect(editor.tryParseMarkdownToBlocks).toHaveBeenCalledWith(
      expect.stringContaining('https://example.com/not-youtube')
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

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
    expect(markdown).toContain('> [!success]\n> Callout body')
    expect(markdown).toContain('Tail')
  })
})

describe('isEmptyParagraph', () => {
  it('detects only empty paragraph blocks', () => {
    expect(isEmptyParagraph({ type: 'heading', content: [] } as any)).toBe(false)
    expect(isEmptyParagraph({ type: 'paragraph', content: undefined } as any)).toBe(true)
    expect(isEmptyParagraph({ type: 'paragraph', content: [] } as any)).toBe(true)
    expect(isEmptyParagraph({ type: 'paragraph', content: ['text'] } as any)).toBe(false)
  })
})

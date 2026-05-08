import { describe, expect, it, vi } from 'vitest'
import { parseMarkdownPreservingBlanks, sanitizeBlockIds } from './markdown-utils'

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
})

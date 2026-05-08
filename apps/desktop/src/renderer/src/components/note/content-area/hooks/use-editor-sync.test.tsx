import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useEditorSync } from './use-editor-sync'
import { fetchLinkPreview } from '@/lib/url-metadata'

vi.mock('@/lib/url-metadata', () => ({
  fetchLinkPreview: vi.fn().mockResolvedValue({
    domain: 'example.com',
    title: 'Example',
    favicon: 'https://example.com/favicon.ico'
  })
}))

vi.mock('../file-block', () => ({
  FILE_BLOCK_REGEX: /<!-- file:(\{[^}]+\}) -->/g,
  createFileBlockContent: vi.fn((props) => ({ type: 'file', props })),
  serializeFileBlock: vi.fn((props) => `<!-- file:${JSON.stringify(props)} -->`)
}))

function createEditor(parsedBlocks: any[] = []) {
  let document = [{ id: 'initial', type: 'paragraph', props: {}, content: [], children: [] }]

  return {
    get document() {
      return document
    },
    replaceBlocks: vi.fn((_current: any[], next: any[]) => {
      document = next
    }),
    tryParseMarkdownToBlocks: vi.fn().mockResolvedValue(parsedBlocks),
    tryParseHTMLToBlocks: vi.fn().mockResolvedValue(parsedBlocks),
    blocksToMarkdownLossy: vi.fn().mockResolvedValue(''),
    updateBlock: vi.fn((block: any, update: any) => {
      if ('content' in update) block.content = update.content
      if ('props' in update) block.props = { ...block.props, ...update.props }
    })
  }
}

function collectIds(blocks: any[]): string[] {
  const ids: string[] = []

  for (const block of blocks) {
    if ('id' in block) ids.push(block.id ?? '')
    if (Array.isArray(block.children)) ids.push(...collectIds(block.children))
  }

  return ids
}

afterEach(() => {
  vi.useRealTimers()
})

describe('useEditorSync', () => {
  it('hydrates link mentions without crashing on non-array block content', async () => {
    const nestedMention = {
      id: 'nested-mention',
      type: 'paragraph',
      props: {},
      content: [
        {
          type: 'linkMention',
          props: { url: 'https://example.com', domain: 'example.com', title: 'Example' }
        }
      ],
      children: []
    }
    const editor = createEditor([
      { id: 'string-content', type: 'paragraph', props: {}, content: 'plain string', children: [] },
      {
        id: 'table-content',
        type: 'table',
        props: {},
        content: { type: 'tableContent', rows: [] },
        children: []
      },
      {
        id: 'task-content-none',
        type: 'taskBlock',
        props: { taskId: 'task-1', title: 'Task', checked: false, parentTaskId: '' },
        content: undefined,
        children: [nestedMention]
      }
    ])

    renderHook(() =>
      useEditorSync({
        editor,
        initialContent: 'content',
        contentType: 'markdown'
      })
    )

    await waitFor(() => expect(fetchLinkPreview).toHaveBeenCalledWith('https://example.com'))
    await waitFor(() =>
      expect(editor.updateBlock).toHaveBeenCalledWith(nestedMention, expect.anything())
    )
  })

  it('does not mark markdown content ready when parsing fails', async () => {
    vi.useFakeTimers()

    const editor = createEditor()
    editor.tryParseMarkdownToBlocks.mockRejectedValueOnce(new Error('parse failed'))
    const onMarkdownChange = vi.fn()

    const { result } = renderHook(() =>
      useEditorSync({
        editor,
        initialContent: '- [ ] broken task',
        contentType: 'markdown',
        onMarkdownChange
      })
    )

    await waitFor(() => expect(editor.tryParseMarkdownToBlocks).toHaveBeenCalled())
    await act(async () => {
      await Promise.resolve()
    })

    expect(result.current.isContentReadyRef.current).toBe(false)

    act(() => {
      result.current.handleChange()
      vi.advanceTimersByTime(200)
    })

    expect(onMarkdownChange).not.toHaveBeenCalled()
  })

  it('strips empty parsed ids before replacing converted task blocks', async () => {
    const editor = createEditor([
      {
        id: '',
        type: 'checkListItem',
        props: { isChecked: false },
        content: [{ type: 'text', text: 'Sync v1 {task:task-1}', styles: {} }],
        children: [
          {
            id: '',
            type: 'paragraph',
            props: {},
            content: [{ type: 'text', text: 'Nested note', styles: {} }],
            children: []
          }
        ]
      }
    ])

    renderHook(() =>
      useEditorSync({
        editor,
        initialContent: '- [ ] Sync v1 {task:task-1}',
        contentType: 'markdown'
      })
    )

    await waitFor(() => expect(editor.replaceBlocks).toHaveBeenCalled())

    const [, nextBlocks] = editor.replaceBlocks.mock.calls[0]
    expect(collectIds(nextBlocks)).not.toContain('')
  })
})

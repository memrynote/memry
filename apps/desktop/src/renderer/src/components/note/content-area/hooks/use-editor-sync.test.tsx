import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useEditorSync } from './use-editor-sync'
import { useEditorTeardown } from '@/hooks/use-editor-teardown'
import { fetchLinkPreview } from '@/lib/url-metadata'

const blockNoteMocks = vi.hoisted(() => ({
  removeAndInsertBlocks: vi.fn((tr: any, blocksToRemove: any[], blocksToInsert: any[]) => {
    tr.__nextBlocks = blocksToInsert
    return { insertedBlocks: blocksToInsert, removedBlocks: blocksToRemove }
  })
}))

const yUndoMocks = vi.hoisted(() => ({
  getState: vi.fn()
}))

vi.mock('@blocknote/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@blocknote/core')>()
  return {
    ...actual,
    removeAndInsertBlocks: blockNoteMocks.removeAndInsertBlocks
  }
})

vi.mock('y-prosemirror', () => ({
  yUndoPluginKey: {
    getState: yUndoMocks.getState
  }
}))

vi.mock('@/lib/url-metadata', () => ({
  fetchLinkPreview: vi.fn().mockResolvedValue({
    domain: 'example.com',
    title: 'Example',
    favicon: 'https://example.com/favicon.ico'
  })
}))

function createEditor(parsedBlocks: any[] = []) {
  let document = [{ id: 'initial', type: 'paragraph', props: {}, content: [], children: [] }]
  const transact = vi.fn((callback: (tr: any) => unknown) => {
    const tr = {
      setMeta: vi.fn().mockReturnThis()
    }
    const result = callback(tr)
    if (Array.isArray(tr.__nextBlocks)) {
      document = tr.__nextBlocks
    }
    return result
  })

  return {
    get document() {
      return document
    },
    transact,
    replaceBlocks: vi.fn((_current: any[], next: any[]) => {
      document = next
    }),
    tryParseMarkdownToBlocks: vi.fn().mockResolvedValue(parsedBlocks),
    tryParseHTMLToBlocks: vi.fn().mockResolvedValue(parsedBlocks),
    blocksToMarkdownLossy: vi.fn().mockResolvedValue(''),
    updateBlock: vi.fn((block: any, update: any) => {
      if ('content' in update) block.content = update.content
      if ('props' in update) block.props = { ...block.props, ...update.props }
    }),
    _tiptapEditor: {
      state: {},
      destroy: vi.fn()
    }
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
  blockNoteMocks.removeAndInsertBlocks.mockClear()
  yUndoMocks.getState.mockReset()
})

describe('useEditorSync', () => {
  it('loads initial markdown content without adding an editor undo history entry', async () => {
    const editor = createEditor([
      {
        id: 'paragraph-1',
        type: 'paragraph',
        props: {},
        content: ['Body'],
        children: []
      }
    ])

    renderHook(() =>
      useEditorSync({
        editor,
        initialContent: 'Body',
        contentType: 'markdown'
      })
    )

    await waitFor(() => expect(blockNoteMocks.removeAndInsertBlocks).toHaveBeenCalled())

    const tr = blockNoteMocks.removeAndInsertBlocks.mock.calls[0][0]
    expect(editor.transact).toHaveBeenCalled()
    expect(tr.setMeta).toHaveBeenCalledWith('addToHistory', false)
    expect(editor.replaceBlocks).not.toHaveBeenCalled()
    expect(editor.document).toEqual([
      {
        id: 'paragraph-1',
        type: 'paragraph',
        props: {},
        content: ['Body'],
        children: []
      }
    ])
  })

  it('clears Yjs undo history when collaboration content becomes ready', async () => {
    const undoManager = {
      clear: vi.fn(),
      stopCapturing: vi.fn()
    }
    yUndoMocks.getState.mockReturnValue({ undoManager })

    const editor = createEditor()

    renderHook(() =>
      useEditorSync({
        editor,
        yjsFragment: {} as never
      })
    )

    await waitFor(() => expect(undoManager.clear).toHaveBeenCalledWith(true, true))
    expect(undoManager.stopCapturing).toHaveBeenCalled()
  })

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

    await waitFor(() => expect(blockNoteMocks.removeAndInsertBlocks).toHaveBeenCalled())

    const [, , nextBlocks] = blockNoteMocks.removeAndInsertBlocks.mock.calls[0]
    expect(collectIds(nextBlocks)).not.toContain('')
  })

  it('debounces markdown, heading, and inline tag notifications after local edits', async () => {
    vi.useFakeTimers()
    const onContentChange = vi.fn()
    const onMarkdownChange = vi.fn()
    const onHeadingsChange = vi.fn()
    const onInlineTagsChange = vi.fn()
    const editor = createEditor()
    editor.blocksToMarkdownLossy.mockResolvedValue('Body markdown')
    const initialBlocks = [
      {
        id: 'heading-1',
        type: 'heading',
        props: { level: 2 },
        content: [{ type: 'text', text: 'Roadmap', styles: {} }],
        children: []
      },
      {
        id: 'paragraph-1',
        type: 'paragraph',
        props: {},
        content: ['Ship #Focus'],
        children: []
      },
      {
        id: 'file-1',
        type: 'file',
        props: {
          url: 'memry://files/spec.pdf',
          name: 'spec.pdf',
          size: 42,
          mimeType: 'application/pdf'
        },
        content: [],
        children: []
      }
    ]

    const { result } = renderHook(() =>
      useEditorSync({
        editor,
        initialContent: initialBlocks as never,
        contentType: 'blocks',
        onContentChange,
        onMarkdownChange,
        onHeadingsChange,
        onInlineTagsChange
      })
    )

    await waitFor(() => expect(result.current.isContentReadyRef.current).toBe(true))
    onHeadingsChange.mockClear()
    onInlineTagsChange.mockClear()
    ;(editor.document[1].content as string[]) = ['Ship #Focus #Build']

    act(() => {
      result.current.handleChange()
      vi.advanceTimersByTime(150)
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(onContentChange).toHaveBeenCalledWith(editor.document)
    const savedMarkdown = onMarkdownChange.mock.calls[0][0] as string
    expect(savedMarkdown).toContain('<!-- file:{"url":"memry://files/spec.pdf"')
    expect(savedMarkdown.match(/<!-- file:/g)).toHaveLength(1)

    act(() => {
      vi.advanceTimersByTime(50)
    })
    expect(onHeadingsChange).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'heading-1', text: 'Roadmap', level: 2 })
    ])

    act(() => {
      vi.advanceTimersByTime(100)
    })
    expect(onInlineTagsChange).toHaveBeenCalledWith(['Build', 'Focus'])
    expect(result.current.prevInlineTagsRef.current).toEqual(['Build', 'Focus'])
  })

  it('re-applies external content in place when the external revision changes', async () => {
    const editor = createEditor([
      { id: 'paragraph-1', type: 'paragraph', props: {}, content: ['Body'], children: [] }
    ])

    const { rerender } = renderHook(
      ({ initialContent, externalContentRevision }) =>
        useEditorSync({
          editor,
          initialContent,
          contentType: 'markdown',
          externalContentRevision
        }),
      { initialProps: { initialContent: 'Body', externalContentRevision: 0 } }
    )

    await waitFor(() => expect(blockNoteMocks.removeAndInsertBlocks).toHaveBeenCalledTimes(1))

    editor.tryParseMarkdownToBlocks.mockResolvedValue([
      {
        id: 'paragraph-2',
        type: 'paragraph',
        props: {},
        content: ['Edited elsewhere'],
        children: []
      }
    ])
    rerender({ initialContent: 'Edited elsewhere', externalContentRevision: 1 })

    await waitFor(() => expect(blockNoteMocks.removeAndInsertBlocks).toHaveBeenCalledTimes(2))
    expect(editor.document).toEqual([
      {
        id: 'paragraph-2',
        type: 'paragraph',
        props: {},
        content: ['Edited elsewhere'],
        children: []
      }
    ])
  })

  it('leaves an external revision to the Y.Doc when collaboration is active', async () => {
    const editor = createEditor([
      { id: 'paragraph-1', type: 'paragraph', props: {}, content: ['Body'], children: [] }
    ])

    const { result, rerender } = renderHook(
      ({ externalContentRevision }) =>
        useEditorSync({
          editor,
          initialContent: 'Body',
          contentType: 'markdown',
          yjsFragment: {} as never,
          externalContentRevision
        }),
      { initialProps: { externalContentRevision: 0 } }
    )

    await waitFor(() => expect(result.current.isContentReadyRef.current).toBe(true))

    rerender({ externalContentRevision: 1 })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    // The main process feeds the external edit into the shared Y.Doc, which the
    // IPC provider merges into this editor. Re-parsing here would clobber that
    // merge (and any concurrent local edit riding on the same doc).
    expect(blockNoteMocks.removeAndInsertBlocks).not.toHaveBeenCalled()
    expect(editor.replaceBlocks).not.toHaveBeenCalled()
    expect(editor.document).toEqual([
      { id: 'initial', type: 'paragraph', props: {}, content: [], children: [] }
    ])
  })

  it('flushes a pending markdown save before the editor is torn down', async () => {
    const onMarkdownChange = vi.fn()
    const editor = createEditor()
    editor.blocksToMarkdownLossy.mockResolvedValue('Typed just before closing')
    const typed = [
      {
        id: 'paragraph-1',
        type: 'paragraph',
        props: {},
        content: [{ type: 'text', text: 'Typed just before closing', styles: {} }],
        children: []
      }
    ]

    const { result, unmount } = renderHook(() => {
      const sync = useEditorSync({
        editor,
        initialContent: typed as never,
        contentType: 'blocks',
        onMarkdownChange
      })
      useEditorTeardown(editor, sync.flushPendingMarkdown)
      return sync
    })

    await waitFor(() => expect(result.current.isContentReadyRef.current).toBe(true))

    // Type, then close the tab inside the 150ms debounce window.
    act(() => {
      result.current.handleChange()
    })
    unmount()

    await waitFor(() => expect(onMarkdownChange).toHaveBeenCalledTimes(1))
    expect(onMarkdownChange.mock.calls[0][0]).toContain('Typed just before closing')
    expect(editor._tiptapEditor.destroy).toHaveBeenCalledTimes(1)
    expect(onMarkdownChange.mock.invocationCallOrder[0]).toBeLessThan(
      editor._tiptapEditor.destroy.mock.invocationCallOrder[0]
    )
  })

  it('skips markdown persistence for remote updates and Yjs-backed documents', async () => {
    vi.useFakeTimers()
    const onContentChange = vi.fn()
    const onMarkdownChange = vi.fn()
    const editor = createEditor([
      {
        id: 'paragraph-1',
        type: 'paragraph',
        props: {},
        content: ['Body'],
        children: []
      }
    ])
    const isRemoteUpdateRef = { current: true }

    const { result, rerender } = renderHook(
      ({ yjsFragment }) =>
        useEditorSync({
          editor,
          initialContent: 'Body',
          contentType: 'markdown',
          isRemoteUpdateRef,
          yjsFragment,
          onContentChange,
          onMarkdownChange
        }),
      { initialProps: { yjsFragment: undefined as unknown } }
    )

    await waitFor(() => expect(result.current.isContentReadyRef.current).toBe(true))

    act(() => {
      result.current.handleChange()
      vi.advanceTimersByTime(200)
    })

    expect(onContentChange).toHaveBeenCalled()
    expect(onMarkdownChange).not.toHaveBeenCalled()

    isRemoteUpdateRef.current = false
    rerender({ yjsFragment: {} })
    act(() => {
      result.current.handleChange()
      vi.advanceTimersByTime(200)
    })

    expect(onMarkdownChange).not.toHaveBeenCalled()
  })
})

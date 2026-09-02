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

/**
 * The smallest ProseMirror-shaped state `isEditingWikiLinkText` can read: one
 * text block and a collapsed caret at `offset`. Enough to say whether the caret
 * is inside a raw `[[…]]` run, which is the only question asked of it here.
 */
function caretState(text: string, offset: number): any {
  const parent = {
    isTextblock: true,
    type: { spec: {} },
    content: { size: text.length },
    textBetween: () => text
  }
  return {
    selection: {
      empty: true,
      $from: { parent, parentOffset: offset, start: () => 1 }
    }
  }
}

function createEditor(parsedBlocks: any[] = []) {
  let document = [{ id: 'initial', type: 'paragraph', props: {}, content: [], children: [] }]
  const transact = vi.fn((callback: (tr: any) => unknown) => {
    const tr = {
      setMeta: vi.fn().mockReturnThis()
    } as { setMeta: ReturnType<typeof vi.fn>; __nextBlocks?: unknown }
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

  it('does not promote the wiki link the caret is inside, and promotes the others', async () => {
    const editor = createEditor() as any
    const { result } = renderHook(() =>
      useEditorSync({ editor, initialContent: '', contentType: 'markdown' })
    )
    await waitFor(() => expect(result.current.isContentReadyRef.current).toBe(true))

    editor.replaceBlocks(
      [],
      [
        {
          id: 'editing',
          type: 'paragraph',
          props: {},
          content: 'Read [[Daily Note]]',
          children: []
        }
      ]
    )
    editor.replaceBlocks.mockClear()

    // Caret inside the run: a whole-document replace here would yank the text
    // out from under it mid-edit (`wiki-link-edit-plugin.ts`).
    editor.getTextCursorPosition = vi.fn(() => ({ block: { id: 'editing' } }))
    editor._tiptapEditor.state = caretState('Read [[Daily Note]]', 10)
    act(() => {
      result.current.handleChange()
    })
    expect(editor.replaceBlocks).not.toHaveBeenCalled()

    // Caret in the same block but OUTSIDE the brackets: the exemption is the
    // link run, not the block the user happens to be standing in. A hand-typed
    // `[[Note]]` still becomes a chip the moment it is complete.
    editor._tiptapEditor.state = caretState('Read [[Daily Note]]', 0)
    act(() => {
      result.current.handleChange()
    })
    expect(editor.replaceBlocks).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(editor.document)).toContain('wikiLink')
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
    // Loading reports the tag the body ALREADY had, flagged as the baseline —
    // opening a note must not write to it (#1454).
    expect(onInlineTagsChange).toHaveBeenCalledWith(['Focus'], 'load')
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
    expect(onInlineTagsChange).toHaveBeenCalledWith(['Build', 'Focus'], 'edit')
    expect(result.current.prevInlineTagsRef.current).toEqual(['Build', 'Focus'])
  })

  it('saves the author’s spelling back when the document has not changed, house style once it has (#1915)', async () => {
    vi.useFakeTimers()
    const onMarkdownChange = vi.fn()
    const editor = createEditor([
      {
        id: 'p1',
        type: 'paragraph',
        props: {},
        content: [{ type: 'text', text: 'One', styles: {} }],
        children: []
      }
    ])
    // What the editor serializes the loaded `* One` to: house style.
    editor.blocksToMarkdownLossy.mockResolvedValue('- One')

    const { result } = renderHook(() =>
      useEditorSync({
        editor,
        initialContent: '* One',
        contentType: 'markdown',
        onMarkdownChange
      })
    )
    await waitFor(() => expect(result.current.isContentReadyRef.current).toBe(true))

    act(() => {
      result.current.handleChange()
      vi.advanceTimersByTime(150)
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(onMarkdownChange).toHaveBeenLastCalledWith('* One')

    // The save derives its base by re-parsing the source, so the serializer
    // must answer by content: the document now says Two, the source still One.
    // A fresh block, because the parse mock hands back the very objects the
    // load put into the document and mutating them would move the base too.
    editor.replaceBlocks(editor.document, [
      {
        id: 'p1',
        type: 'paragraph',
        props: {},
        content: [{ type: 'text', text: 'Two', styles: {} }],
        children: []
      }
    ])
    editor.blocksToMarkdownLossy.mockImplementation(async (blocks: unknown) =>
      JSON.stringify(blocks).includes('Two') ? '- Two' : '- One'
    )
    act(() => {
      result.current.handleChange()
      vi.advanceTimersByTime(150)
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(onMarkdownChange).toHaveBeenLastCalledWith('- Two')
  })

  it('reports the loaded tags as a baseline, and only a real edit as an edit', async () => {
    // #given a note whose body already carries a hash tag
    const onInlineTagsChange = vi.fn()
    const editor = createEditor()
    const initialBlocks = [
      {
        id: 'paragraph-1',
        type: 'paragraph',
        props: {},
        content: ['Tagged #hashtag here.'],
        children: []
      }
    ]

    const { result } = renderHook(() =>
      useEditorSync({
        editor,
        initialContent: initialBlocks as never,
        contentType: 'blocks',
        onInlineTagsChange
      })
    )

    // #when it is opened
    await waitFor(() => expect(result.current.isContentReadyRef.current).toBe(true))

    // #then the only report is the baseline, and it carries the tag the file
    // already had — nothing for the owner to persist
    expect(onInlineTagsChange.mock.calls).toEqual([[['hashtag'], 'load']])
    expect(result.current.prevInlineTagsRef.current).toEqual(['hashtag'])

    // #when the user then deletes that tag from the body
    vi.useFakeTimers()
    ;(editor.document[0].content as string[]) = ['Tagged here.']
    act(() => {
      result.current.handleChange()
      vi.advanceTimersByTime(300)
    })

    // #then THAT is an edit — removing the last inline tag still reaches the owner
    expect(onInlineTagsChange).toHaveBeenLastCalledWith([], 'edit')
  })

  it('reports a baseline on the collaborative path too, where content is already bound', async () => {
    // #given the collaborative branch: the shared fragment is bound to the
    // editor before this hook runs, so there is nothing to parse — but the tags
    // in that body are just as much "what the note was opened with" (#1454)
    const onInlineTagsChange = vi.fn()
    const undoManager = { clear: vi.fn(), stopCapturing: vi.fn() }
    yUndoMocks.getState.mockReturnValue({ undoManager })
    const editor = createEditor()
    ;(editor.document[0].content as unknown as string[]) = ['Tagged #hashtag here.']

    // #when
    const { result } = renderHook(() =>
      useEditorSync({
        editor,
        yjsFragment: {} as never,
        onInlineTagsChange
      })
    )

    // #then
    await waitFor(() => expect(onInlineTagsChange).toHaveBeenCalled())
    expect(onInlineTagsChange.mock.calls).toEqual([[['hashtag'], 'load']])
    expect(result.current.prevInlineTagsRef.current).toEqual(['hashtag'])
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
          yjsFragment: yjsFragment as never,
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

import { renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { useEditorSync } from './use-editor-sync'

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}))

describe('useEditorSync', () => {
  it('does not hydrate markdown over an attached Yjs fragment', async () => {
    const doc = new Y.Doc()
    const fragment = doc.getXmlFragment('prosemirror')
    const editor = {
      document: [],
      replaceBlocks: vi.fn(),
      tryParseMarkdownToBlocks: vi.fn().mockResolvedValue([
        {
          id: 'parsed',
          type: 'paragraph',
          props: {},
          content: [{ type: 'text', text: 'from markdown', styles: {} }],
          children: []
        }
      ])
    }

    const { result } = renderHook(() =>
      useEditorSync({
        editor,
        initialContent: '# Markdown body',
        contentType: 'markdown',
        yjsFragment: fragment
      })
    )

    await waitFor(() => expect(result.current.isContentReadyRef.current).toBe(true))

    expect(editor.tryParseMarkdownToBlocks).not.toHaveBeenCalled()
    expect(editor.replaceBlocks).not.toHaveBeenCalled()

    doc.destroy()
  })
})

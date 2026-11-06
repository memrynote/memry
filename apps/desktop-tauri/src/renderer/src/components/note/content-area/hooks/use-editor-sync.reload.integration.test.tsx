import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { BlockNoteEditor } from '@blocknote/core'

import { useEditorSync } from './use-editor-sync'

// An outside edit that leaves a body with no text reloads the open editor to one empty
// paragraph. The change that reload fires must hand back the file's own bytes, or the note page
// takes it for typing, holds back the next outside edit and saves over it. The real serializer
// writes that paragraph as blank lines, which no such file holds.

const mounted: Array<{ editor: BlockNoteEditor; el: HTMLElement }> = []

afterEach(() => {
  for (const { editor, el } of mounted.splice(0)) {
    editor.unmount()
    el.remove()
  }
})

function mountedEditor(): BlockNoteEditor {
  const editor = BlockNoteEditor.create()
  const el = document.createElement('div')
  document.body.appendChild(el)
  editor.mount(el)
  mounted.push({ editor, el })
  return editor
}

describe('useEditorSync reload of a body with no text', () => {
  it.each([
    ['an empty', ''],
    ['a blank-line', '\n'],
    ['a whitespace-only', '  \n\n']
  ])('saves back %s file as it is', async (_, body) => {
    const editor = mountedEditor()
    const onMarkdownChange = vi.fn()
    const { result, rerender } = renderHook(
      ({ initialContent, externalContentRevision }) =>
        useEditorSync({
          editor,
          initialContent,
          contentType: 'markdown',
          externalContentRevision,
          onMarkdownChange
        }),
      { initialProps: { initialContent: '## Context', externalContentRevision: 0 } }
    )
    await waitFor(() => expect(result.current.isContentReadyRef.current).toBe(true))

    rerender({ initialContent: body, externalContentRevision: 1 })
    await waitFor(() => expect(editor.document[0]?.type).toBe('paragraph'))
    await act(async () => {
      result.current.handleChange()
      await result.current.flushPendingMarkdown()
    })

    expect(onMarkdownChange).toHaveBeenLastCalledWith(body)
  })
})

/**
 * A link preview that arrives while the window holds typing for an outside edit waits for the
 * hold to end, then fills in the mention it finds in the edited document. Fed through the hold
 * as typing, it was refused and replayed over the edit: a mention the edit deleted came back,
 * and the replay landed on the undo stack.
 */

import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BlockNoteEditor } from '@blocknote/core'
import { yUndoPluginKey } from 'y-prosemirror'
import * as Y from 'yjs'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'

vi.mock('react-pdf', () => ({
  Document: () => null,
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: { workerSrc: '' } }
}))

const PREVIEW = {
  domain: 'example.com',
  title: 'Example A',
  favicon: 'https://example.com/favicon.ico',
  siteName: 'Example'
}
const fetchLinkPreview = vi.fn()
vi.mock('@/lib/url-metadata', () => ({
  fetchLinkPreview: (url: string) => fetchLinkPreview(url),
  extractDomain: (url: string) => new URL(url).hostname
}))

import { typingHoldOf } from '@/sync/typing-hold'
import { editorSchema } from './editor-schema'
import { withCollaborationIfLive } from './collaboration-options'
import { useEditorSync } from './hooks/use-editor-sync'
import { registerEditorPlugin } from './register-editor-plugin'
import { createTypingHoldPlugin } from './typing-hold-plugin'

const URL_ = 'https://example.com/a'
const mounted: Array<{ editor: BlockNoteEditor; el: HTMLElement; doc: Y.Doc }> = []

afterEach(() => {
  for (const { editor, el, doc } of mounted.splice(0)) {
    editor.unmount()
    el.remove()
    doc.destroy()
  }
  fetchLinkPreview.mockReset()
})

function collaborativeEditor(): { editor: BlockNoteEditor; doc: Y.Doc; fragment: Y.XmlFragment } {
  const doc = new Y.Doc()
  const fragment = doc.getXmlFragment(CRDT_FRAGMENT_NAME)
  const editor = BlockNoteEditor.create(
    withCollaborationIfLive(fragment, { schema: editorSchema })
  ) as unknown as BlockNoteEditor
  const el = document.createElement('div')
  document.body.appendChild(el)
  editor.mount(el)
  mounted.push({ editor, el, doc })
  return { editor, doc, fragment }
}

/** An open note holding one bare mention, a held preview fetch, and the window's typing hold. */
function openNoteWithHeldPreview() {
  let resolvePreview: (value: typeof PREVIEW) => void = () => {}
  fetchLinkPreview.mockReturnValue(new Promise((resolve) => (resolvePreview = resolve)))
  const { editor, doc, fragment } = collaborativeEditor()
  editor.replaceBlocks(editor.document, [
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'See ', styles: {} },
        { type: 'linkMention', props: { url: URL_, domain: 'example.com' } },
        { type: 'text', text: ' end', styles: {} }
      ]
    } as never
  ])
  const hold = typingHoldOf(doc)
  registerEditorPlugin(editor, createTypingHoldPlugin(hold))
  const { result } = renderHook(() =>
    useEditorSync({ editor, noteId: 'typing-hold-note', yjsFragment: fragment })
  )
  editor.onChange(() => result.current.handleChange())
  return { editor, doc, fragment, hold, resolvePreview: (p: typeof PREVIEW) => resolvePreview(p) }
}

function mentionTitles(editor: BlockNoteEditor): string[] {
  const titles: string[] = []
  editor._tiptapEditor.state.doc.descendants((node) => {
    if (node.type.name === 'linkMention') titles.push(String(node.attrs.title))
  })
  return titles
}

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('a link preview that resolves during a typing hold', () => {
  it('does not bring back a mention the outside edit deleted', async () => {
    // #given an outside edit that rewrites the block without the mention, on another replica
    const { editor, doc, fragment, hold, resolvePreview } = openNoteWithHeldPreview()
    const remote = collaborativeEditor()
    Y.applyUpdate(remote.doc, Y.encodeStateAsUpdate(doc))
    remote.editor.replaceBlocks(remote.editor.document, [
      { type: 'paragraph', content: [{ type: 'text', text: 'See end', styles: {} }] } as never
    ])
    const edit = Y.encodeStateAsUpdate(remote.doc, Y.encodeStateVector(doc))

    // #when the preview arrives while the hold is on, and then the edit's frame applies
    hold.hold(1, 2000)
    resolvePreview(PREVIEW)
    await settle()
    hold.feed(() => Y.applyUpdate(doc, edit))
    await settle()

    // #then
    expect(mentionTitles(editor)).toEqual([])
    expect(fragment.toJSON()).not.toContain('linkMention')
  })

  it('fills the mention in after the hold, with no undo step', async () => {
    // #given
    const { editor, fragment, hold, resolvePreview } = openNoteWithHeldPreview()

    // #when
    hold.hold(1, 2000)
    resolvePreview(PREVIEW)
    await settle()
    hold.release(1)
    await settle()

    // #then
    expect(mentionTitles(editor)).toEqual([PREVIEW.title])
    expect(fragment.toJSON()).toContain(`title="${PREVIEW.title}"`)
    const undoManager = yUndoPluginKey.getState(editor._tiptapEditor.state)?.undoManager
    expect(undoManager?.undoStack).toHaveLength(0)
  })
})

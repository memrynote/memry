import { afterEach, describe, expect, it } from 'vitest'
import { BlockNoteEditor } from '@blocknote/core'
import { getLiveProseMirrorView, getLiveTiptapView } from './live-prosemirror-view'

// Uses the default BlockNote schema: the custom schema's extra block specs drag
// react-pdf into jsdom and none of it touches view lifetime.

const tiptapOf = (editor: BlockNoteEditor): any => (editor as any)._tiptapEditor

const mounted: Array<{ editor: BlockNoteEditor; el: HTMLElement }> = []

afterEach(() => {
  for (const { editor, el } of mounted.splice(0)) {
    tiptapOf(editor).unmount()
    el.remove()
  }
})

function mountEditor(): BlockNoteEditor {
  const editor = BlockNoteEditor.create()
  const el = document.createElement('div')
  document.body.appendChild(el)
  editor.mount(el)
  mounted.push({ editor, el })
  return editor
}

// The production teardown order: BlockNoteView's ref unmounts the tiptap editor
// (nulling `editorView`) while the tiptap editor and its listeners stay alive.
function unmountedEditor(): BlockNoteEditor {
  const editor = mountEditor()
  tiptapOf(editor).unmount()
  return editor
}

describe('TipTap 3.x view proxy', () => {
  it('stays truthy and reports isDestroyed false after unmount, then throws on real access', () => {
    const editor = unmountedEditor()

    expect(tiptapOf(editor).editorView).toBeFalsy()
    expect(editor.prosemirrorView).toBeTruthy()
    expect(editor.prosemirrorView.isDestroyed).toBe(false)
    expect(() => editor.prosemirrorView.domAtPos(0)).toThrow(/editor view is not available/i)
  })
})

describe('getLiveProseMirrorView', () => {
  it('returns undefined for an unmounted editor', () => {
    expect(getLiveProseMirrorView(unmountedEditor())).toBeUndefined()
  })

  it('returns the real view for a mounted editor', () => {
    const editor = mountEditor()
    expect(getLiveProseMirrorView(editor)).toBe(tiptapOf(editor).editorView)
  })

  it('returns undefined for a missing editor', () => {
    expect(getLiveProseMirrorView(null)).toBeUndefined()
    expect(getLiveProseMirrorView(undefined)).toBeUndefined()
  })
})

describe('getLiveTiptapView', () => {
  it('returns undefined for an unmounted tiptap editor and the real view for a mounted one', () => {
    expect(getLiveTiptapView(tiptapOf(unmountedEditor()))).toBeUndefined()

    const tiptap = tiptapOf(mountEditor())
    expect(getLiveTiptapView(tiptap)).toBe(tiptap.editorView)
  })
})

// The shape table-border-handles' resolveFocus now uses. Under the old
// `if (!view || view.isDestroyed)` guard this same body threw.
describe('resolveFocus guard shape', () => {
  const resolveFocus = (editor: BlockNoteEditor): Node | null => {
    const view = getLiveProseMirrorView(editor)
    if (!view) return null
    return view.domAtPos(view.state.selection.from).node
  }

  it('returns null instead of throwing on an unmounted editor', () => {
    expect(resolveFocus(unmountedEditor())).toBeNull()
  })

  it('still resolves a node on a mounted editor', () => {
    expect(resolveFocus(mountEditor())).toBeTruthy()
  })
})

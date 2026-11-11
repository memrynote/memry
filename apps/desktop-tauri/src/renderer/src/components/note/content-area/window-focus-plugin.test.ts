import { afterEach, describe, expect, it, vi } from 'vitest'
import { BlockNoteEditor } from '@blocknote/core'
import { SuggestionMenu } from '@blocknote/core/extensions'
import { registerEditorPlugin } from './register-editor-plugin'
import { createWindowFocusPlugin } from './window-focus-plugin'

// Default BlockNote schema: the custom schema's block specs drag react-pdf into
// jsdom, and none of them takes part in focus handling.

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  vi.restoreAllMocks()
})

function editorWithOpenSlashMenu(): BlockNoteEditor {
  // The menu view positions itself from the trigger's rect; jsdom's has no `toJSON`.
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(
    Object.assign(new DOMRect(), { toJSON: () => ({}) })
  )
  const editor = BlockNoteEditor.create()
  const el = document.createElement('div')
  document.body.appendChild(el)
  editor.mount(el)
  const unregister = registerEditorPlugin(editor, createWindowFocusPlugin(), (p, ps) => [p, ...ps])
  cleanups.push(() => {
    unregister?.()
    editor.unmount()
    el.remove()
  })

  const menu = editor.getExtension(SuggestionMenu)!
  menu.addSuggestionMenu({ triggerCharacter: '/' })
  editor.prosemirrorView.dom.focus()
  menu.openSuggestionMenu('/', { deleteTriggerCharacter: true })
  editor.insertInlineContent('tabl')
  expect(menu.shown()).toBe(true)
  return editor
}

const dispatch = (editor: BlockNoteEditor, type: 'blur' | 'focus'): void => {
  editor.prosemirrorView.dom.dispatchEvent(new FocusEvent(type))
}

describe('window focus plugin', () => {
  it('keeps the slash menu open when the app window loses and regains focus', () => {
    const editor = editorWithOpenSlashMenu()
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(false)

    dispatch(editor, 'blur')
    hasFocus.mockReturnValue(true)
    dispatch(editor, 'focus')

    expect(editor.getExtension(SuggestionMenu)!.shown()).toBe(true)
  })

  it('still closes the slash menu when focus moves elsewhere in the app', () => {
    const editor = editorWithOpenSlashMenu()
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)

    dispatch(editor, 'blur')

    expect(editor.getExtension(SuggestionMenu)!.shown()).toBe(false)
  })
})

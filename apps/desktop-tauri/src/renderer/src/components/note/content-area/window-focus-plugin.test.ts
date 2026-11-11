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
    // WebKitGTK sends two focus events when the window comes back (Linux VM, #3967).
    dispatch(editor, 'focus')
    dispatch(editor, 'focus')

    expect(editor.getExtension(SuggestionMenu)!.shown()).toBe(true)
  })

  it('still closes the slash menu when focus moves elsewhere in the app', () => {
    const editor = editorWithOpenSlashMenu()
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)

    dispatch(editor, 'blur')

    expect(editor.getExtension(SuggestionMenu)!.shown()).toBe(false)
  })

  it('handles focus normally again after a real blur that follows a window switch', () => {
    const editor = editorWithOpenSlashMenu()
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    dispatch(editor, 'blur')
    hasFocus.mockReturnValue(true)
    dispatch(editor, 'focus')

    dispatch(editor, 'blur')
    expect(editor._tiptapEditor.isFocused).toBe(false)
    dispatch(editor, 'focus')
    expect(editor._tiptapEditor.isFocused).toBe(true)
  })

  // #4244: a dialog that closes while the app is in the background moves focus with `.focus()`.
  // The editor, blurred by the window switch, sees no second blur, and kept the menu open.
  it('closes the slash menu when focus moved elsewhere while the window was in the background', async () => {
    const editor = editorWithOpenSlashMenu()
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    dispatch(editor, 'blur')
    const input = document.createElement('input')
    document.body.appendChild(input)
    cleanups.push(() => input.remove())
    input.focus()

    hasFocus.mockReturnValue(true)
    window.dispatchEvent(new FocusEvent('focus'))
    await nextFrame()

    expect(editor.getExtension(SuggestionMenu)!.shown()).toBe(false)
    expect(editor._tiptapEditor.isFocused).toBe(false)
  })

  it('keeps the slash menu open when the window comes back with the editor focused', async () => {
    const editor = editorWithOpenSlashMenu()
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    dispatch(editor, 'blur')

    hasFocus.mockReturnValue(true)
    window.dispatchEvent(new FocusEvent('focus'))
    await nextFrame()

    expect(editor.getExtension(SuggestionMenu)!.shown()).toBe(true)
  })

  // #4244: focus moving into an embed's iframe can blur the editor while the document reports no
  // focus yet; once it does, the blur was a move inside the app.
  it('closes the slash menu when the document has focus again a frame after the blur', async () => {
    const editor = editorWithOpenSlashMenu()
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    const iframe = document.createElement('iframe')
    document.body.appendChild(iframe)
    cleanups.push(() => iframe.remove())
    iframe.focus()
    hasFocus.mockReturnValue(true)
    await nextFrame()

    expect(editor.getExtension(SuggestionMenu)!.shown()).toBe(false)
  })
})

const nextFrame = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)))

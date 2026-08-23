import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import type React from 'react'

const { AIExtensionMock, DefaultChatTransportMock } = vi.hoisted(() => ({
  AIExtensionMock: vi.fn((config: unknown) => ({ name: 'ai', config })),
  DefaultChatTransportMock: vi.fn(function DefaultChatTransport(config: unknown) {
    return config
  })
}))

vi.mock('@blocknote/xl-ai', () => ({
  AIExtension: AIExtensionMock
}))

vi.mock('ai', () => ({
  DefaultChatTransport: DefaultChatTransportMock
}))

import { useBlockNoteSetup } from './use-block-note-setup'

function createEditor(options?: { registerCreatesExtension?: boolean }) {
  let aiExtension: unknown = null
  const registerCreatesExtension = options?.registerCreatesExtension ?? true

  const editor = {
    getExtension: vi.fn((name: string) => (name === 'ai' ? aiExtension : null)),
    registerExtension: vi.fn((extension: unknown) => {
      if (registerCreatesExtension) {
        aiExtension = extension
      }
    }),
    unregisterExtension: vi.fn((name: string) => {
      if (name === 'ai') {
        aiExtension = null
      }
    }),
    focus: vi.fn(),
    setTextCursorPosition: vi.fn(),
    isEditable: true,
    document: [] as Array<{ id: string }>
  }

  return { editor, getAIExtension: () => aiExtension }
}

/**
 * Build the real editor DOM shape — `.bn-container` (the ref'd element) wrapping
 * a `.bn-editor` surface — and attach it to the document so an unscoped
 * `document.querySelector('.bn-editor')` can find it too.
 */
function mountEditorSurface(container: HTMLElement, href: string): HTMLElement {
  const editorElement = document.createElement('div')
  editorElement.className = 'bn-editor'
  editorElement.innerHTML = `
      <button data-wiki-link data-target=" Launch Plan ">wiki</button>
      <a href="${href}">external</a>
      <a href="#local">local</a>
    `
  container.appendChild(editorElement)
  if (!container.isConnected) document.body.appendChild(container)
  return editorElement
}

/** One split-view pane: its own container, its own `.bn-editor`, its own callbacks. */
function createPane(href: string) {
  const container = document.createElement('div')
  container.className = 'bn-container'
  const editorElement = mountEditorSurface(container, href)
  const { editor } = createEditor()
  const onLinkClick = vi.fn()

  return {
    container,
    editor,
    onLinkClick,
    params: {
      editorContainerRef: { current: container } as React.RefObject<HTMLDivElement | null>,
      onLinkClick
    },
    clickExternalLink: (): void => {
      editorElement
        .querySelector(`a[href="${href}"]`)!
        .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    }
  }
}

describe('useBlockNoteSetup', () => {
  let editorContainerRef: React.RefObject<HTMLDivElement | null>

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
    editorContainerRef = { current: document.createElement('div') }
    document.body.innerHTML = ''
  })

  afterEach(() => {
    vi.useRealTimers()
    document.body.innerHTML = ''
    delete (window as unknown as { __memryEditor?: unknown }).__memryEditor
  })

  it('keeps aiReady false until the editor exposes the ai extension', async () => {
    const { editor } = createEditor({ registerCreatesExtension: false })

    const { result } = renderHook(() =>
      useBlockNoteSetup({
        editor,
        aiPort: 4315,
        editorContainerRef
      })
    )

    await waitFor(() => {
      expect(editor.registerExtension).toHaveBeenCalledTimes(1)
    })

    expect(result.current.aiReady).toBe(false)
  })

  it('marks aiReady true after registering the ai extension', async () => {
    const { editor, getAIExtension } = createEditor()

    const { result, unmount } = renderHook(() =>
      useBlockNoteSetup({
        editor,
        aiPort: 4315,
        editorContainerRef
      })
    )

    await waitFor(() => {
      expect(result.current.aiReady).toBe(true)
    })

    expect(DefaultChatTransportMock).toHaveBeenCalledWith({
      api: 'http://127.0.0.1:4315/api/ai/chat'
    })
    expect(AIExtensionMock).toHaveBeenCalledTimes(1)
    expect(getAIExtension()).toBeTruthy()

    unmount()

    expect(editor.unregisterExtension).toHaveBeenCalledWith('ai')
  })

  it('exposes and clears the active editor for e2e instrumentation', () => {
    const { editor } = createEditor()

    const { result, unmount } = renderHook(() =>
      useBlockNoteSetup({
        editor,
        aiPort: null,
        editorContainerRef
      })
    )

    expect(result.current.aiReady).toBe(false)
    expect((window as unknown as { __memryEditor?: unknown }).__memryEditor).toBe(editor)

    unmount()

    expect((window as unknown as { __memryEditor?: unknown }).__memryEditor).toBeUndefined()
    expect(editor.registerExtension).not.toHaveBeenCalled()
  })

  it('does not expose read-only editors as the menu-command target', () => {
    const { editor } = createEditor()
    editor.isEditable = false

    const { unmount } = renderHook(() =>
      useBlockNoteSetup({
        editor,
        aiPort: null,
        editorContainerRef
      })
    )

    expect((window as unknown as { __memryEditor?: unknown }).__memryEditor).toBeUndefined()
    unmount()
  })

  it('keeps another live editor registered when a later mount unmounts', () => {
    const { editor: noteEditor } = createEditor()
    ;(window as unknown as { __memryEditor?: unknown }).__memryEditor = noteEditor

    const { editor: previewEditor } = createEditor()
    const { unmount } = renderHook(() =>
      useBlockNoteSetup({
        editor: previewEditor,
        aiPort: null,
        editorContainerRef
      })
    )
    expect((window as unknown as { __memryEditor?: unknown }).__memryEditor).toBe(previewEditor)

    // Re-register the note editor (its own effect would do this on focus/remount
    // in the app); the preview's later cleanup must not clobber it.
    ;(window as unknown as { __memryEditor?: unknown }).__memryEditor = noteEditor
    unmount()

    expect((window as unknown as { __memryEditor?: unknown }).__memryEditor).toBe(noteEditor)
  })

  it('syncs spellcheck and focus-at-end behavior into the editor DOM', () => {
    const { editor } = createEditor()
    const contentEditable = document.createElement('div')
    contentEditable.setAttribute('contenteditable', 'true')
    editorContainerRef.current!.appendChild(contentEditable)
    editor.document = [{ id: 'first' }, { id: 'last' }]
    editor.setTextCursorPosition = vi.fn()
    const focusAtEndRef: React.RefObject<(() => void) | null> = { current: null }

    renderHook(() =>
      useBlockNoteSetup({
        editor,
        spellCheck: true,
        focusAtEndRef,
        editorContainerRef
      })
    )

    expect(contentEditable.spellcheck).toBe(true)

    focusAtEndRef.current?.()

    expect(editor.focus).toHaveBeenCalled()
    expect(editor.setTextCursorPosition).toHaveBeenCalledWith('last', 'end')
  })

  /**
   * Wiki links are deliberately NOT in this listener any more.
   *
   * The chip is hidden the moment the caret lands beside it, which on a real
   * click happens before mouseup — so the `click` event's target is the
   * paragraph, not the chip, and a DOM handler here can never see it.
   * `createWikiLinkEditPlugin`'s `handleClickOn` owns navigation now, off the
   * position ProseMirror captured at mousedown. Both would mean two
   * navigations per fast click, so the assertion that nothing fires here is as
   * load-bearing as the external-link half.
   */
  it('routes external link clicks from the editor surface, and leaves wiki links alone', () => {
    const { editor } = createEditor()
    const onLinkClick = vi.fn()
    const wikiEvent = vi.fn()
    const editorElement = mountEditorSurface(editorContainerRef.current!, 'https://memry.app')
    window.addEventListener('wikilink:click', wikiEvent)

    const { unmount } = renderHook(() =>
      useBlockNoteSetup({
        editor,
        editorContainerRef,
        onLinkClick
      })
    )

    editorElement
      .querySelector('[data-wiki-link]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    editorElement
      .querySelector('a[href="https://memry.app"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    editorElement
      .querySelector('a[href="#local"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))

    expect(wikiEvent).not.toHaveBeenCalled()
    expect(onLinkClick).toHaveBeenCalledWith('https://memry.app')
    expect(onLinkClick).toHaveBeenCalledTimes(1)

    unmount()
    window.removeEventListener('wikilink:click', wikiEvent)
  })

  it('binds each split-view pane to its own editor surface', () => {
    const left = createPane('https://left.example')
    const right = createPane('https://right.example')

    renderHook(() => useBlockNoteSetup({ editor: left.editor, ...left.params }))
    renderHook(() => useBlockNoteSetup({ editor: right.editor, ...right.params }))

    left.clickExternalLink()

    expect(left.onLinkClick).toHaveBeenCalledTimes(1)
    expect(left.onLinkClick).toHaveBeenCalledWith('https://left.example')
    expect(right.onLinkClick).not.toHaveBeenCalled()

    right.clickExternalLink()

    expect(right.onLinkClick).toHaveBeenCalledTimes(1)
    expect(right.onLinkClick).toHaveBeenCalledWith('https://right.example')
    expect(left.onLinkClick).toHaveBeenCalledTimes(1)
  })

  it('keeps the surviving pane wired after the other split-view pane unmounts', () => {
    const left = createPane('https://left.example')
    const right = createPane('https://right.example')

    const leftHook = renderHook(() => useBlockNoteSetup({ editor: left.editor, ...left.params }))
    renderHook(() => useBlockNoteSetup({ editor: right.editor, ...right.params }))

    leftHook.unmount()
    left.container.remove()

    right.clickExternalLink()

    expect(right.onLinkClick).toHaveBeenCalledWith('https://right.example')
    expect(left.onLinkClick).not.toHaveBeenCalled()
  })

  it('opens the AI menu with the keyboard shortcut when a block is selected', async () => {
    vi.useFakeTimers()
    const aiExtension = { openAIMenuAtBlock: vi.fn() }
    const editor = {
      getExtension: vi.fn(() => aiExtension),
      registerExtension: vi.fn(),
      unregisterExtension: vi.fn(),
      getTextCursorPosition: vi.fn(() => ({ block: { id: 'block-1' } })),
      focus: vi.fn(),
      document: []
    }

    renderHook(() =>
      useBlockNoteSetup({
        editor,
        aiPort: 4315,
        editorContainerRef
      })
    )

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', metaKey: true }))
    })

    expect(aiExtension.openAIMenuAtBlock).toHaveBeenCalledWith('block-1')
  })

  it('scrolls to and highlights initial text matches', () => {
    vi.useFakeTimers()
    const { editor } = createEditor()
    const paragraph = document.createElement('p')
    paragraph.textContent = 'Ship the launch memo today'
    paragraph.scrollIntoView = vi.fn()
    editorContainerRef.current!.appendChild(paragraph)

    renderHook(() =>
      useBlockNoteSetup({
        editor,
        editorContainerRef,
        initialHighlight: { text: 'launch memo' }
      })
    )

    act(() => {
      vi.advanceTimersByTime(500)
    })

    expect(paragraph.scrollIntoView).toHaveBeenCalledWith({
      behavior: 'smooth',
      block: 'center'
    })
    expect(paragraph.style.backgroundColor).toBe('rgba(251, 191, 36, 0.4)')

    act(() => {
      vi.advanceTimersByTime(3000)
    })

    expect(paragraph.style.backgroundColor).toBe('')
  })
})

/**
 * Regression for #2210: the switch-vault shortcut must fire with the caret
 * inside a real note editor, not just a stub contenteditable div. BlockNote's
 * own DOM keydown handling is what swallowed the chord before it reached the
 * app-level listener, so the test has to mount an actual BlockNoteEditor and
 * dispatch the keydown on its real ProseMirror DOM node — a fake editor proves
 * nothing about BlockNote's key handling.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { BlockNoteEditor } from '@blocknote/core'
import { useSwitchVaultShortcut } from './use-switch-vault-shortcut'

// SAFETY: mirrors live-prosemirror-view.test.ts's accessor for the private
// tiptap editor instance BlockNote keeps on itself; there is no public API.
const tiptapOf = (editor: BlockNoteEditor): any => (editor as any)._tiptapEditor

const mounted: Array<{ editor: BlockNoteEditor; el: HTMLElement }> = []

afterEach(() => {
  for (const { editor, el } of mounted.splice(0)) {
    tiptapOf(editor).unmount()
    el.remove()
  }
  document.body.innerHTML = ''
})

function mountEditor(): BlockNoteEditor {
  const editor = BlockNoteEditor.create()
  const el = document.createElement('div')
  document.body.appendChild(el)
  editor.mount(el)
  mounted.push({ editor, el })
  return editor
}

describe('useSwitchVaultShortcut with a real editor', () => {
  it('fires ⌘⇧O / Ctrl+Shift+O when the caret sits in a mounted BlockNote editor', () => {
    const editor = mountEditor()
    const view = editor.prosemirrorView
    view.dom.focus()
    expect(document.activeElement).toBe(view.dom)

    const onOpen = vi.fn()
    renderHook(() => useSwitchVaultShortcut(onOpen))

    // Both meta and ctrl set so the assertion holds regardless of which the
    // suite's jsdom platform reports as "the" modifier.
    const fired = view.dom.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'o',
        metaKey: true,
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true
      })
    )

    expect(onOpen).toHaveBeenCalledTimes(1)
    // preventDefault ran, so ProseMirror's own handler never saw an unhandled key.
    expect(fired).toBe(false)
  })
})

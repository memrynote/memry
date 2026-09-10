// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BlockNoteEditor } from '@blocknote/core'

import { createMobileEditorSchema } from '../../editor-web/src/schema'
import {
  installBlockMenu,
  type BlockMenuBridge,
  type BlockMenuEditorSurface
} from '../../editor-web/src/block-menu'
import {
  installEditorToolbar,
  type EditorToolbarActions,
  type EditorToolbarController
} from '../../editor-web/src/editor-toolbar'

/**
 * The long-press gates against the DOM BlockNote actually renders (#2100).
 *
 * `block-menu.test.ts` drives the gates over a hand-built fixture, which is
 * fast and legible and cannot tell you whether the fixture is a fair copy. This
 * file mounts a REAL editor and long-presses the elements a finger would land
 * on, so the shape of BlockNote's output is a thing the suite knows rather than
 * a thing it assumes.
 *
 * It caught the first version of gate 1. That version rejected any press whose
 * nearest `[contenteditable]` ancestor read `true`, on the belief that
 * ProseMirror marks its atoms `false` — and this build marks nothing below the
 * editor root at all, so the gate refused every press in the document,
 * including the image it exists to allow.
 */

function harness(blocks: readonly Record<string, unknown>[]) {
  document.body.replaceChildren()
  const root = document.createElement('div')
  root.id = 'root'
  const toolbarHost = document.createElement('div')
  document.body.append(root, toolbarHost)

  const editor = BlockNoteEditor.create({ schema: createMobileEditorSchema() })
  editor.mount(root)
  editor.replaceBlocks(editor.document, blocks as never)

  const bridge: BlockMenuBridge = {
    send: vi.fn(),
    flush: vi.fn(),
    onHostMsg: () => () => {}
  }

  let toolbar: EditorToolbarController | null = null
  const actions: EditorToolbarActions = {
    insert: vi.fn(),
    tableAction: vi.fn(),
    styleAction: vi.fn(),
    turnInto: vi.fn(),
    toggleStyle: vi.fn(),
    toggleBulletedList: vi.fn(),
    createLink: vi.fn(),
    focusEditor: vi.fn(),
    insertWikiLink: vi.fn(),
    insertImage: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    dismissKeyboard: vi.fn(),
    openBlockActions: vi.fn(),
    blockAction: vi.fn()
  }
  toolbar = installEditorToolbar(toolbarHost, actions)
  toolbar.setKeyboardVisible(true)
  const menu = installBlockMenu({
    root,
    editor: editor as unknown as BlockMenuEditorSurface,
    toolbar,
    bridge,
    docId: 'note-1'
  })

  return { root, editor, menu, teardown: () => editor.unmount() }
}

/** The element under the finger: BlockNote's own rendered content for a block. */
function contentFor(type: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[data-content-type="${type}"]`)
  if (!element) throw new Error(`Missing rendered block: ${type}`)
  return element
}

function longPress(target: Element): void {
  target.dispatchEvent(
    new PointerEvent('pointerdown', { button: 0, clientX: 40, clientY: 40, bubbles: true })
  )
  vi.advanceTimersByTime(450)
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('long-press against a mounted BlockNote editor', () => {
  it('opens the panel from the image BlockNote rendered', () => {
    const app = harness([
      { type: 'paragraph', content: 'Hello there' },
      { type: 'image', props: { url: 'a.png' } }
    ])

    longPress(contentFor('image'))

    expect(document.querySelector('[aria-label="Image"]')).not.toBeNull()
    // The ring landed on the image's own outer element, found by id in the
    // real DOM rather than in a fixture.
    const ringed = app.root.querySelector('[data-memry-block-action]')
    expect(ringed?.getAttribute('data-id')).toBe(app.editor.document[1].id)
    app.teardown()
  })

  it('leaves a paragraph and a table cell to the loupe', () => {
    const app = harness([
      { type: 'paragraph', content: 'Hello there' },
      {
        type: 'table',
        content: {
          type: 'tableContent',
          rows: [{ cells: [[{ type: 'text', text: 'cell', styles: {} }]] }]
        }
      }
    ])

    const paragraphText = contentFor('paragraph').firstElementChild
    longPress(paragraphText ?? contentFor('paragraph'))
    expect(document.querySelector('.editor-block-actions')).toBeNull()

    // A table's cells ARE editable text, so a competing timer there is the
    // loupe's fight to lose. The table stays reachable from the toolbar's `•••`.
    const cell = contentFor('table').querySelector('td p')
    expect(cell).not.toBeNull()
    longPress(cell!)
    expect(document.querySelector('.editor-block-actions')).toBeNull()
    app.teardown()
  })

  it('pins what the gates are actually reading', () => {
    // The premise the gates rest on, asserted rather than believed. If a
    // BlockNote upgrade starts marking atoms `contenteditable="false"`, or
    // stops putting `data-id` on `.bn-block-outer`, this fails here — next to
    // the comment that explains why the gate is written the way it is — instead
    // of silently turning a gate into a no-op somewhere else.
    const app = harness([
      { type: 'paragraph', content: 'Hello there' },
      { type: 'image', props: { url: 'a.png' } },
      { type: 'divider' }
    ])

    const editable = [...document.querySelectorAll('[contenteditable]')]
    expect(editable).toHaveLength(1)
    expect(editable[0]).toBe(app.root)
    expect(app.root.getAttribute('contenteditable')).toBe('true')

    for (const type of ['paragraph', 'image', 'divider']) {
      // Nothing below the root carries the attribute, in either direction.
      expect(contentFor(type).hasAttribute('contenteditable')).toBe(false)
      expect(contentFor(type).closest('.bn-block-outer[data-id]')).not.toBeNull()
    }
    app.teardown()
  })
})

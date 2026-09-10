// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'

import { BlockNoteEditor, defaultProps } from '@blocknote/core'
import { serializeBlockAlignMarker, sidecarMarkerLines } from '@memry/shared/block-markers'

import { createMobileEditorSchema } from '../../editor-web/src/schema'
import { runStyleAction, type StyleEditorSurface } from '../../editor-web/src/block-styles'
import {
  BLOCK_COLOURS,
  installEditorToolbar,
  type EditorToolbarActions,
  type EditorToolbarSelection
} from '../../editor-web/src/editor-toolbar'

/**
 * Alignment, colour and nesting in the guest (#2102).
 *
 * The point of these assertions is the WIRE, not the widget: mobile has to
 * write the props and styles desktop already reads, so a note styled on a
 * phone opens on a desktop that predates this panel.
 */

function toolbarActions(): EditorToolbarActions {
  return {
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
}

function button(name: string): HTMLButtonElement {
  const match = [...document.querySelectorAll('button')].find(
    (candidate) => candidate.getAttribute('aria-label') === name
  )
  if (!(match instanceof HTMLButtonElement)) throw new Error(`Missing button: ${name}`)
  return match
}

function selection(overrides: Partial<EditorToolbarSelection> = {}): EditorToolbarSelection {
  return {
    blockLabel: 'T',
    table: null,
    alignment: 'left',
    textColour: 'default',
    backgroundColour: 'default',
    canNest: true,
    canUnnest: true,
    activeStyles: { bold: false, italic: false, underline: false, strike: false, code: false },
    ...overrides
  }
}

function mountToolbar(overrides: Partial<EditorToolbarSelection> = {}) {
  document.body.replaceChildren()
  const actions = toolbarActions()
  const host = document.createElement('div')
  document.body.appendChild(host)
  const controller = installEditorToolbar(host, actions)
  controller.setKeyboardVisible(true)
  controller.update(selection(overrides))
  return { actions, controller }
}

function openStylePanel(overrides: Partial<EditorToolbarSelection> = {}): EditorToolbarActions {
  const { actions } = mountToolbar(overrides)
  button('Formatting').click()
  button('Style').click()
  return actions
}

describe('style panel', () => {
  it('dispatches alignment, colour and nesting and stays open between taps', () => {
    const actions = openStylePanel()

    expect(document.querySelector('[aria-label="Style"][aria-pressed="true"]')).not.toBeNull()

    button('Align centre').click()
    button('Text colour: red').click()
    button('Highlight: yellow').click()
    button('Indent').click()
    button('Outdent').click()

    expect(actions.styleAction).toHaveBeenNthCalledWith(1, { kind: 'align', alignment: 'center' })
    expect(actions.styleAction).toHaveBeenNthCalledWith(2, { kind: 'text-colour', colour: 'red' })
    expect(actions.styleAction).toHaveBeenNthCalledWith(3, {
      kind: 'background-colour',
      colour: 'yellow'
    })
    expect(actions.styleAction).toHaveBeenNthCalledWith(4, { kind: 'nest' })
    expect(actions.styleAction).toHaveBeenNthCalledWith(5, { kind: 'unnest' })
    // Five taps, one panel: styling is a nudge-and-look loop, not an insertion.
    expect(document.querySelector('[aria-label="Style"]')).not.toBeNull()
  })

  it('offers the desktop palette and checks the active colour', () => {
    openStylePanel({ textColour: 'blue', backgroundColour: 'pink' })

    for (const colour of BLOCK_COLOURS) {
      expect(button(`Text colour: ${colour}`)).toBeInstanceOf(HTMLButtonElement)
      expect(button(`Highlight: ${colour}`)).toBeInstanceOf(HTMLButtonElement)
    }
    expect(button('Text colour: blue').getAttribute('aria-pressed')).toBe('true')
    expect(button('Text colour: red').getAttribute('aria-pressed')).toBe('false')
    expect(button('Highlight: pink').getAttribute('aria-pressed')).toBe('true')
  })

  it('hides alignment on a block that has no textAlignment prop, and locks nesting', () => {
    openStylePanel({ alignment: null, canNest: false, canUnnest: false })

    expect(document.querySelector('[aria-label="Align left"]')).toBeNull()
    expect(button('Indent').disabled).toBe(true)
    expect(button('Outdent').disabled).toBe(true)
    // Colour is still on offer: it is a style on the selected text, not a
    // block prop, so it applies inside a table cell too.
    expect(button('Text colour: red')).toBeInstanceOf(HTMLButtonElement)
  })

  it('checks the alignment the block already carries', () => {
    openStylePanel({ alignment: 'right' })

    expect(button('Align right').getAttribute('aria-pressed')).toBe('true')
    expect(button('Align left').getAttribute('aria-pressed')).toBe('false')
  })

  it('closes the panel when the keyboard comes back, instead of stacking on it', () => {
    const { controller } = mountToolbar()
    button('Formatting').click()
    button('Style').click()
    // Opening the panel replaces the keyboard, which is what the host reports.
    controller.setKeyboardVisible(false)
    expect(controller.isPanelOpen()).toBe(true)

    // A tap into the note raises the keyboard again.
    controller.setKeyboardVisible(true)

    expect(controller.isPanelOpen()).toBe(false)
    expect(document.querySelector('[aria-label="Align left"]')).toBeNull()
    // Back on the formatting row the Style button came from, not the main one.
    expect(button('Style').getAttribute('aria-pressed')).toBe('false')
  })

  it('keeps the link prompt open when its own input raises the keyboard', () => {
    const { controller } = mountToolbar()
    button('Formatting').click()
    button('Link').click()
    expect(controller.isPanelOpen()).toBe(true)

    // iOS can drop the keyboard as the tap blurs ProseMirror and raise it
    // again when the URL field takes focus. That is the prompt's own input,
    // not a tap into the note.
    controller.setKeyboardVisible(false)
    controller.setKeyboardVisible(true)

    expect(controller.isPanelOpen()).toBe(true)
    expect(document.querySelector('[aria-label="Link URL"]')).not.toBeNull()
  })
})

function editor() {
  return BlockNoteEditor.create({ schema: createMobileEditorSchema() })
}

/** `runStyleAction` takes the narrow surface; a real editor satisfies it. */
function surface(instance: ReturnType<typeof editor>): StyleEditorSurface {
  return instance as unknown as StyleEditorSurface
}

/** The inline styles the first run of the first block carries on disk. */
function styles(instance: ReturnType<typeof editor>): Record<string, unknown> {
  const content = instance.document[0].content as { styles: Record<string, unknown> }[]
  return content[0].styles
}

describe('style actions against a real editor', () => {
  it('writes the same textAlignment prop desktop reads back', () => {
    const instance = editor()
    instance.replaceBlocks(instance.document, [{ type: 'paragraph', content: 'Centred' }])
    instance.setTextCursorPosition(instance.document[0])

    runStyleAction(surface(instance), { kind: 'align', alignment: 'center' })

    const block = instance.document[0]
    // The prop mobile writes is BlockNote's own default prop — the exact one
    // desktop's `TextAlignButton` reads and writes.
    expect('textAlignment' in defaultProps).toBe(true)
    expect(block.props).toMatchObject({ textAlignment: 'center' })
    // And it is the value the shared markdown marker serializes, so the note
    // on disk is byte-identical to one centred on desktop.
    const marked = block as unknown as { props: Record<string, unknown>; content: unknown }
    expect(serializeBlockAlignMarker(marked.props)).toBe('<!-- align:center -->')
    expect(sidecarMarkerLines(marked as Parameters<typeof sidecarMarkerLines>[0])).toEqual([
      '<!-- align:center -->'
    ])
  })

  it('leaves a block with no textAlignment prop untouched', () => {
    const instance = editor()
    instance.replaceBlocks(instance.document, [{ type: 'divider' }])
    instance.setTextCursorPosition(instance.document[0])
    const before = { ...instance.document[0].props }

    runStyleAction(surface(instance), { kind: 'align', alignment: 'right' })

    expect(instance.document[0].props).toEqual(before)
  })

  it('adds a palette colour as a style and clears it with default', () => {
    const instance = editor()
    instance.replaceBlocks(instance.document, [
      { type: 'paragraph', content: 'Text' },
      { type: 'paragraph', content: 'More' }
    ])
    // A range, not a caret: a collapsed selection only ever produces stored
    // marks, which need a mounted view to survive.
    instance.setSelection(instance.document[0].id, instance.document[1].id)

    runStyleAction(surface(instance), { kind: 'text-colour', colour: 'red' })
    runStyleAction(surface(instance), { kind: 'background-colour', colour: 'yellow' })
    expect(styles(instance)).toEqual({ textColor: 'red', backgroundColor: 'yellow' })

    runStyleAction(surface(instance), { kind: 'text-colour', colour: 'default' })
    // Removed, not set to the string `default`: an explicit `default` would
    // write a colour marker for a run nobody coloured.
    expect(styles(instance)).toEqual({ backgroundColor: 'yellow' })
  })

  it('nests and unnests through the editor commands Tab already runs', () => {
    const instance = editor()
    instance.replaceBlocks(instance.document, [
      { type: 'bulletListItem', content: 'One' },
      { type: 'bulletListItem', content: 'Two' }
    ])
    instance.setTextCursorPosition(instance.document[1])

    expect(instance.canNestBlock()).toBe(true)
    runStyleAction(surface(instance), { kind: 'nest' })

    expect(instance.document).toHaveLength(1)
    expect(instance.document[0].children).toHaveLength(1)

    instance.setTextCursorPosition(instance.document[0].children[0])
    runStyleAction(surface(instance), { kind: 'unnest' })

    expect(instance.document).toHaveLength(2)
    expect(instance.document[0].children).toHaveLength(0)
  })

  it('does nothing when the caret cannot be nested any further', () => {
    const instance = editor()
    instance.replaceBlocks(instance.document, [{ type: 'paragraph', content: 'Only' }])
    instance.setTextCursorPosition(instance.document[0])
    const before = instance.document.length

    expect(instance.canNestBlock()).toBe(false)
    runStyleAction(surface(instance), { kind: 'nest' })
    runStyleAction(surface(instance), { kind: 'unnest' })

    expect(instance.document).toHaveLength(before)
  })
})

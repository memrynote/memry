/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Pasting or dropping an image into a table cell (#1640).
 *
 * The two things worth gating here are both about restraint: the handlers must
 * fire when the caret really is in a cell, and must not touch the event at all
 * otherwise — everywhere else BlockNote's own image-BLOCK path is the correct
 * behaviour and has to keep running untouched.
 */

import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { isSelectionInTableCell, useTableCellImage } from './use-table-cell-image'

const mocks = vi.hoisted(() => ({
  uploadAttachment: vi.fn(),
  error: vi.fn(),
  toastError: vi.fn(),
  trackRendererError: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { error: mocks.toastError, success: vi.fn() } }))

vi.mock('@/services/notes-service', () => ({
  notesService: { uploadAttachment: mocks.uploadAttachment }
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ warn: vi.fn(), error: mocks.error, info: vi.fn(), debug: vi.fn() })
}))

vi.mock('@/lib/telemetry-diagnostics', () => ({
  trackRendererError: mocks.trackRendererError
}))

// `isImageFile` is shared with the file-upload hook, whose module pulls the
// `file` block — and that pulls pdf.js, which touches `DOMMatrix` at import
// time under jsdom. Nothing in this file needs the block itself.
vi.mock('../file-block', () => ({
  createFileBlockContent: (props: Record<string, unknown>) => ({ type: 'file', props })
}))

// A real `TextSelection.create` needs a real ProseMirror document; this suite
// drives a fake view on purpose, so what is asserted is that the drop position
// is what gets selected — not ProseMirror's own arithmetic.
vi.mock('@tiptap/pm/state', () => ({
  TextSelection: { create: (_doc: unknown, pos: number) => ({ selectedPos: pos }) }
}))

const PNG = (): File => new File(['x'], 'shot.png', { type: 'image/png' })

/** A resolved position whose ancestor chain is the given node names, outermost first. */
function selectionIn(...names: string[]) {
  return {
    selection: {
      $from: {
        depth: names.length,
        node: (depth: number) => ({ type: { name: names[depth - 1] } })
      }
    }
  }
}

function makeEditor(state: unknown) {
  return {
    insertInlineContent: vi.fn(),
    prosemirrorView: {
      state,
      dispatch: vi.fn(),
      posAtCoords: vi.fn(() => ({ pos: 4, inside: 3 }))
    }
  }
}

function mount(editor: unknown, container: HTMLDivElement, noteId: string | undefined = 'n1') {
  return renderHook(() =>
    useTableCellImage({
      editor,
      editable: true,
      containerRef: { current: container },
      noteIdRef: { current: noteId }
    })
  )
}

/** The surface mounts with no note on the journal's empty day and mid-navigation. */
function mountWithoutNote(editor: unknown, container: HTMLDivElement) {
  return renderHook(() =>
    useTableCellImage({
      editor,
      editable: true,
      containerRef: { current: container },
      noteIdRef: { current: undefined }
    })
  )
}

function paste(container: HTMLElement, files: File[]): ClipboardEvent {
  const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
  Object.defineProperty(event, 'clipboardData', { value: { files } })
  container.dispatchEvent(event)
  return event
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.uploadAttachment.mockResolvedValue({ success: true, path: '../attachments/n1/shot.png' })
})

describe('isSelectionInTableCell', () => {
  it('sees a caret inside a body cell', () => {
    expect(isSelectionInTableCell(selectionIn('table', 'tableRow', 'tableCell', 'text'))).toBe(true)
  })

  it('sees a caret inside a header cell', () => {
    expect(isSelectionInTableCell(selectionIn('table', 'tableRow', 'tableHeader'))).toBe(true)
  })

  it('does not see a caret in an ordinary paragraph', () => {
    expect(isSelectionInTableCell(selectionIn('blockContainer', 'paragraph'))).toBe(false)
  })

  it('is safe with no selection at all', () => {
    expect(isSelectionInTableCell(undefined)).toBe(false)
    expect(isSelectionInTableCell({})).toBe(false)
  })
})

describe('pasting an image with the caret in a cell', () => {
  it('uploads and inserts an inlineImage instead of a block', async () => {
    // #given
    const container = document.createElement('div')
    document.body.appendChild(container)
    const editor = makeEditor(selectionIn('table', 'tableRow', 'tableCell'))
    mount(editor, container)

    // #when
    const event = paste(container, [PNG()])

    // #then BlockNote never sees the paste, so no image block is created
    expect(event.defaultPrevented).toBe(true)
    await waitFor(() => expect(editor.insertInlineContent).toHaveBeenCalled())
    expect(editor.insertInlineContent).toHaveBeenCalledWith([
      { type: 'inlineImage', props: { src: '../attachments/n1/shot.png', alt: 'shot.png' } }
    ])
  })

  it('stores the vault-relative path the upload returned', async () => {
    // #given a path that must reach the node unchanged — resolving it here is
    // what would pin the note to this machine's vault
    const container = document.createElement('div')
    document.body.appendChild(container)
    const editor = makeEditor(selectionIn('tableCell'))
    mount(editor, container)

    // #when
    paste(container, [PNG()])

    // #then
    await waitFor(() => expect(mocks.uploadAttachment).toHaveBeenCalledWith('n1', expect.any(File)))
  })

  it('leaves the paste alone when the caret is not in a cell', async () => {
    // #given the ordinary case: BlockNote's image-block path must keep working
    const container = document.createElement('div')
    document.body.appendChild(container)
    const editor = makeEditor(selectionIn('blockContainer', 'paragraph'))
    mount(editor, container)

    // #when
    const event = paste(container, [PNG()])

    // #then
    expect(event.defaultPrevented).toBe(false)
    expect(mocks.uploadAttachment).not.toHaveBeenCalled()
  })

  it('leaves a paste with no image files alone', () => {
    // #given text, a link, an HTML fragment — none of this is ours
    const container = document.createElement('div')
    document.body.appendChild(container)
    const editor = makeEditor(selectionIn('tableCell'))
    mount(editor, container)

    // #when
    const event = paste(container, [new File(['x'], 'a.pdf', { type: 'application/pdf' })])

    // #then
    expect(event.defaultPrevented).toBe(false)
    expect(mocks.uploadAttachment).not.toHaveBeenCalled()
  })

  it('reports an upload failure instead of inserting a broken node', async () => {
    // #given the reasons users actually hit: over the size cap, type not allowed
    mocks.uploadAttachment.mockResolvedValue({ success: false, error: 'File too large' })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const editor = makeEditor(selectionIn('tableCell'))
    mount(editor, container)

    // #when
    paste(container, [PNG()])

    // #then
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('File too large'))
    expect(editor.insertInlineContent).not.toHaveBeenCalled()
  })

  it('does nothing without a note to attach to', async () => {
    // #given
    const container = document.createElement('div')
    document.body.appendChild(container)
    const editor = makeEditor(selectionIn('tableCell'))
    mountWithoutNote(editor, container)

    // #when
    paste(container, [PNG()])

    // #then
    await waitFor(() => expect(mocks.uploadAttachment).not.toHaveBeenCalled())
  })
})

describe('dropping an image onto a cell', () => {
  function dropOn(target: HTMLElement, files: File[]): DragEvent {
    const event = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent
    Object.defineProperty(event, 'dataTransfer', { value: { files } })
    Object.defineProperty(event, 'clientX', { value: 10 })
    Object.defineProperty(event, 'clientY', { value: 20 })
    target.dispatchEvent(event)
    return event
  }

  function tableIn(container: HTMLElement): HTMLElement {
    container.innerHTML = '<table><tbody><tr><td id="cell">x</td></tr></tbody></table>'
    return container.querySelector('#cell') as HTMLElement
  }

  it('moves the caret to the drop point before inserting', async () => {
    // #given a drop carries no caret, so the cell comes from the pointer
    const container = document.createElement('div')
    document.body.appendChild(container)
    const cell = tableIn(container)
    const editor = makeEditor(selectionIn('table', 'tableRow', 'tableCell'))
    ;(editor.prosemirrorView as any).state.tr = { setSelection: (s: unknown) => s }
    ;(editor.prosemirrorView as any).state.doc = { resolve: () => ({}) }
    mount(editor, container)

    // #when
    const event = dropOn(cell, [PNG()])

    // #then
    expect(event.defaultPrevented).toBe(true)
    expect(editor.prosemirrorView.posAtCoords).toHaveBeenCalledWith({ left: 10, top: 20 })
    // the caret is moved to the drop position, not left wherever it was
    expect(editor.prosemirrorView.dispatch).toHaveBeenCalledWith({ selectedPos: 4 })
    await waitFor(() => expect(editor.insertInlineContent).toHaveBeenCalled())
  })

  it('leaves a drop outside a table to the existing block path', () => {
    // #given
    const container = document.createElement('div')
    document.body.appendChild(container)
    const plain = document.createElement('p')
    container.appendChild(plain)
    const editor = makeEditor(selectionIn('blockContainer', 'paragraph'))
    mount(editor, container)

    // #when
    const event = dropOn(plain, [PNG()])

    // #then
    expect(event.defaultPrevented).toBe(false)
    expect(mocks.uploadAttachment).not.toHaveBeenCalled()
  })
})

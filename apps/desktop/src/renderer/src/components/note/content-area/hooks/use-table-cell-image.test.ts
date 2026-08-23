/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Pasting or dropping an image into a table cell (#1640).
 *
 * The two things worth gating here are both about restraint: the handlers must
 * fire when the caret really is in a cell, and must not touch the event at all
 * otherwise — everywhere else BlockNote's own image-BLOCK path is the correct
 * behaviour and has to keep running untouched.
 *
 * The "is the caret in a cell" predicate itself is not re-tested here: it is
 * `table-cell-paste.ts`'s, shared with the plain-text paste guard, and covered
 * against a real mounted editor in `table-cell-paste.integration.test.ts`.
 */

import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useTableCellImage } from './use-table-cell-image'

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

/**
 * A resolved position whose ancestor chain is the given node names, outermost
 * first — the shape `isSelectionInTableCell` walks. It reads the selection
 * through `editor.transact`, so that is what the fake editor supplies.
 */
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

function makeEditor(state: any) {
  return {
    insertInlineContent: vi.fn(),
    transact: (fn: (tr: unknown) => unknown) => fn(state),
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

/**
 * jsdom has no clipboard, so the flavours are supplied by hand — and `files`
 * plus `text/html` is exactly the split that matters here: only a screenshot or
 * a Finder copy carries a File, everything else is HTML with an `<img>` in it.
 */
function paste(container: HTMLElement, files: File[], html = ''): ClipboardEvent {
  const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
  Object.defineProperty(event, 'clipboardData', {
    value: { files, getData: (type: string) => (type === 'text/html' ? html : '') }
  })
  container.dispatchEvent(event)
  return event
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.uploadAttachment.mockResolvedValue({ success: true, path: '../attachments/n1/shot.png' })
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
      {
        type: 'inlineImage',
        props: { src: '../attachments/n1/shot.png', alt: 'shot.png', width: 0 }
      }
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

/**
 * The gesture the File branch never saw. Copying an image inside Memry, or out
 * of a web page, Google Docs, Notion or Slack, puts NO file on the clipboard —
 * BlockNote's own copy handler calls `clearData()` and writes HTML, and so does
 * the browser. Those pastes reached BlockNote, which built an image BLOCK from
 * `text/html`; a cell holds inline content only, so ProseMirror dropped it
 * without an error or a toast. That is the "images still won't paste into a
 * cell" report.
 */
describe('pasting an image that arrives as HTML with no file', () => {
  /** A real 1×1 PNG, so the base64 decode is exercised rather than mocked. */
  const PNG_DATA_URL =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

  function cellEditor(names = ['table', 'tableRow', 'tableCell']) {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const editor = makeEditor(selectionIn(...names))
    mount(editor, container)
    return { container, editor }
  }

  it('claims a remote image and inserts it as inline content', async () => {
    // #given the shape a copy from a web page, Notion or Slack arrives in
    const { container, editor } = cellEditor()

    // #when
    const event = paste(container, [], '<img src="https://cdn.example.com/chart.png" alt="chart">')

    // #then BlockNote never gets to build a block the cell cannot hold
    expect(event.defaultPrevented).toBe(true)
    await waitFor(() =>
      expect(editor.insertInlineContent).toHaveBeenCalledWith([
        {
          type: 'inlineImage',
          props: { src: 'https://cdn.example.com/chart.png', alt: 'chart', width: 0 }
        }
      ])
    )
    // an addressable URL needs no copy in the vault
    expect(mocks.uploadAttachment).not.toHaveBeenCalled()
  })

  it('keeps the width the fragment measured', async () => {
    // #given a real `width` attribute is what an HTML paste from the web carries
    const { container, editor } = cellEditor()

    // #when
    paste(container, [], '<img src="https://cdn.example.com/a.png" alt="a" width="180">')

    // #then
    await waitFor(() =>
      expect(editor.insertInlineContent).toHaveBeenCalledWith([
        {
          type: 'inlineImage',
          props: { src: 'https://cdn.example.com/a.png', alt: 'a', width: 180 }
        }
      ])
    )
  })

  it('leaves the same fragment alone outside a cell', () => {
    // #given everywhere else the image BLOCK is the right answer, and BlockNote
    // has to keep building it
    const { container, editor } = cellEditor(['blockContainer', 'paragraph'])

    // #when
    const event = paste(container, [], '<img src="https://cdn.example.com/chart.png">')

    // #then
    expect(event.defaultPrevented).toBe(false)
    expect(editor.insertInlineContent).not.toHaveBeenCalled()
  })

  it('refuses a memry-file:// src', () => {
    // #given that URL names THIS machine's vault path; written into the row it
    // resolves to nothing on any other device
    const { container, editor } = cellEditor()

    // #when
    const event = paste(
      container,
      [],
      '<img src="memry-file://local/Users/k/Vault/attachments/n1/x.png">'
    )

    // #then
    expect(event.defaultPrevented).toBe(false)
    expect(editor.insertInlineContent).not.toHaveBeenCalled()
  })

  it('keeps a relative ref that belongs to this note', async () => {
    // #given copying a picture from one cell of this note into another — the ref
    // resolves against the same note either way
    const { container, editor } = cellEditor()

    // #when
    const event = paste(container, [], '<img src="../attachments/n1/a1b2c3-shot.png" alt="shot">')

    // #then
    expect(event.defaultPrevented).toBe(true)
    await waitFor(() =>
      expect(editor.insertInlineContent).toHaveBeenCalledWith([
        {
          type: 'inlineImage',
          props: { src: '../attachments/n1/a1b2c3-shot.png', alt: 'shot', width: 0 }
        }
      ])
    )
  })

  it("refuses another note's relative ref", () => {
    // #given a ref is relative to the note it was copied FROM; kept as-is it
    // would resolve against THIS note and show a broken image, silently
    const { container, editor } = cellEditor()

    // #when
    const event = paste(container, [], '<img src="../attachments/n2/a1b2c3-shot.png">')

    // #then
    expect(event.defaultPrevented).toBe(false)
    expect(editor.insertInlineContent).not.toHaveBeenCalled()
  })

  it('leaves a mixed text-and-image fragment to the default paste', () => {
    // #given re-inserting the text through `insertInlineContent` would flatten
    // its links and bold to plain text — a worse regression than the missing
    // image. Mixed fragments stay BlockNote's, and are a known follow-up.
    const { container, editor } = cellEditor()

    // #when
    const event = paste(
      container,
      [],
      '<p>see <a href="https://x.test">this</a> <img src="https://cdn.example.com/a.png"></p>'
    )

    // #then
    expect(event.defaultPrevented).toBe(false)
    expect(editor.insertInlineContent).not.toHaveBeenCalled()
  })

  it('ignores the stylesheet Word and Google Docs ship inside the fragment', async () => {
    // #given those rules are `textContent`, and would read as "there is text
    // here" on every paste out of either app
    const { container, editor } = cellEditor()

    // #when
    const event = paste(
      container,
      [],
      '<meta charset="utf-8"><style>td{color:red}</style><b><img src="https://lh7.example.com/a.png"></b>'
    )

    // #then
    expect(event.defaultPrevented).toBe(true)
    await waitFor(() => expect(editor.insertInlineContent).toHaveBeenCalled())
  })

  it('saves a data: image as an attachment instead of writing base64 into the row', async () => {
    // #given a screenshot's base64 is megabytes, and the row is a line in the
    // note's markdown FILE
    const { container, editor } = cellEditor()

    // #when
    const event = paste(container, [], `<img src="${PNG_DATA_URL}" alt="grab">`)

    // #then the bytes go through the same upload every other image does…
    expect(event.defaultPrevented).toBe(true)
    await waitFor(() => expect(mocks.uploadAttachment).toHaveBeenCalled())
    const [noteId, file] = mocks.uploadAttachment.mock.calls[0] as [string, File]
    expect(noteId).toBe('n1')
    // the extension is what `saveAttachment` validates, so it has to be real
    expect(file.name).toBe('pasted-image.png')
    expect(file.type).toBe('image/png')

    // …and what lands in the node is the vault-relative path it returned
    await waitFor(() =>
      expect(editor.insertInlineContent).toHaveBeenCalledWith([
        { type: 'inlineImage', props: { src: '../attachments/n1/shot.png', alt: 'grab', width: 0 } }
      ])
    )
  })

  it('leaves a fragment with no image at all alone', () => {
    // #given the ordinary rich-text paste into a cell, which is not ours
    const { container, editor } = cellEditor()

    // #when
    const event = paste(container, [], '<p><strong>hello</strong></p>')

    // #then
    expect(event.defaultPrevented).toBe(false)
    expect(editor.insertInlineContent).not.toHaveBeenCalled()
  })
})

describe('picking an image for the cell (the slash menu row)', () => {
  function fileInputIn(container: HTMLElement): HTMLInputElement {
    return container.querySelector('input[type="file"]') as HTMLInputElement
  }

  /** jsdom has no file dialog, so the chosen files are put on the input by hand. */
  function choose(input: HTMLInputElement, files: File[]): void {
    Object.defineProperty(input, 'files', { value: files, configurable: true })
    input.dispatchEvent(new Event('change'))
  }

  function mountPicker(container: HTMLDivElement, editor: any) {
    ;(editor.prosemirrorView as any).state.tr = { setSelection: (sel: unknown) => sel }
    ;(editor.prosemirrorView as any).state.doc = { content: { size: 40 } }
    ;(editor.prosemirrorView as any).state.selection = {
      ...editor.prosemirrorView.state.selection,
      from: 7
    }
    ;(editor.prosemirrorView as any).focus = vi.fn()
    return mount(editor, container)
  }

  it('opens a file picker instead of inserting an image block', () => {
    // #given the row BlockNote would answer with a block placed AFTER the whole
    // table, caret and all
    const container = document.createElement('div')
    document.body.appendChild(container)
    const editor = makeEditor(selectionIn('table', 'tableRow', 'tableCell'))
    const { result } = mountPicker(container, editor)
    const input = fileInputIn(container)
    const click = vi.spyOn(input, 'click')

    // #when
    result.current.pickImageForCell()

    // #then
    expect(click).toHaveBeenCalled()
    expect(input.accept).toBe('image/*')
  })

  it('uploads the chosen file and inserts it as inline content', async () => {
    // #given
    const container = document.createElement('div')
    document.body.appendChild(container)
    const editor = makeEditor(selectionIn('table', 'tableRow', 'tableCell'))
    const { result } = mountPicker(container, editor)
    const input = fileInputIn(container)
    vi.spyOn(input, 'click').mockImplementation(() => {})

    // #when
    result.current.pickImageForCell()
    choose(input, [PNG()])

    // #then
    await waitFor(() =>
      expect(editor.insertInlineContent).toHaveBeenCalledWith([
        {
          type: 'inlineImage',
          props: { src: '../attachments/n1/shot.png', alt: 'shot.png', width: 0 }
        }
      ])
    )
  })

  it('puts the image back where the caret was when the row was chosen', async () => {
    // #given the picker is modal and asynchronous — by the time a file comes
    // back the editor has been blurred, and inserting at "wherever the selection
    // is now" is exactly the bug this row replaces
    const container = document.createElement('div')
    document.body.appendChild(container)
    const editor = makeEditor(selectionIn('table', 'tableRow', 'tableCell'))
    const { result } = mountPicker(container, editor)
    const input = fileInputIn(container)
    vi.spyOn(input, 'click').mockImplementation(() => {})

    // #when the caret moves away between the click and the file arriving
    result.current.pickImageForCell()
    ;(editor.prosemirrorView as any).state.selection.from = 31
    choose(input, [PNG()])

    // #then the position captured at click time is what is restored
    await waitFor(() =>
      expect(editor.prosemirrorView.dispatch).toHaveBeenCalledWith({ selectedPos: 7 })
    )
  })

  it('ignores a chosen file that is not an image', async () => {
    // #given
    const container = document.createElement('div')
    document.body.appendChild(container)
    const editor = makeEditor(selectionIn('table', 'tableRow', 'tableCell'))
    const { result } = mountPicker(container, editor)
    const input = fileInputIn(container)
    vi.spyOn(input, 'click').mockImplementation(() => {})

    // #when
    result.current.pickImageForCell()
    choose(input, [new File(['x'], 'a.pdf', { type: 'application/pdf' })])

    // #then
    await waitFor(() => expect(mocks.uploadAttachment).not.toHaveBeenCalled())
    expect(editor.insertInlineContent).not.toHaveBeenCalled()
  })

  it('does nothing before the editor has a view', () => {
    // #given the editor is created before its view exists, and the menu is built
    // from the same render
    const container = document.createElement('div')
    document.body.appendChild(container)
    const { result } = mount({ insertInlineContent: vi.fn() }, container)

    // #when / #then no throw reaches the menu row
    expect(() => result.current.pickImageForCell()).not.toThrow()
  })
})

describe('dropping an image onto a cell', () => {
  function dropOn(target: HTMLElement, files: File[], html = ''): DragEvent {
    const event = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent
    Object.defineProperty(event, 'dataTransfer', {
      value: { files, getData: (type: string) => (type === 'text/html' ? html : '') }
    })
    Object.defineProperty(event, 'clientX', { value: 10 })
    Object.defineProperty(event, 'clientY', { value: 20 })
    target.dispatchEvent(event)
    return event
  }

  /**
   * By tag, not by id: containers from earlier cases are still in the document,
   * and jsdom answers a scoped `#id` query from the document-wide index — so the
   * SECOND case to build a table gets back null.
   */
  function tableIn(container: HTMLElement): HTMLElement {
    container.innerHTML = '<table><tbody><tr><td>x</td></tr></tbody></table>'
    return container.querySelector('td') as HTMLElement
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

  it('takes an image dragged out of a browser, which carries HTML and no file', async () => {
    // #given a drag from a web page puts `text/html` on the transfer and no
    // file at all — the same split a copy has
    const container = document.createElement('div')
    document.body.appendChild(container)
    const cell = tableIn(container)
    const editor = makeEditor(selectionIn('table', 'tableRow', 'tableCell'))
    ;(editor.prosemirrorView as any).state.tr = { setSelection: (s: unknown) => s }
    ;(editor.prosemirrorView as any).state.doc = { resolve: () => ({}) }
    mount(editor, container)

    // #when
    const event = dropOn(cell, [], '<img src="https://cdn.example.com/chart.png" alt="chart">')

    // #then
    expect(event.defaultPrevented).toBe(true)
    await waitFor(() =>
      expect(editor.insertInlineContent).toHaveBeenCalledWith([
        {
          type: 'inlineImage',
          props: { src: 'https://cdn.example.com/chart.png', alt: 'chart', width: 0 }
        }
      ])
    )
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

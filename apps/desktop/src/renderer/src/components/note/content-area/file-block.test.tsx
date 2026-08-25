import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createFileBlock,
  createFileBlockContent,
  FILE_BLOCK_ACCEPT,
  parseFileBlockMarker,
  serializeFileBlock
} from './file-block'
import { NoteFileUrlProvider } from './note-file-url-context'

const mocks = vi.hoisted(() => ({
  syncState: {
    uploadProgress: {} as Record<string, { progress: number; status: string }>,
    downloadProgress: {} as Record<string, { progress: number; status: string }>
  },
  pdfPageCount: 2
}))

interface PdfViewport {
  width: number
  height: number
}

/** Point size of the mocked page: a portrait page twice as tall as it is wide. */
const PAGE_POINT_WIDTH = 300
const PAGE_POINT_HEIGHT = 600
/** Viewport the embed's scroller reports under jsdom, which lays nothing out. */
const SCROLL_VIEWPORT_HEIGHT = 400

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key })
}))

vi.mock('react-i18next', () => ({
  getI18n: () => ({ getFixedT: () => (key: string) => key })
}))

vi.mock('@/contexts/sync-context', () => ({
  useSync: () => ({ state: mocks.syncState }),
  useSyncOptional: () => null
}))

vi.mock('@blocknote/react', () => ({
  createReactBlockSpec: vi.fn((schema, implementation) => ({
    schema,
    meta: implementation.meta,
    render: implementation.render
  }))
}))

vi.mock('react-pdf', () => ({
  Document: ({
    children,
    file,
    onLoadSuccess,
    onLoadError
  }: {
    children: React.ReactNode
    file: string
    onLoadSuccess?: (pdf: {
      numPages: number
      getPage: (page: number) => Promise<{ getViewport: (o: { scale: number }) => PdfViewport }>
    }) => void
    onLoadError?: (error: Error) => void
  }) => (
    <div data-testid="pdf-document" data-file={file}>
      <button
        type="button"
        onClick={() =>
          onLoadSuccess?.({
            numPages: mocks.pdfPageCount,
            getPage: () =>
              Promise.resolve({
                getViewport: () => ({ width: PAGE_POINT_WIDTH, height: PAGE_POINT_HEIGHT })
              })
          })
        }
      >
        load pdf
      </button>
      <button type="button" onClick={() => onLoadError?.(new Error('broken pdf'))}>
        break pdf
      </button>
      {children}
    </div>
  ),
  Page: ({ pageNumber }: { pageNumber: number }) => <div>page {pageNumber}</div>,
  pdfjs: { GlobalWorkerOptions: {} }
}))

/** Scroll the embed to `offset` px, the way the virtualizer observes it. */
const scrollEmbedTo = (offset: number): void => {
  const scroller = screen.getByTestId('pdf-embed-scroll')
  Object.defineProperty(scroller, 'scrollTop', { value: offset, configurable: true })
  fireEvent.scroll(scroller)
}

/** Offset that puts the top of `page` at the top of the embed's viewport. */
const pageOffset = (page: number): number => {
  const total = Number.parseFloat(screen.getByTestId('pdf-embed-sizer').style.height)
  return (total / mocks.pdfPageCount) * (page - 1)
}

describe('file block helpers', () => {
  let originalOffsetHeight: PropertyDescriptor | undefined

  beforeEach(() => {
    mocks.syncState = { uploadProgress: {}, downloadProgress: {} }
    mocks.pdfPageCount = 2

    originalOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
    // @tanstack/react-virtual sizes its viewport from `offsetHeight`, which
    // jsdom always reports as 0. Give the embed's scroller a real viewport.
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get(this: HTMLElement) {
        return this.dataset.testid === 'pdf-embed-scroll' ? SCROLL_VIEWPORT_HEIGHT : 0
      }
    })
  })

  afterEach(() => {
    if (originalOffsetHeight) {
      Object.defineProperty(HTMLElement.prototype, 'offsetHeight', originalOffsetHeight)
    } else {
      delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetHeight
    }
  })

  it('serializes, parses, and creates file block content', () => {
    const props = {
      url: '/vault/manual.pdf',
      name: 'manual.pdf',
      size: 2048,
      mimeType: 'application/pdf'
    }

    const marker = serializeFileBlock(props)
    expect(parseFileBlockMarker(marker)).toEqual(props)
    expect(parseFileBlockMarker('not a marker')).toBeNull()
    expect(parseFileBlockMarker('<!-- file:{bad json} -->')).toBeNull()
    expect(createFileBlockContent(props)).toEqual({ type: 'file', props })
  })

  it('declares the vault-allowed extensions so the file picker cannot offer a rejected type', () => {
    // Mirrors ALLOWED_IMAGE_EXTENSIONS + ALLOWED_FILE_EXTENSIONS in
    // apps/desktop/src/main/vault/attachments.ts.
    expect(FILE_BLOCK_ACCEPT).toEqual([
      '.png',
      '.jpg',
      '.jpeg',
      '.gif',
      '.webp',
      '.svg',
      '.pdf',
      '.doc',
      '.docx',
      '.xls',
      '.xlsx',
      '.txt',
      '.md'
    ])
    // BlockNote's upload tab reads the accept list off the spec's meta.
    expect((createFileBlock as any).meta).toEqual({ fileBlockAccept: FILE_BLOCK_ACCEPT })
  })

  it('persists an explicit width and omits the default (byte-stable for legacy markers)', () => {
    const base = {
      url: '/vault/manual.pdf',
      name: 'manual.pdf',
      size: 2048,
      mimeType: 'application/pdf'
    }

    // Default width (0) must not appear in the marker, so existing PDF markers
    // stay byte-for-byte identical on re-save.
    expect(serializeFileBlock({ ...base, width: 0 })).toBe(`<!-- file:${JSON.stringify(base)} -->`)

    // A user-set width persists and round-trips.
    const sized = serializeFileBlock({ ...base, width: 720 })
    expect(sized).toContain('"width":720')
    expect(parseFileBlockMarker(sized)).toEqual({ ...base, width: 720 })

    // Legacy markers with no width field parse to a widthless props object.
    expect(parseFileBlockMarker(`<!-- file:${JSON.stringify(base)} -->`)).toEqual(base)

    // The default crop height (0) is dropped for byte-stability, and an
    // explicit height persists + round-trips alongside width.
    expect(serializeFileBlock({ ...base, height: 0 })).toBe(`<!-- file:${JSON.stringify(base)} -->`)
    const cropped = serializeFileBlock({ ...base, width: 720, height: 300 })
    expect(cropped).toContain('"height":300')
    expect(parseFileBlockMarker(cropped)).toEqual({ ...base, width: 720, height: 300 })

    // Alignment: default 'left' is dropped; 'center'/'right' persist + round-trip.
    expect(serializeFileBlock({ ...base, align: 'left' })).toBe(
      `<!-- file:${JSON.stringify(base)} -->`
    )
    const aligned = serializeFileBlock({ ...base, align: 'center' })
    expect(aligned).toContain('"align":"center"')
    expect(parseFileBlockMarker(aligned)).toEqual({ ...base, align: 'center' })
  })

  it('renders empty, generic, transfer, and pdf previews through the block spec', () => {
    const Render = (createFileBlock as any).render
    const contentRef = vi.fn()

    const { container, rerender } = render(
      <Render
        contentRef={contentRef}
        block={{ props: { url: '', name: '', size: 0, mimeType: '' } }}
      />
    )
    expect(
      screen.getByText('phaseF.componentsNoteContentAreaFileBlock.noFileAttached')
    ).toBeInTheDocument()

    mocks.syncState.uploadProgress = {
      '/vault/manual.pdf': { progress: 42, status: 'uploading' }
    }
    rerender(
      <Render
        contentRef={contentRef}
        block={{
          props: {
            url: '/vault/manual.pdf',
            name: 'manual.pdf',
            size: 2048,
            mimeType: 'text/plain'
          }
        }}
      />
    )
    expect(screen.getByText('manual.pdf')).toBeInTheDocument()
    expect(screen.getByText('2.0 KB')).toBeInTheDocument()
    expect(screen.getByText(/Uploading/)).toBeInTheDocument()

    rerender(
      <Render
        contentRef={contentRef}
        block={{
          props: {
            url: 'memry-file://local/Users/kaan/vault/notes/voice.wav',
            name: 'voice.wav',
            size: 4096,
            mimeType: 'audio/wav'
          }
        }}
      />
    )
    const audio = container.querySelector('audio')
    expect(audio).toHaveAttribute('src', 'memry-file://local/Users/kaan/vault/notes/voice.wav')
    expect(audio).toHaveAttribute('controls')
    expect(screen.getByText('voice.wav')).toBeInTheDocument()
    expect(screen.queryByText('4.0 KB')).not.toBeInTheDocument()
    expect(container.querySelector('.file-audio a[download]')).toBeNull()

    rerender(
      <Render
        contentRef={contentRef}
        block={{
          props: {
            url: '/vault/manual.pdf',
            name: 'manual.pdf',
            size: 2048,
            mimeType: 'application/pdf'
          }
        }}
      />
    )
    expect(screen.getAllByTestId('pdf-document').length).toBeGreaterThan(0)
    fireEvent.click(screen.getAllByText('load pdf')[0])
    // Resize handle appears once the PDF has loaded.
    const resizeHandle = screen.getByRole('slider')
    expect(resizeHandle).toHaveAttribute(
      'aria-label',
      'phaseF.componentsNoteContentAreaFileBlock.resizePdf'
    )
    expect(resizeHandle).toHaveAttribute('aria-valuenow')
    // Faint at rest, not hidden: a hover-only handle is one most readers never
    // discover, which is how the embed came to be reported as unresizable.
    expect(resizeHandle.className).not.toContain('opacity-0')
    // Alignment controls render for a loaded PDF.
    expect(
      screen.getByLabelText('phaseF.componentsNoteContentAreaFileBlock.alignCenter')
    ).toBeInTheDocument()
    fireEvent.click(screen.getAllByText('break pdf')[0])
    expect(
      screen.getByText(/phaseF.componentsNoteContentAreaFileBlock.failedToLoadPdf/)
    ).toBeInTheDocument()
    // Handle is hidden while the error state is shown.
    expect(screen.queryByRole('slider')).toBeNull()
  })

  it('commits a resized width to the block prop via the editor', () => {
    const Render = (createFileBlock as any).render
    const updateBlock = vi.fn()
    const block = {
      props: {
        url: '/vault/manual.pdf',
        name: 'manual.pdf',
        size: 2048,
        mimeType: 'application/pdf'
      }
    }

    render(<Render contentRef={vi.fn()} editor={{ updateBlock }} block={block} />)
    fireEvent.click(screen.getAllByText('load pdf')[0])

    const handle = screen.getByRole('slider')
    fireEvent.keyDown(handle, { key: 'ArrowRight' })

    expect(updateBlock).toHaveBeenCalledWith(block, {
      props: expect.objectContaining({ width: expect.any(Number) })
    })
  })

  it('scrolls continuously through a multi-page PDF and tracks the page', async () => {
    const Render = (createFileBlock as any).render

    render(
      <Render
        contentRef={vi.fn()}
        block={{
          props: {
            url: '/vault/manual.pdf',
            name: 'manual.pdf',
            size: 2048,
            mimeType: 'application/pdf'
          }
        }}
      />
    )
    fireEvent.click(screen.getAllByText('load pdf')[0])
    // The first page's aspect lands asynchronously from pdf.js.
    await screen.findByTestId('pdf-embed-sizer')

    // Both pages are in the same scroller — no button needed to reach page 2.
    expect(screen.getByText('page 1')).toBeInTheDocument()
    expect(screen.getByText('page 2')).toBeInTheDocument()
    expect(screen.getByText('1 / 2')).toBeInTheDocument()

    // The controls that used to be the only way through are gone.
    expect(screen.queryByLabelText('phaseF.componentsNoteContentAreaFileBlock.nextPage')).toBeNull()

    // Scrolling past the first page moves the indicator with the reader.
    scrollEmbedTo(pageOffset(2))
    expect(screen.getByText('2 / 2')).toBeInTheDocument()

    scrollEmbedTo(0)
    expect(screen.getByText('1 / 2')).toBeInTheDocument()
  })

  it('keeps single-page PDFs chromeless (no page controls)', () => {
    const Render = (createFileBlock as any).render
    mocks.pdfPageCount = 1

    render(
      <Render
        contentRef={vi.fn()}
        block={{
          props: {
            url: '/vault/manual.pdf',
            name: 'manual.pdf',
            size: 2048,
            mimeType: 'application/pdf'
          }
        }}
      />
    )
    fireEvent.click(screen.getAllByText('load pdf')[0])

    expect(screen.queryByText('1 / 1')).toBeNull()
    // The rest of the chrome-free embed still works.
    expect(screen.getByRole('slider')).toBeInTheDocument()
  })

  it('commits an alignment to the block prop via the editor', () => {
    const Render = (createFileBlock as any).render
    const updateBlock = vi.fn()
    const block = {
      props: {
        url: '/vault/manual.pdf',
        name: 'manual.pdf',
        size: 2048,
        mimeType: 'application/pdf'
      }
    }

    render(<Render contentRef={vi.fn()} editor={{ updateBlock }} block={block} />)
    fireEvent.click(screen.getAllByText('load pdf')[0])
    fireEvent.click(screen.getByLabelText('phaseF.componentsNoteContentAreaFileBlock.alignRight'))

    expect(updateBlock).toHaveBeenCalledWith(block, {
      props: expect.objectContaining({ align: 'right' })
    })
  })
})

describe('FileBlock url resolution', () => {
  // #1488: attachments are stored as a ref relative to the note. The `file`
  // block is a custom spec, so BlockNote's own resolveFileUrl never reaches it
  // — without this the PDF viewer fetches `../attachments/...` against the
  // renderer's base URL and shows a broken card.
  const RELATIVE = '../attachments/note1/abc123-manual.pdf'
  const ABSOLUTE = 'memry-file://local/Users/me/vault/attachments/note1/abc123-manual.pdf'

  function renderBlock(url: string, resolveFileUrl?: (url: string) => Promise<string>) {
    const Render = (createFileBlock as any).render
    const block = {
      props: { url, name: 'manual.pdf', size: 2048, mimeType: 'application/pdf' }
    }
    const ui = <Render contentRef={vi.fn()} editor={{ updateBlock: vi.fn() }} block={block} />
    const result = render(
      resolveFileUrl ? (
        <NoteFileUrlProvider resolveFileUrl={resolveFileUrl}>{ui}</NoteFileUrlProvider>
      ) : (
        ui
      )
    )
    return { ...result, block }
  }

  it('renders a note-relative ref through the resolver', async () => {
    const { block } = renderBlock(RELATIVE, async () => ABSOLUTE)

    await vi.waitFor(() =>
      expect(screen.getByTestId('pdf-document')).toHaveAttribute('data-file', ABSOLUTE)
    )
    // Render-time only: writing the resolved URL back would serialize this
    // machine's vault path into the note's markdown — the bug itself.
    expect(block.props.url).toBe(RELATIVE)
  })

  it('renders an absolute URL on the first paint, with no resolver round trip', () => {
    const resolveFileUrl = vi.fn(async () => 'never used')
    renderBlock(ABSOLUTE, resolveFileUrl)

    expect(screen.getByTestId('pdf-document')).toHaveAttribute('data-file', ABSOLUTE)
    expect(resolveFileUrl).not.toHaveBeenCalled()
  })

  it('leaves the ref alone outside a provider rather than inventing a path', () => {
    // Read-only surfaces that render a file block without the editor's resolver
    // get the stored ref verbatim — the same "leave it alone" fallback the
    // resolver itself uses, not a guess at where the vault lives.
    renderBlock(RELATIVE)

    expect(screen.getByTestId('pdf-document')).toHaveAttribute('data-file', RELATIVE)
  })
})

describe('FileBlock missing attachment card (#1713)', () => {
  // The file is gone from disk and main's self-heal found no unique match:
  // the block must say which filename it expected instead of silently failing.
  const RELATIVE = '../attachments/note1/abc123-manual.pdf'

  let savedNotesApi: unknown

  function renderWithNoteId(resolveAttachment: ReturnType<typeof vi.fn>) {
    // The global test setup owns `window.api`; overlay the notes surface.
    const api = window.api as unknown as Record<string, unknown>
    savedNotesApi = api.notes
    api.notes = { ...((api.notes as Record<string, unknown>) ?? {}), resolveAttachment }
    const Render = (createFileBlock as any).render
    const block = {
      props: { url: RELATIVE, name: 'manual.pdf', size: 2048, mimeType: 'application/pdf' }
    }
    return render(
      <NoteFileUrlProvider resolveFileUrl={async (url) => url} noteId="note1">
        <Render contentRef={vi.fn()} editor={{ updateBlock: vi.fn() }} block={block} />
      </NoteFileUrlProvider>
    )
  }

  afterEach(() => {
    ;(window.api as unknown as Record<string, unknown>).notes = savedNotesApi
  })

  it('names the expected file when the attachment is gone and unhealable', async () => {
    const resolveAttachment = vi.fn().mockResolvedValue({
      absolutePath: '/vault/attachments/note1/abc123-manual.pdf',
      storedFilename: 'abc123-manual.pdf',
      exists: false
    })
    renderWithNoteId(resolveAttachment)

    expect(await screen.findByTestId('attachment-missing-card')).toBeInTheDocument()
    expect(resolveAttachment).toHaveBeenCalledWith('note1', RELATIVE)
    // The i18n mock returns raw keys; the expected-filename line is the
    // missingExpected key rendered next to the title.
    expect(screen.getByText(/missingExpected/)).toBeInTheDocument()
    expect(screen.queryByTestId('pdf-document')).not.toBeInTheDocument()
  })

  it('renders normally when the file exists (or was healed by main)', async () => {
    const resolveAttachment = vi.fn().mockResolvedValue({
      absolutePath: '/vault/attachments/note1/abc123-manual-v2.pdf',
      storedFilename: 'abc123-manual-v2.pdf',
      exists: true
    })
    renderWithNoteId(resolveAttachment)

    expect(await screen.findByTestId('pdf-document')).toBeInTheDocument()
    expect(resolveAttachment).toHaveBeenCalled()
    expect(screen.queryByTestId('attachment-missing-card')).not.toBeInTheDocument()
  })
})

describe('FileBlock rename (#1714)', () => {
  // A plain file card rather than a PDF: the menu button is in the card itself,
  // with no react-pdf load step in the way.
  const RELATIVE = '../attachments/note1/abc123-manual.txt'
  let savedNotesApi: unknown

  afterEach(() => {
    ;(window.api as unknown as Record<string, unknown>).notes = savedNotesApi
  })

  it('records the renamed url and name on the block', async () => {
    const api = window.api as unknown as Record<string, unknown>
    savedNotesApi = api.notes
    api.notes = {
      ...((api.notes as Record<string, unknown>) ?? {}),
      resolveAttachment: vi.fn().mockResolvedValue({
        absolutePath: '/vault/attachments/note1/abc123-manual.txt',
        storedFilename: 'abc123-manual.txt',
        exists: true
      }),
      renameAttachment: vi.fn().mockResolvedValue({
        storedFilename: 'abc123-invoice.txt',
        url: '../attachments/note1/abc123-invoice.txt',
        name: 'invoice.txt'
      })
    }

    const updateBlock = vi.fn()
    const block = {
      props: { url: RELATIVE, name: 'manual.txt', size: 2048, mimeType: 'text/plain' }
    }
    const Render = (createFileBlock as any).render
    render(
      <NoteFileUrlProvider resolveFileUrl={async (url) => url} noteId="note1">
        <Render contentRef={vi.fn()} editor={{ updateBlock }} block={block} />
      </NoteFileUrlProvider>
    )

    const user = userEvent.setup()
    const menuButtons = await screen.findAllByTestId('attachment-menu-button')
    await user.click(menuButtons[0])
    await user.click(
      await screen.findByRole('menuitem', { name: 'editor.attachmentRename.menuItem' })
    )
    await user.click(screen.getByRole('button', { name: 'editor.attachmentRename.confirm' }))

    // Main renamed the file already; the block recording it is what carries the
    // rename into the note — and from there to the other devices.
    await waitFor(() => {
      expect(updateBlock).toHaveBeenCalledWith(block, {
        props: expect.objectContaining({
          url: '../attachments/note1/abc123-invoice.txt',
          name: 'invoice.txt'
        })
      })
    })
  })
})

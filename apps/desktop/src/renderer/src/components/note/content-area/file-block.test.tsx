import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createFileBlock,
  createFileBlockContent,
  parseFileBlockMarker,
  serializeFileBlock
} from './file-block'

const mocks = vi.hoisted(() => ({
  syncState: {
    uploadProgress: {} as Record<string, { progress: number; status: string }>,
    downloadProgress: {} as Record<string, { progress: number; status: string }>
  },
  pdfPageCount: 2
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key })
}))

vi.mock('react-i18next', () => ({
  getI18n: () => ({ getFixedT: () => (key: string) => key })
}))

vi.mock('@/contexts/sync-context', () => ({
  useSync: () => ({ state: mocks.syncState })
}))

vi.mock('@blocknote/react', () => ({
  createReactBlockSpec: vi.fn((schema, implementation) => ({
    schema,
    render: implementation.render
  }))
}))

vi.mock('react-pdf', () => ({
  Document: ({
    children,
    onLoadSuccess,
    onLoadError
  }: {
    children: React.ReactNode
    onLoadSuccess?: (payload: { numPages: number }) => void
    onLoadError?: (error: Error) => void
  }) => (
    <div data-testid="pdf-document">
      <button type="button" onClick={() => onLoadSuccess?.({ numPages: mocks.pdfPageCount })}>
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

describe('file block helpers', () => {
  beforeEach(() => {
    mocks.syncState = { uploadProgress: {}, downloadProgress: {} }
    mocks.pdfPageCount = 2
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

  it('pages through a multi-page PDF from the hover controls', () => {
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

    const prev = screen.getByLabelText('phaseF.componentsNoteContentAreaFileBlock.previousPage')
    const next = screen.getByLabelText('phaseF.componentsNoteContentAreaFileBlock.nextPage')

    // Opens on page 1; there is no page before it.
    expect(screen.getByText('page 1')).toBeInTheDocument()
    expect(screen.getByText('1 / 2')).toBeInTheDocument()
    expect(prev).toBeDisabled()
    expect(next).toBeEnabled()

    fireEvent.click(next)
    expect(screen.getByText('page 2')).toBeInTheDocument()
    expect(screen.getByText('2 / 2')).toBeInTheDocument()
    expect(next).toBeDisabled()

    fireEvent.click(prev)
    expect(screen.getByText('page 1')).toBeInTheDocument()
    expect(prev).toBeDisabled()
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

    expect(screen.queryByLabelText('phaseF.componentsNoteContentAreaFileBlock.nextPage')).toBeNull()
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

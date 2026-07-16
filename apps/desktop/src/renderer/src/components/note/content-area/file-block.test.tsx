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
  }
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
      <button type="button" onClick={() => onLoadSuccess?.({ numPages: 2 })}>
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
    expect(screen.getByText('(2 pages)')).toBeInTheDocument()
    // Resize handle appears once the PDF has loaded.
    const resizeHandle = screen.getByRole('slider')
    expect(resizeHandle).toHaveAttribute(
      'aria-label',
      'phaseF.componentsNoteContentAreaFileBlock.resizePdf'
    )
    expect(resizeHandle).toHaveAttribute('aria-valuenow')
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
})

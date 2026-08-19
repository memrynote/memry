/**
 * Regression tests for the PDF viewer's document/thumbnail memory footprint.
 *
 * Covers two defects reported in issue #1018:
 *  1. the viewer mounted one `<Document>` per surface, so a single file was
 *     loaded twice into two independent pdf.js document proxies;
 *  2. the thumbnail rail mounted one `<Page>` canvas per page with no
 *     windowing, so a long PDF allocated hundreds of canvases on open.
 *
 * The `react-pdf` mock mirrors the real teardown contract: `Document` creates
 * one loading task per mount and destroys it in its effect cleanup (see
 * `react-pdf/dist/Document.js` -> `loadDocument`), and `Page` holds a canvas
 * for as long as it stays mounted.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PdfViewer } from './pdf-viewer'

const NUM_PAGES = 400
const RAIL_VIEWPORT_HEIGHT = 600
/** Width of the pane the page renders into, minus its `p-4` gutter. */
const PAGE_VIEW_WIDTH = 1224
const PAGE_VIEW_PADDING = 32
/** US Letter portrait at scale 1, in PDF points. */
const LETTER_WIDTH = 612
const LETTER_HEIGHT = 792

const pdfMocks = vi.hoisted(() => ({
  loadedDocuments: [] as { file: string; destroyed: boolean }[],
  liveCanvases: new Set<{ page: number; kind: 'main' | 'thumbnail' }>(),
  pageWidth: 612,
  pageHeight: 792
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key })
}))

vi.mock('react-i18next', () => ({
  getI18n: () => ({ getFixedT: () => (key: string) => key })
}))

vi.mock('react-pdf', async () => {
  const { useEffect, useState } = await import('react')

  return {
    pdfjs: { GlobalWorkerOptions: {} },
    Document: ({
      file,
      children,
      className,
      loading,
      onLoadSuccess
    }: {
      file: string
      children?: React.ReactNode
      className?: string
      loading?: React.ReactNode
      onLoadSuccess?: (result: {
        numPages: number
        getPage: (page: number) => Promise<{
          getViewport: (params: { scale: number }) => { width: number; height: number }
        }>
      }) => void
    }) => {
      const [ready, setReady] = useState(false)

      useEffect(() => {
        const proxy = { file, destroyed: false }
        pdfMocks.loadedDocuments.push(proxy)
        setReady(true)
        onLoadSuccess?.({
          numPages: NUM_PAGES,
          getPage: () =>
            Promise.resolve({
              getViewport: ({ scale }: { scale: number }) => ({
                width: pdfMocks.pageWidth * scale,
                height: pdfMocks.pageHeight * scale
              })
            })
        })
        return () => {
          proxy.destroyed = true
        }
      }, [file, onLoadSuccess])

      return (
        <div data-testid="pdf-document" data-file={file} className={className}>
          {ready ? children : loading}
        </div>
      )
    },
    Page: ({
      pageNumber,
      width,
      scale
    }: {
      pageNumber: number
      width?: number
      scale?: number
    }) => {
      useEffect(() => {
        const canvas = {
          page: pageNumber,
          kind: (width ? 'thumbnail' : 'main') as 'main' | 'thumbnail'
        }
        pdfMocks.liveCanvases.add(canvas)
        return () => {
          pdfMocks.liveCanvases.delete(canvas)
        }
      }, [pageNumber, width])

      return (
        <div
          data-testid={width ? 'pdf-thumbnail-canvas' : 'pdf-main-canvas'}
          data-page={pageNumber}
          data-scale={scale}
        >
          page {pageNumber}
        </div>
      )
    }
  }
})

const renderedPages = (): number[] =>
  screen
    .queryAllByTestId('pdf-thumbnail')
    .map((node) => Number(node.getAttribute('data-page')))
    .sort((a, b) => a - b)

const thumbnailFor = (page: number): HTMLElement => {
  const match = screen
    .queryAllByTestId('pdf-thumbnail')
    .find((node) => node.getAttribute('data-page') === String(page))
  if (!match) throw new Error(`thumbnail for page ${page} is not rendered`)
  return match
}

const scrollRailTo = (offset: number): void => {
  const rail = screen.getByTestId('pdf-thumbnail-rail')
  Object.defineProperty(rail, 'scrollTop', { value: offset, configurable: true })
  fireEvent.scroll(rail)
}

/** Row pitch the rail lays out with, derived from the sizer it renders. */
const rowHeight = (): number =>
  Number.parseFloat(screen.getByTestId('pdf-thumbnail-sizer').style.height) / NUM_PAGES

/** What the viewer should settle on for a page that is `across` points wide. */
const fitScaleFor = (across: number): number => (PAGE_VIEW_WIDTH - PAGE_VIEW_PADDING) / across

const mainCanvasScale = (): number =>
  Number(screen.getByTestId('pdf-main-canvas').getAttribute('data-scale'))

describe('PdfViewer document loading and thumbnail windowing', () => {
  let scrollToSpy: ReturnType<typeof vi.fn>
  let originalScrollTo: unknown
  let originalOffsetHeight: PropertyDescriptor | undefined
  let originalClientWidth: PropertyDescriptor | undefined

  beforeEach(() => {
    pdfMocks.loadedDocuments.length = 0
    pdfMocks.liveCanvases.clear()
    pdfMocks.pageWidth = LETTER_WIDTH
    pdfMocks.pageHeight = LETTER_HEIGHT

    originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
    // jsdom lays nothing out, so the pane the page fits into has no width.
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get(this: HTMLElement) {
        return this.dataset.testid === 'pdf-page-view' ? PAGE_VIEW_WIDTH : 0
      }
    })

    originalOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
    // @tanstack/react-virtual sizes its viewport from `offsetHeight`, which
    // jsdom always reports as 0. Give the rail a real viewport.
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get(this: HTMLElement) {
        return this.dataset.testid === 'pdf-thumbnail-rail' ? RAIL_VIEWPORT_HEIGHT : 0
      }
    })

    scrollToSpy = vi.fn()
    originalScrollTo = (Element.prototype as unknown as { scrollTo?: unknown }).scrollTo
    ;(Element.prototype as unknown as { scrollTo?: unknown }).scrollTo = scrollToSpy
  })

  afterEach(() => {
    if (originalOffsetHeight) {
      Object.defineProperty(HTMLElement.prototype, 'offsetHeight', originalOffsetHeight)
    } else {
      delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetHeight
    }
    if (originalClientWidth) {
      Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth)
    } else {
      delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth
    }
    ;(Element.prototype as unknown as { scrollTo?: unknown }).scrollTo = originalScrollTo
  })

  it('loads the file into a single pdf.js document for both surfaces', async () => {
    render(<PdfViewer src="memry-file://spec.pdf" />)

    await screen.findAllByTestId('pdf-thumbnail-canvas')
    expect(screen.getAllByTestId('pdf-document')).toHaveLength(1)
    expect(pdfMocks.loadedDocuments).toHaveLength(1)
    expect(pdfMocks.loadedDocuments[0]?.file).toBe('memry-file://spec.pdf')
  })

  it('windows the thumbnail rail instead of mounting one canvas per page', async () => {
    render(<PdfViewer src="memry-file://spec.pdf" />)

    const canvases = await screen.findAllByTestId('pdf-thumbnail-canvas')
    expect(screen.getByText('1 / 400')).toBeInTheDocument()
    expect(canvases.length).toBeGreaterThan(0)
    expect(canvases.length).toBeLessThan(20)
    expect([...pdfMocks.liveCanvases].filter((c) => c.kind === 'thumbnail')).toHaveLength(
      canvases.length
    )

    const pages = renderedPages()
    expect(pages).toHaveLength(canvases.length)
    expect(pages[0]).toBe(1)
  })

  it('renders the thumbnails for the scrolled region and navigates deep into the document', async () => {
    const user = userEvent.setup()
    render(<PdfViewer src="memry-file://spec.pdf" />)

    await screen.findByTestId('pdf-thumbnail-rail')
    scrollRailTo(rowHeight() * 299)

    const pages = renderedPages()
    expect(pages.length).toBeLessThan(20)
    expect(pages).toContain(300)
    expect(pages).not.toContain(1)

    await user.click(thumbnailFor(300))

    expect(screen.getByText('300 / 400')).toBeInTheDocument()
    expect(screen.getByTestId('pdf-main-canvas')).toHaveAttribute('data-page', '300')
    expect(thumbnailFor(300)).toHaveAttribute('aria-current', 'page')
  })

  it('pulls the active thumbnail back into view when the page changes from the toolbar', async () => {
    const user = userEvent.setup()
    render(<PdfViewer src="memry-file://spec.pdf" />)

    await screen.findByTestId('pdf-thumbnail-rail')
    const pitch = rowHeight()
    scrollRailTo(pitch * 350)
    expect(renderedPages()).not.toContain(2)

    scrollToSpy.mockClear()
    await user.click(screen.getByTitle('phaseF.componentsViewersPdfViewer.nextPage'))
    expect(screen.getByText('2 / 400')).toBeInTheDocument()

    expect(scrollToSpy).toHaveBeenCalled()
    const requestedTop = Number(scrollToSpy.mock.calls.at(-1)?.[0]?.top)
    expect(requestedTop).toBeLessThanOrEqual(pitch * 2)

    // Applying the rail scroll the viewer asked for brings page 2 back.
    scrollRailTo(requestedTop)
    expect(renderedPages()).toContain(2)
  })

  it('opens fitted to the pane instead of at a fixed 100%', async () => {
    render(<PdfViewer src="memry-file://spec.pdf" />)

    await screen.findByTestId('pdf-main-canvas')
    await waitFor(() => expect(mainCanvasScale()).toBeCloseTo(fitScaleFor(LETTER_WIDTH), 3))
    expect(mainCanvasScale()).toBeGreaterThan(1)
  })

  it('fits a landscape page across its own width, not a Letter assumption', async () => {
    pdfMocks.pageWidth = LETTER_HEIGHT
    pdfMocks.pageHeight = LETTER_WIDTH
    render(<PdfViewer src="memry-file://spec.pdf" />)

    await screen.findByTestId('pdf-main-canvas')
    await waitFor(() => expect(mainCanvasScale()).toBeCloseTo(fitScaleFor(LETTER_HEIGHT), 3))
  })

  it('stops auto-fitting once the user has chosen a zoom', async () => {
    const user = userEvent.setup()
    render(<PdfViewer src="memry-file://spec.pdf" />)

    await screen.findByTestId('pdf-main-canvas')
    await waitFor(() => expect(mainCanvasScale()).toBeCloseTo(fitScaleFor(LETTER_WIDTH), 3))

    await user.click(screen.getByTitle('phaseF.componentsViewersPdfViewer.zoomOut'))
    const chosen = mainCanvasScale()
    expect(chosen).toBeCloseTo(fitScaleFor(LETTER_WIDTH) - 0.25, 3)

    // Rotating re-derives the fit; the zoom the user picked must survive it.
    await user.click(screen.getByTitle('phaseF.componentsViewersPdfViewer.rotate'))
    await waitFor(() => expect(mainCanvasScale()).toBeCloseTo(chosen, 3))
  })

  it('refits on demand after a manual zoom', async () => {
    const user = userEvent.setup()
    render(<PdfViewer src="memry-file://spec.pdf" />)

    await screen.findByTestId('pdf-main-canvas')
    await user.click(screen.getByTitle('phaseF.componentsViewersPdfViewer.zoomIn'))
    expect(mainCanvasScale()).not.toBeCloseTo(fitScaleFor(LETTER_WIDTH), 3)

    await user.click(screen.getByTitle('phaseF.componentsViewersPdfViewer.fitToWidth'))
    expect(mainCanvasScale()).toBeCloseTo(fitScaleFor(LETTER_WIDTH), 3)
  })

  it('releases the document proxy and every page canvas on unmount', async () => {
    const { unmount } = render(<PdfViewer src="memry-file://spec.pdf" />)

    await screen.findAllByTestId('pdf-thumbnail-canvas')
    expect(pdfMocks.loadedDocuments).toHaveLength(1)
    expect(pdfMocks.liveCanvases.size).toBeGreaterThan(0)

    unmount()

    expect(pdfMocks.loadedDocuments.every((doc) => doc.destroyed)).toBe(true)
    expect(pdfMocks.liveCanvases.size).toBe(0)
  })
})

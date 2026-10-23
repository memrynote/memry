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
/** Height of the pane, for the fit-to-height case. */
const PAGE_VIEW_HEIGHT = 900
/** Gutter the viewer puts between the halves of a spread. */
const SPREAD_GAP = 16
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
  Number(screen.getAllByTestId('pdf-main-canvas')[0]?.getAttribute('data-scale'))

const pageField = (): HTMLInputElement => screen.getByTestId('pdf-page-input') as HTMLInputElement

/** The pages the main pane is actually showing, in order. */
const mainPages = (): number[] =>
  screen.queryAllByTestId('pdf-main-canvas').map((node) => Number(node.getAttribute('data-page')))

/** Open the toolbar's view menu and pick one of its radio options. */
const chooseViewOption = async (
  user: ReturnType<typeof userEvent.setup>,
  option: string
): Promise<void> => {
  await user.click(screen.getByTitle('phaseF.componentsViewersPdfViewer.viewOptions'))
  await user.click(await screen.findByText(`phaseF.componentsViewersPdfViewer.${option}`))
}

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
    expect(pageField()).toHaveValue('1')
    expect(screen.getByText('/ 400')).toBeInTheDocument()
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

    expect(pageField()).toHaveValue('300')
    expect(screen.getAllByTestId('pdf-main-canvas')[0]).toHaveAttribute('data-page', '300')
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
    expect(pageField()).toHaveValue('2')

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

    await chooseViewOption(user, 'fitToWidth')
    await waitFor(() => expect(mainCanvasScale()).toBeCloseTo(fitScaleFor(LETTER_WIDTH), 3))
  })

  it('jumps to a page typed into the readout, and reverts one out of range', async () => {
    const user = userEvent.setup()
    render(<PdfViewer src="memry-file://spec.pdf" />)

    await screen.findByTestId('pdf-main-canvas')

    await user.clear(pageField())
    await user.type(pageField(), '317{Enter}')
    expect(pageField()).toHaveValue('317')
    expect(mainPages()).toEqual([317])

    // Out of range is a typo, not a request for the last page: the field goes
    // back to where the reader actually is.
    await user.clear(pageField())
    await user.type(pageField(), '9999{Enter}')
    expect(pageField()).toHaveValue('317')
    expect(mainPages()).toEqual([317])
  })

  it('shows two pages per spread and steps through them two at a time', async () => {
    const user = userEvent.setup()
    render(<PdfViewer src="memry-file://spec.pdf" />)

    await screen.findByTestId('pdf-main-canvas')
    await chooseViewOption(user, 'twoPageOdd')

    await waitFor(() => expect(mainPages()).toEqual([1, 2]))
    await user.click(screen.getByTitle('phaseF.componentsViewersPdfViewer.nextPage'))
    expect(mainPages()).toEqual([3, 4])
    expect(pageField()).toHaveValue('3')

    // A page landed on mid-spread snaps to the spread that holds it, so the
    // odd/even parity cannot drift and show a page twice.
    await user.clear(pageField())
    await user.type(pageField(), '52{Enter}')
    expect(mainPages()).toEqual([51, 52])
  })

  it('leaves page 1 alone in an even-start spread', async () => {
    const user = userEvent.setup()
    render(<PdfViewer src="memry-file://spec.pdf" />)

    await screen.findByTestId('pdf-main-canvas')
    await chooseViewOption(user, 'twoPageEven')

    await waitFor(() => expect(mainPages()).toEqual([1]))
    await user.click(screen.getByTitle('phaseF.componentsViewersPdfViewer.nextPage'))
    expect(mainPages()).toEqual([2, 3])
  })

  it('halves the fit when a spread has to share the pane', async () => {
    const user = userEvent.setup()
    render(<PdfViewer src="memry-file://spec.pdf" />)

    await screen.findByTestId('pdf-main-canvas')
    await waitFor(() => expect(mainCanvasScale()).toBeCloseTo(fitScaleFor(LETTER_WIDTH), 3))

    await chooseViewOption(user, 'twoPageOdd')

    const available = PAGE_VIEW_WIDTH - PAGE_VIEW_PADDING - SPREAD_GAP
    await waitFor(() => expect(mainCanvasScale()).toBeCloseTo(available / (LETTER_WIDTH * 2), 3))
  })

  it('fits down the pane height when asked to', async () => {
    const user = userEvent.setup()
    const originalClientHeight = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'clientHeight'
    )
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get(this: HTMLElement) {
        return this.dataset.testid === 'pdf-page-view' ? PAGE_VIEW_HEIGHT : 0
      }
    })

    try {
      render(<PdfViewer src="memry-file://spec.pdf" />)
      await screen.findByTestId('pdf-main-canvas')

      await chooseViewOption(user, 'fitToHeight')

      await waitFor(() =>
        expect(mainCanvasScale()).toBeCloseTo(
          (PAGE_VIEW_HEIGHT - PAGE_VIEW_PADDING) / LETTER_HEIGHT,
          3
        )
      )
    } finally {
      if (originalClientHeight) {
        Object.defineProperty(HTMLElement.prototype, 'clientHeight', originalClientHeight)
      } else {
        delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientHeight
      }
    }
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

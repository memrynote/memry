/**
 * PDF reading for the main process: page count, a page's text layer, and a
 * page rendered to PNG. Runs in a WebContentsView that is never shown, because
 * rendering needs a canvas and Node has none. Main calls the functions on
 * `window.memryPdfHost` with executeJavaScript (src/main/file-text/pdf-host.ts).
 */
import { getDocument, GlobalWorkerOptions, PDFDataRangeTransport } from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

GlobalWorkerOptions.workerSrc = pdfjsWorker

const RANGE_CHUNK_BYTES = 1 << 20
/** Rendering past 300 DPI makes bigger PNGs without clearer text. */
const MAX_SCALE = 300 / 72

/**
 * Reads the file in byte ranges through memry-file://, so a scan of several
 * hundred megabytes is never held in memory whole. A range that cannot be read
 * fails the whole document, so the caller gets an error instead of a wait.
 */
class MemryFileRangeTransport extends PDFDataRangeTransport {
  onFailure: () => void = () => {}

  constructor(
    private readonly url: string,
    length: number
  ) {
    super(length, null)
  }

  override requestDataRange(begin: number, end: number): void {
    void fetch(this.url, { headers: { Range: `bytes=${begin}-${end - 1}` } })
      .then(async (response) => {
        if (!response.ok) throw new Error(`memry-file answered ${response.status}`)
        this.onDataRange(begin, new Uint8Array(await response.arrayBuffer()))
      })
      .catch(() => this.onFailure())
  }
}

const documents = new Map<string, PDFDocumentProxy>()

function documentFor(id: string): PDFDocumentProxy {
  const pdf = documents.get(id)
  if (!pdf) throw new Error(`PDF ${id} is not open`)
  return pdf
}

async function open(id: string, url: string, length: number): Promise<number> {
  const range = new MemryFileRangeTransport(url, length)
  const task = getDocument({
    range,
    rangeChunkSize: RANGE_CHUNK_BYTES,
    disableAutoFetch: true,
    isEvalSupported: false
  })
  range.onFailure = () => void task.destroy()
  const pdf = await task.promise
  documents.set(id, pdf)
  return pdf.numPages
}

async function pageText(id: string, pageNumber: number): Promise<string> {
  const page = await documentFor(id).getPage(pageNumber)
  try {
    const content = await page.getTextContent()
    return content.items
      .map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : '') : ''))
      .join('')
  } finally {
    page.cleanup()
  }
}

async function renderPage(
  id: string,
  pageNumber: number,
  maxEdge: number
): Promise<{ png: Uint8Array; width: number; height: number }> {
  const page = await documentFor(id).getPage(pageNumber)
  const canvas = document.createElement('canvas')
  try {
    const natural = page.getViewport({ scale: 1 })
    const scale = Math.min(MAX_SCALE, maxEdge / Math.max(natural.width, natural.height))
    const viewport = page.getViewport({ scale })
    canvas.width = Math.ceil(viewport.width)
    canvas.height = Math.ceil(viewport.height)
    // 'print': the display intent paces itself on requestAnimationFrame, and a
    // view that is never shown never gets a frame.
    await page.render({ canvas, viewport, intent: 'print' }).promise
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
    if (!blob) throw new Error(`Page ${pageNumber} could not be encoded`)
    return {
      png: new Uint8Array(await blob.arrayBuffer()),
      width: canvas.width,
      height: canvas.height
    }
  } finally {
    canvas.width = 0
    canvas.height = 0
    page.cleanup()
  }
}

async function close(id: string): Promise<void> {
  const pdf = documents.get(id)
  documents.delete(id)
  await pdf?.destroy()
}

const host = { open, pageText, renderPage, close }

declare global {
  interface Window {
    memryPdfHost: typeof host
  }
}

window.memryPdfHost = host

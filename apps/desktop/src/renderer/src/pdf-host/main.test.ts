import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

/** A two-page Letter document, enough for the host's own logic. */
const pdfjs = vi.hoisted(() => {
  const state = {
    renders: [] as Array<{ intent?: string; width: number; height: number }>,
    destroyedDocuments: 0,
    destroyedTasks: 0,
    transport: null as null | {
      requestDataRange(begin: number, end: number): void
    },
    chunks: [] as Array<{ begin: number; bytes: number }>
  }

  class PDFDataRangeTransport {
    constructor(
      readonly length: number,
      readonly initialData: Uint8Array | null
    ) {}
    onDataRange(begin: number, chunk: Uint8Array): void {
      state.chunks.push({ begin, bytes: chunk.length })
    }
  }

  const page = {
    getTextContent: async () => ({
      items: [
        { str: 'Heron', hasEOL: false },
        { str: ' count', hasEOL: true },
        { type: 'beginMarkedContent' },
        { str: 'at dawn', hasEOL: false }
      ]
    }),
    getViewport: ({ scale }: { scale: number }) => ({ width: 612 * scale, height: 792 * scale }),
    render: ({ canvas, intent }: { canvas: HTMLCanvasElement; intent?: string }) => {
      state.renders.push({ intent, width: canvas.width, height: canvas.height })
      return { promise: Promise.resolve() }
    },
    cleanup: () => {}
  }

  const document = {
    numPages: 2,
    getPage: async () => page,
    destroy: async () => {
      state.destroyedDocuments++
    }
  }

  return {
    state,
    module: {
      GlobalWorkerOptions: { workerSrc: '' },
      PDFDataRangeTransport,
      getDocument: (params: { range: typeof state.transport }) => {
        state.transport = params.range
        return {
          promise: Promise.resolve(document),
          destroy: async () => {
            state.destroyedTasks++
          }
        }
      }
    }
  }
})

vi.mock('pdfjs-dist', () => pdfjs.module)

import './main'

describe('PDF host page', () => {
  beforeAll(() => {
    // jsdom has no canvas encoder, and its Blob has no arrayBuffer().
    HTMLCanvasElement.prototype.toBlob = function (callback: BlobCallback) {
      callback({ arrayBuffer: async () => Uint8Array.of(137, 80, 78, 71).buffer } as Blob)
    }
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    pdfjs.state.renders.length = 0
    pdfjs.state.chunks.length = 0
  })

  it('opens a document and reads a page text layer line by line', async () => {
    await expect(window.memryPdfHost.open('doc-1', 'memry-file://local/a.pdf', 10)).resolves.toBe(2)

    await expect(window.memryPdfHost.pageText('doc-1', 1)).resolves.toBe('Heron count\nat dawn')
  })

  it('renders a page with the print intent, within the long edge asked for and 300 DPI', async () => {
    await window.memryPdfHost.open('doc-2', 'memry-file://local/a.pdf', 10)

    const vision = await window.memryPdfHost.renderPage('doc-2', 1, 1568)
    const ocr = await window.memryPdfHost.renderPage('doc-2', 1, 10_000)

    expect([vision.width, vision.height]).toEqual([1212, 1568])
    expect([ocr.width, ocr.height]).toEqual([2550, 3300])
    expect(pdfjs.state.renders.map((render) => render.intent)).toEqual(['print', 'print'])
    expect(Array.from(vision.png)).toEqual([137, 80, 78, 71])
  })

  it('reads byte ranges over memry-file and gives up on the document when one fails', async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) =>
      (init.headers as Record<string, string>).Range === 'bytes=0-1023'
        ? new Response(new Uint8Array(1024), { status: 206 })
        : new Response(null, { status: 404 })
    )
    vi.stubGlobal('fetch', fetch)
    await window.memryPdfHost.open('doc-3', 'memry-file://local/a.pdf', 4096)

    pdfjs.state.transport?.requestDataRange(0, 1024)
    await vi.waitFor(() => expect(pdfjs.state.chunks).toEqual([{ begin: 0, bytes: 1024 }]))
    const destroyedBefore = pdfjs.state.destroyedTasks
    pdfjs.state.transport?.requestDataRange(1024, 2048)

    await vi.waitFor(() => expect(pdfjs.state.destroyedTasks).toBe(destroyedBefore + 1))
    expect(fetch).toHaveBeenCalledWith('memry-file://local/a.pdf', {
      headers: { Range: 'bytes=1024-2047' }
    })
  })

  it('forgets a closed document', async () => {
    await window.memryPdfHost.open('doc-4', 'memry-file://local/a.pdf', 10)
    const destroyedBefore = pdfjs.state.destroyedDocuments

    await window.memryPdfHost.close('doc-4')

    expect(pdfjs.state.destroyedDocuments).toBe(destroyedBefore + 1)
    await expect(window.memryPdfHost.pageText('doc-4', 1)).rejects.toThrow('PDF doc-4 is not open')
  })
})

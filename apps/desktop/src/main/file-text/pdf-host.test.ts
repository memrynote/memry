import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * Stands in for the hidden view. `executeJavaScript` runs the script main
 * builds against `host`, the fake of the page's `window.memryPdfHost`.
 */
class FakeContents {
  closed = false
  loaded: string[] = []
  handlers = new Map<string, (...args: unknown[]) => void>()
  host = {
    opened: [] as Array<{ id: string; url: string; length: number }>,
    open: async (id: string, url: string, length: number): Promise<number> => {
      this.host.opened.push({ id, url, length })
      return 3
    },
    pageText: async (_id: string, page: number): Promise<string> => `text of page ${page}`,
    renderPage: async (_id: string, page: number, maxEdge: number) => ({
      png: Uint8Array.of(page),
      width: maxEdge,
      height: maxEdge
    }),
    close: async (): Promise<void> => {}
  }

  setWindowOpenHandler(): void {}
  once(event: string, handler: (...args: unknown[]) => void): void {
    this.handlers.set(event, handler)
  }
  async loadFile(file: string): Promise<void> {
    this.loaded.push(file)
  }
  async loadURL(url: string): Promise<void> {
    this.loaded.push(url)
  }
  getOSProcessId(): number {
    return 0
  }
  isDestroyed(): boolean {
    return this.closed
  }
  close(): void {
    this.closed = true
  }
  executeJavaScript(script: string): Promise<unknown> {
    if (this.closed) throw new Error('Object has been destroyed')
    return new Function('window', `return ${script}`)({ memryPdfHost: this.host })
  }
}

const views = vi.hoisted(() => [] as Array<{ webContents: FakeContents }>)

vi.mock('electron', () => ({
  app: { isPackaged: true },
  WebContentsView: class {
    webContents = new FakeContents()
    constructor() {
      views.push(this)
    }
  }
}))

import { closePdfHost, openPdfDocument } from './pdf-host'

describe('PDF host', () => {
  afterEach(() => {
    closePdfHost()
    views.length = 0
    vi.useRealTimers()
  })

  it('reads page text and renders pages from one hidden view', async () => {
    const first = await openPdfDocument('/vault/Scans/Survey #2 (50%)?.pdf', 4096)
    const second = await openPdfDocument('/vault/other.pdf', 10)

    expect(first.pageCount).toBe(3)
    await expect(first.pageText(2)).resolves.toBe('text of page 2')
    await expect(second.renderPage(1, 1568)).resolves.toEqual({
      png: Uint8Array.of(1),
      width: 1568,
      height: 1568
    })
    expect(views).toHaveLength(1)
    expect(views[0].webContents.loaded[0]).toMatch(/renderer[\\/]pdf-host\.html$/)
    expect(views[0].webContents.host.opened[0]).toMatchObject({
      url: 'memry-file://local/vault/Scans/Survey %232 (50%25)%3F.pdf',
      length: 4096
    })
  })

  it('fails with the message the page threw when it throws a plain object', async () => {
    const opening = openPdfDocument('/vault/broken.pdf', 10)
    await vi.waitFor(() => expect(views).toHaveLength(1))
    // pdfjs exceptions are not real Errors, so they cross the bridge as plain objects.
    views[0].webContents.host.open = () =>
      Promise.reject({ name: 'InvalidPDFException', message: 'Invalid PDF structure.' })

    await expect(opening).rejects.toThrow('Invalid PDF structure.')
  })

  it('closes the view a minute after the last document closes', async () => {
    vi.useFakeTimers()
    const first = await openPdfDocument('/vault/a.pdf', 1)
    const second = await openPdfDocument('/vault/b.pdf', 1)

    await first.close()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(views[0].webContents.closed).toBe(false)

    await second.close()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(views[0].webContents.closed).toBe(true)

    await openPdfDocument('/vault/c.pdf', 1)
    expect(views).toHaveLength(2)
  })

  it('fails the calls in flight when the view crashes, and loads a new view next time', async () => {
    const pdf = await openPdfDocument('/vault/a.pdf', 1)
    const contents = views[0].webContents
    contents.host.pageText = () => new Promise<string>(() => {})

    const pending = pdf.pageText(1)
    await vi.waitFor(() => expect(contents.handlers.has('render-process-gone')).toBe(true))
    contents.handlers.get('render-process-gone')?.({}, { reason: 'crashed' })

    await expect(pending).rejects.toThrow('PDF host closed')
    expect(contents.closed).toBe(true)
    await openPdfDocument('/vault/a.pdf', 1)
    expect(views).toHaveLength(2)
  })

  it('closes a view that does not answer within two minutes', async () => {
    vi.useFakeTimers()
    const pdf = await openPdfDocument('/vault/a.pdf', 1)
    const contents = views[0].webContents
    contents.host.renderPage = () => new Promise(() => {})

    const outcome = expect(pdf.renderPage(1, 3300)).rejects.toThrow(
      'PDF host did not answer in time'
    )
    await vi.advanceTimersByTimeAsync(120_000)

    await outcome
    expect(contents.closed).toBe(true)
  })
})

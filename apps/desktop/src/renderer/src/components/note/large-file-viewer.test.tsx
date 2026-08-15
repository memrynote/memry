import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  LargeFileIndexEvent,
  LargeFileLinesResult,
  LargeFileOpenResult,
  LargeFileSearchProgressEvent,
  LargeFileSearchResult
} from '@memry/contracts/notes-api'

const mocks = vi.hoisted(() => ({
  /** How many rows the virtualizer is pretending fit on screen. */
  visibleRows: 40,
  /** Index of the first row on screen — the test's scroll position. */
  firstRow: 0,
  open: vi.fn(),
  readLines: vi.fn(),
  search: vi.fn(),
  close: vi.fn(),
  openExternal: vi.fn(),
  revealInFinder: vi.fn(),
  indexListeners: [] as Array<(event: LargeFileIndexEvent) => void>,
  searchListeners: [] as Array<(event: LargeFileSearchProgressEvent) => void>,
  scrollToIndex: vi.fn(),
  measureElement: vi.fn(),
  measure: vi.fn(),
  resizeObservers: [] as Array<{ emit: (width: number) => void }>
}))

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => {
    const first = Math.min(mocks.firstRow, Math.max(0, count - 1))
    const shown = Math.min(count - first, mocks.visibleRows)
    return {
      getVirtualItems: () =>
        Array.from({ length: Math.max(0, shown) }, (_, offset) => ({
          index: first + offset,
          key: first + offset,
          start: (first + offset) * 22,
          size: 22
        })),
      getTotalSize: () => count * 22,
      measureElement: mocks.measureElement,
      measure: mocks.measure,
      scrollToIndex: mocks.scrollToIndex
    }
  }
}))

import { LargeFileViewer } from './large-file-viewer'

/**
 * A ResizeObserver the test drives.
 *
 * jsdom never resizes anything, and the global stub in `setup-dom.ts` never
 * calls its callback, so a resize has to be delivered by hand.
 */
class TestResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {
    mocks.resizeObservers.push(this)
  }
  observe = (): void => {}
  unobserve = (): void => {}
  disconnect = (): void => {}
  emit(width: number): void {
    this.callback(
      [{ contentRect: { width } } as ResizeObserverEntry],
      this as unknown as ResizeObserver
    )
  }
}

/** Report a new pane width to whatever the viewer is observing. */
function resizePane(width: number): void {
  act(() => {
    for (const observer of [...mocks.resizeObservers]) observer.emit(width)
  })
}

function emitIndex(event: LargeFileIndexEvent): void {
  act(() => {
    for (const listener of [...mocks.indexListeners]) listener(event)
  })
}

/** Move the fake viewport and let the viewer react to it. */
async function scrollTo(firstRow: number, lineCount: number): Promise<void> {
  mocks.firstRow = firstRow
  // Re-emitting `ready` is the test's re-render trigger; the state it sets is a
  // fresh object, so React repaints and the virtualizer stub reports the new
  // window.
  emitIndex({ sessionId: 'session-1', status: 'ready', fileBytes: 40_000_000, lineCount })
  await act(async () => {
    await Promise.resolve()
  })
}

function emitSearchProgress(event: LargeFileSearchProgressEvent): void {
  act(() => {
    for (const listener of [...mocks.searchListeners]) listener(event)
  })
}

/** Opens the find bar the way the user does, and types `query` into it. */
async function findInFile(query: string): Promise<HTMLElement> {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true }))
  })
  const input = await screen.findByRole('textbox', { name: /find/i })
  // The bar focuses and selects its input on the next frame, exactly as the
  // note find bar does. Typing before that lands would have the selection
  // swallow the first character.
  await waitFor(() => expect(input).toHaveFocus())
  await userEvent.type(input, query)
  return input
}

function linePage(startLine: number, count: number, lineCount: number): LargeFileLinesResult {
  const available = Math.max(0, Math.min(count, lineCount - startLine))
  return {
    startLine,
    lines: Array.from({ length: available }, (_, i) => `row ${startLine + i}`),
    truncated: [],
    lineCount
  }
}

/** Drive the viewer to a scanned, readable file of `lineCount` lines. */
async function openReady(
  lineCount: number,
  fileBytes = 40_000_000
): Promise<{ unmount: () => void }> {
  mocks.open.mockResolvedValue({
    status: 'indexing',
    sessionId: 'session-1',
    fileBytes
  } satisfies LargeFileOpenResult)
  mocks.readLines.mockImplementation(
    async (input: { startLine: number; count: number }): Promise<LargeFileLinesResult> =>
      linePage(input.startLine, input.count, lineCount)
  )
  const rendered = render(
    <LargeFileViewer noteId="note-1" reason="file-bytes" measuredBytes={fileBytes} />
  )
  await waitFor(() => expect(mocks.open).toHaveBeenCalled())
  emitIndex({ sessionId: 'session-1', status: 'ready', fileBytes, lineCount })
  return rendered
}

describe('LargeFileViewer', () => {
  beforeEach(() => {
    mocks.visibleRows = 40
    mocks.firstRow = 0
    mocks.indexListeners = []
    mocks.searchListeners = []
    mocks.resizeObservers = []
    globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver
    mocks.scrollToIndex.mockReset()
    mocks.measureElement.mockReset()
    mocks.measure.mockReset()
    mocks.search.mockReset().mockResolvedValue({
      status: 'complete',
      query: '',
      hits: [],
      total: 0,
      limited: false
    } satisfies LargeFileSearchResult)
    mocks.open.mockReset()
    mocks.readLines.mockReset()
    mocks.close.mockReset().mockResolvedValue(undefined)
    mocks.openExternal.mockReset().mockResolvedValue(undefined)
    mocks.revealInFinder.mockReset().mockResolvedValue(undefined)

    const api = window.api as unknown as Record<string, unknown>
    api.notes = {
      ...((api.notes as Record<string, unknown>) ?? {}),
      largeFileOpen: mocks.open,
      largeFileReadLines: mocks.readLines,
      largeFileSearch: mocks.search,
      largeFileClose: mocks.close,
      openExternal: mocks.openExternal,
      revealInFinder: mocks.revealInFinder
    }
    api.onLargeFileIndex = (listener: (event: LargeFileIndexEvent) => void) => {
      mocks.indexListeners.push(listener)
      return () => {
        mocks.indexListeners = mocks.indexListeners.filter((l) => l !== listener)
      }
    }
    api.onLargeFileSearchProgress = (listener: (event: LargeFileSearchProgressEvent) => void) => {
      mocks.searchListeners.push(listener)
      return () => {
        mocks.searchListeners = mocks.searchListeners.filter((l) => l !== listener)
      }
    }
  })

  it('carries the read-only, not-synced badge the whole time it is open', async () => {
    // #given a file still being indexed
    mocks.open.mockResolvedValue({
      status: 'indexing',
      sessionId: 'session-1',
      fileBytes: 18_700_000
    } satisfies LargeFileOpenResult)
    mocks.readLines.mockResolvedValue(linePage(0, 200, 500))

    // #when
    render(<LargeFileViewer noteId="note-1" reason="file-bytes" measuredBytes={18_700_000} />)

    // #then — the badge is the promise that this never fails silently the way a
    // note that quietly stopped syncing does, so it is there before the content
    expect(await screen.findByText('Read-only · not synced')).toBeInTheDocument()

    // #when the scan finishes
    emitIndex({ sessionId: 'session-1', status: 'ready', fileBytes: 18_700_000, lineCount: 500 })

    // #then it is still there
    expect(await screen.findByText('row 0')).toBeInTheDocument()
    expect(screen.getByText('Read-only · not synced')).toBeInTheDocument()
  })

  it('opens a note that arrived over sync already flagged, with no measurements', async () => {
    // #given the shape an inbound sync writeback produces: the row is marked
    // large-file class without a `getNoteById` round trip, so the classifier's
    // measurements are not there yet and `reason` is undefined
    mocks.open.mockResolvedValue({
      status: 'indexing',
      sessionId: 'session-1',
      fileBytes: 4_000_000
    } satisfies LargeFileOpenResult)
    mocks.readLines.mockImplementation(
      async (input: { startLine: number; count: number }): Promise<LargeFileLinesResult> =>
        linePage(input.startLine, input.count, 300)
    )

    // #when
    render(<LargeFileViewer noteId="note-1" reason={undefined} measuredBytes={undefined} />)
    await waitFor(() => expect(mocks.open).toHaveBeenCalled())
    emitIndex({ sessionId: 'session-1', status: 'ready', fileBytes: 4_000_000, lineCount: 300 })

    // #then — the file still opens and still carries the badge. The main
    // process owns the file's size; the viewer never needed the classifier's
    // numbers to do its job.
    expect(await screen.findByText('row 0')).toBeInTheDocument()
    expect(screen.getByText('Read-only · not synced')).toBeInTheDocument()
  })

  it('reopens when the main process drops the session mid-scan', async () => {
    // #given a viewer still waiting on the scan
    mocks.open.mockResolvedValue({
      status: 'indexing',
      sessionId: 'session-1',
      fileBytes: 18_700_000
    } satisfies LargeFileOpenResult)
    mocks.readLines.mockImplementation(
      async (input: { startLine: number; count: number }): Promise<LargeFileLinesResult> =>
        linePage(input.startLine, input.count, 500)
    )
    render(<LargeFileViewer noteId="note-1" reason="file-bytes" measuredBytes={18_700_000} />)
    await waitFor(() => expect(mocks.open).toHaveBeenCalledTimes(1))

    // #when the session goes away before it was ever ready — the file changed
    // on disk, or the main process made room
    mocks.open.mockResolvedValue({
      status: 'indexing',
      sessionId: 'session-2',
      fileBytes: 18_700_000
    } satisfies LargeFileOpenResult)
    emitIndex({ sessionId: 'session-1', status: 'closed' })

    // #then the viewer reopens rather than showing a dead end. A page fetch is
    // the only other thing that would notice, and a viewer that never became
    // ready never fetches a page.
    await waitFor(() => expect(mocks.open).toHaveBeenCalledTimes(2))
    emitIndex({ sessionId: 'session-2', status: 'ready', fileBytes: 18_700_000, lineCount: 500 })
    expect(await screen.findByText('row 0')).toBeInTheDocument()
  })

  it('shows the file rather than an editor', async () => {
    // #given/when
    await openReady(500)

    // #then — no editable surface anywhere: no CRDT, no BlockNote, nothing that
    // could write back to a file this size
    expect(await screen.findByText('row 0')).toBeInTheDocument()
    expect(document.querySelector('[contenteditable="true"]')).toBeNull()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('fetches only the lines on screen, not the file', async () => {
    // #given a file of ten million lines, with 40 rows on screen
    await openReady(10_000_000)
    await screen.findByText('row 0')

    // #then — every window asked for is a bounded page. Asking for the file is
    // what the viewer exists to avoid: V8 cannot hold it as one string.
    expect(mocks.readLines).toHaveBeenCalled()
    for (const [input] of mocks.readLines.mock.calls) {
      expect(input.count).toBeLessThanOrEqual(2000)
      expect(input.startLine).toBeLessThan(2000)
    }
    // and the last line was never fetched, because it was never on screen
    const fetchedEnd = Math.max(
      ...mocks.readLines.mock.calls.map(([input]) => input.startLine + input.count)
    )
    expect(fetchedEnd).toBeLessThan(10_000_000)
  })

  it('reports scan progress instead of an unexplained wait', async () => {
    // #given a scan under way
    mocks.open.mockResolvedValue({
      status: 'indexing',
      sessionId: 'session-1',
      fileBytes: 1_000_000
    } satisfies LargeFileOpenResult)
    render(<LargeFileViewer noteId="note-1" reason="file-bytes" measuredBytes={1_000_000} />)
    await waitFor(() => expect(mocks.open).toHaveBeenCalled())

    // #when
    emitIndex({
      sessionId: 'session-1',
      status: 'scanning',
      bytesScanned: 250_000,
      fileBytes: 1_000_000
    })

    // #then — a progress bar with a real value, so a multi-second scan on a
    // 2 GB file reads as work rather than as a hang
    const bar = await screen.findByRole('progressbar')
    await waitFor(() => expect(bar).toHaveAttribute('aria-valuenow', '25'))
  })

  it('explains a file past the viewer ceiling instead of failing bare', async () => {
    // #given a file the viewer will not open at all
    mocks.open.mockResolvedValue({
      status: 'too-large',
      fileBytes: 3_000_000_000,
      maxBytes: 2_147_483_645
    } satisfies LargeFileOpenResult)

    // #when the row is clicked
    render(<LargeFileViewer noteId="note-1" reason="file-bytes" measuredBytes={3_000_000_000} />)

    // #then — the size, the ceiling, and a way out. The row stays in the
    // sidebar; what must not happen is a bare "failed to open".
    const notice = await screen.findByTestId('large-file-notice')
    expect(notice).toHaveTextContent('This file is too large to open')
    expect(notice).toHaveTextContent('2.8 GB')
    expect(notice).toHaveTextContent('2 GB')

    // #when
    await userEvent.click(screen.getByRole('button', { name: 'Open in default app' }))

    // #then
    expect(mocks.openExternal).toHaveBeenCalledWith('note-1')
  })

  it('says so when the scan fails rather than spinning forever', async () => {
    // #given
    mocks.open.mockResolvedValue({
      status: 'indexing',
      sessionId: 'session-1',
      fileBytes: 5_000
    } satisfies LargeFileOpenResult)
    render(<LargeFileViewer noteId="note-1" reason="file-bytes" measuredBytes={5_000} />)
    await waitFor(() => expect(mocks.open).toHaveBeenCalled())

    // #when
    emitIndex({ sessionId: 'session-1', status: 'error', message: 'EIO' })

    // #then
    expect(
      await screen.findByText('This file could not be prepared for reading.')
    ).toBeInTheDocument()
  })

  it('says so when the file is gone', async () => {
    // #given
    mocks.open.mockResolvedValue({ status: 'missing' } satisfies LargeFileOpenResult)

    // #when
    render(<LargeFileViewer noteId="note-1" reason="file-bytes" measuredBytes={5_000} />)

    // #then
    expect(await screen.findByText('This file is no longer on disk.')).toBeInTheDocument()
  })

  it('marks a line that was cut so the gap is never silent', async () => {
    // #given a file whose first line is longer than the per-line cap
    mocks.open.mockResolvedValue({
      status: 'indexing',
      sessionId: 'session-1',
      fileBytes: 5_000_000
    } satisfies LargeFileOpenResult)
    mocks.readLines.mockResolvedValue({
      startLine: 0,
      lines: ['y'.repeat(40), 'short'],
      truncated: [0],
      lineCount: 2
    } satisfies LargeFileLinesResult)
    render(<LargeFileViewer noteId="note-1" reason="block-bytes" measuredBytes={5_000_000} />)
    await waitFor(() => expect(mocks.open).toHaveBeenCalled())

    // #when
    emitIndex({ sessionId: 'session-1', status: 'ready', fileBytes: 5_000_000, lineCount: 2 })

    // #then
    expect(await screen.findByText('long line cut here')).toBeInTheDocument()
  })

  it('wraps a line too long for the pane instead of putting it out of reach', async () => {
    // #given a file shaped like a real log dump: one minified JSON record per
    // line, far wider than any pane and with no space in it to break at
    const record = `{"ts":"2026-08-15T09:12:03Z","msg":"${'x'.repeat(400)}"}`
    mocks.open.mockResolvedValue({
      status: 'indexing',
      sessionId: 'session-1',
      fileBytes: 66_200_000
    } satisfies LargeFileOpenResult)
    mocks.readLines.mockResolvedValue({
      startLine: 0,
      lines: [record],
      truncated: [],
      lineCount: 1
    } satisfies LargeFileLinesResult)
    render(<LargeFileViewer noteId="note-1" reason="file-bytes" measuredBytes={66_200_000} />)
    await waitFor(() => expect(mocks.open).toHaveBeenCalled())

    // #when
    emitIndex({ sessionId: 'session-1', status: 'ready', fileBytes: 66_200_000, lineCount: 1 })

    // #then — jsdom does no layout, so what is asserted is the rule that causes
    // the wrap: whitespace still significant, and a break allowed inside a
    // 17 KB token that has nowhere else to break.
    const line = await screen.findByText(record)
    expect(line).toHaveClass('whitespace-pre-wrap')
    expect(line).toHaveClass('break-words')
    // #and a row still holds one line open when it has nothing in it — a blank
    // line, or a line whose page has not landed yet. Wrapping made the height
    // content-driven, and a collapsed row would measure as zero.
    expect(line).toHaveClass('min-h-[1lh]')

    // #and nothing is sized to its content any more. Content-width rows inside
    // an absolutely positioned virtualizer never gave the scroll container a
    // horizontal scrollbar, which is what put the overflow out of reach.
    const viewer = screen.getByTestId('large-file-viewer')
    expect(viewer.querySelector('.w-max')).toBeNull()
  })

  it('measures the rows it draws, because a wrapped line is not one row tall', async () => {
    // #given
    await openReady(500)
    const first = await screen.findByText('row 0')

    // #then — the row is handed to the virtualizer to measure, under the index
    // the measurement is filed against. Fixed row heights are what let a 2 GB
    // file scroll; one wrapped 17 KB line is ~170 visual rows, so the height
    // has to come from the DOM instead of from a constant.
    const row = first.closest('[data-index]')
    expect(row).toHaveAttribute('data-index', '0')
    expect(mocks.measureElement).toHaveBeenCalledWith(row)

    // #and nothing pins the row to one line's height, which would clip it again
    expect((row as HTMLElement).style.height).toBe('')
  })

  it('reads like a note rather than a code viewer', async () => {
    // #given
    await openReady(500)
    const viewer = await screen.findByTestId('large-file-viewer')
    await screen.findByText('row 0')

    // #then — no line-number gutter and no monospace. A note has neither, and
    // this is a note that happens to be too big to edit.
    expect(within(viewer).queryByText('1')).toBeNull()
    expect(viewer.querySelector('.font-mono')).toBeNull()

    // #and the two pieces of chrome that stop the refusal reading as breakage
    // stay put: the badge, and the line naming the size against the limit
    expect(within(viewer).getByText('Read-only · not synced')).toBeInTheDocument()
    expect(within(viewer).getByText(/Notes stay editable up to/)).toBeInTheDocument()
  })

  it('keeps the cut mark on the line it cut, now that the line wraps', async () => {
    // #given a line past the 64 KB per-line cap
    const cut = 'y'.repeat(400)
    mocks.open.mockResolvedValue({
      status: 'indexing',
      sessionId: 'session-1',
      fileBytes: 5_000_000
    } satisfies LargeFileOpenResult)
    mocks.readLines.mockResolvedValue({
      startLine: 0,
      lines: [cut, 'short'],
      truncated: [0],
      lineCount: 2
    } satisfies LargeFileLinesResult)
    render(<LargeFileViewer noteId="note-1" reason="block-bytes" measuredBytes={5_000_000} />)
    await waitFor(() => expect(mocks.open).toHaveBeenCalled())

    // #when
    emitIndex({ sessionId: 'session-1', status: 'ready', fileBytes: 5_000_000, lineCount: 2 })

    // #then — the mark rides with the text it belongs to. In a column of its
    // own it would sit one wrapped screenful away from the cut it names.
    const mark = await screen.findByText('long line cut here')
    const row = mark.closest('[data-index]')
    expect(row).toHaveAttribute('data-index', '0')
    expect(row).toHaveTextContent(cut)
  })

  it('re-measures when the pane changes width, and not when it does not', async () => {
    // #given a file drawn and measured at one width
    await openReady(500)
    await screen.findByText('row 0')
    resizePane(900)
    mocks.measure.mockReset()
    const measuredBefore = mocks.measureElement.mock.calls.length

    // #when the pane reports a size whose width did not change
    resizePane(900)

    // #then nothing is thrown away. A vertical resize does not move the wrap
    // point, and dropping every height for one would be work for nothing.
    expect(mocks.measure).not.toHaveBeenCalled()

    // #when the width actually changes
    resizePane(600)

    // #then every cached height goes: a height measured at 900px is not true of
    // any row at 600px
    expect(mocks.measure).toHaveBeenCalled()
    // #and the rows on screen measure themselves again. Clearing alone would
    // strand them on the estimate — a row whose own box the browser has already
    // settled never fires its own observer a second time.
    await waitFor(() =>
      expect(mocks.measureElement.mock.calls.length).toBeGreaterThan(measuredBefore)
    )
  })

  it('reopens after the main process let the session go', async () => {
    // #given a viewer whose session was evicted behind other large files —
    // reachable by hand: the main process keeps 4 open at a time
    let opens = 0
    mocks.open.mockImplementation(async () => {
      opens += 1
      return { status: 'indexing', sessionId: `session-${opens}`, fileBytes: 900_000 }
    })
    mocks.readLines.mockImplementation(
      async (input: { sessionId: string; startLine: number; count: number }) =>
        // The first session is gone; the second answers normally.
        input.sessionId === 'session-1' ? null : linePage(input.startLine, input.count, 120)
    )

    // #when
    render(<LargeFileViewer noteId="note-1" reason="file-bytes" measuredBytes={900_000} />)
    await waitFor(() => expect(mocks.open).toHaveBeenCalled())
    emitIndex({ sessionId: 'session-1', status: 'ready', fileBytes: 900_000, lineCount: 120 })
    await waitFor(() => expect(opens).toBe(2))
    emitIndex({ sessionId: 'session-2', status: 'ready', fileBytes: 900_000, lineCount: 120 })

    // #then — a dead session is reopened rather than shown as an error. The
    // user scrolled; nothing about that should surface as a failure.
    expect(await screen.findByText('row 0')).toBeInTheDocument()
  })

  it('keeps events that arrive before the session id does', async () => {
    // #given a scan that finishes before `largeFileOpen` resolves — what a
    // small large-file-class dump does, where the scan is faster than the
    // round trip that names the session
    let release: (() => void) | null = null
    mocks.open.mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return { status: 'indexing', sessionId: 'session-1', fileBytes: 600_000 }
    })
    mocks.readLines.mockImplementation(async (input: { startLine: number; count: number }) =>
      linePage(input.startLine, input.count, 70)
    )
    render(<LargeFileViewer noteId="note-1" reason="file-bytes" measuredBytes={600_000} />)
    await waitFor(() => expect(release).not.toBeNull())

    // #when the ready event lands first, then the open resolves
    emitIndex({ sessionId: 'session-1', status: 'ready', fileBytes: 600_000, lineCount: 70 })
    release!()

    // #then — the event was held, not dropped. Dropping it leaves the viewer
    // on a progress bar that never moves for a file that is already scanned.
    expect(await screen.findByText('row 0')).toBeInTheDocument()
  })

  it('drops pages by the bytes they hold, not by how many of them there are', async () => {
    // #given a long file of fat lines — the 69 MB shape, where 200 lines is
    // megabytes rather than kilobytes. Counting pages says 20 of these are
    // cheap; they are the whole file.
    const lineCount = 200_000
    const fat = 'x'.repeat(8_000)
    mocks.open.mockResolvedValue({
      status: 'indexing',
      sessionId: 'session-1',
      fileBytes: 40_000_000
    } satisfies LargeFileOpenResult)
    mocks.readLines.mockImplementation(
      async (input: { startLine: number; count: number }): Promise<LargeFileLinesResult> => ({
        startLine: input.startLine,
        lines: Array.from(
          { length: Math.max(0, Math.min(input.count, lineCount - input.startLine)) },
          (_, i) => `row ${input.startLine + i} ${fat}`
        ),
        truncated: [],
        lineCount
      })
    )
    render(<LargeFileViewer noteId="note-1" reason="file-bytes" measuredBytes={40_000_000} />)
    await waitFor(() => expect(mocks.open).toHaveBeenCalled())
    emitIndex({ sessionId: 'session-1', status: 'ready', fileBytes: 40_000_000, lineCount })

    const fetchesOfFirstPage = () =>
      mocks.readLines.mock.calls.filter(([input]) => input.startLine === 0).length
    await waitFor(() => expect(fetchesOfFirstPage()).toBe(1))

    // #when the viewport travels far enough that the pages behind it are more
    // than the cache's byte budget — 16 pages of ~1.6 M characters each
    for (let page = 1; page <= 16; page++) {
      await scrollTo(page * 200, lineCount)
    }

    // #then — scrolling back to the top re-fetches page 0, because it was let
    // go. Counting pages never would have: 17 pages is well inside any page
    // count, and is 27 M characters of text held in the renderer.
    await scrollTo(0, lineCount)
    await waitFor(() => expect(fetchesOfFirstPage()).toBe(2))
  })

  it('pages on from where a short page ended rather than from a fixed stride', async () => {
    // #given a main process that ends a page at its byte budget: 15 lines came
    // back where 200 were asked for, because each line is ~18 KB
    const lineCount = 100_000
    mocks.open.mockResolvedValue({
      status: 'indexing',
      sessionId: 'session-1',
      fileBytes: 69_420_544
    } satisfies LargeFileOpenResult)
    mocks.readLines.mockImplementation(
      async (input: { startLine: number }): Promise<LargeFileLinesResult> => ({
        startLine: input.startLine,
        lines: Array.from({ length: 15 }, (_, i) => `row ${input.startLine + i}`),
        truncated: [],
        lineCount
      })
    )
    render(<LargeFileViewer noteId="note-1" reason="file-bytes" measuredBytes={69_420_544} />)
    await waitFor(() => expect(mocks.open).toHaveBeenCalled())
    emitIndex({ sessionId: 'session-1', status: 'ready', fileBytes: 69_420_544, lineCount })

    // #then — the rows past the first short page are filled in. A page whose
    // identity is `startLine / 200` cannot express this: line 20 would be
    // looked for at index 20 of a page holding 15 lines, and stay blank
    // forever, while the fetch for it would never be issued at all.
    expect(await screen.findByText('row 20')).toBeInTheDocument()
    expect(await screen.findByText('row 39')).toBeInTheDocument()
    const starts = mocks.readLines.mock.calls.map(([input]) => input.startLine)
    expect(starts).toContain(15)
    expect(starts).toContain(30)
    // and nothing was asked for twice: the walk resumes at the end of the page
    // that landed, so no request overlaps the one before it
    expect(new Set(starts).size).toBe(starts.length)
  })

  it('replaces a page it overlaps rather than leaving two claims on one line', async () => {
    // #given a viewport parked mid-file, so the page fetched for it starts at
    // line 50 and runs to 249 — pages no longer land on any fixed stride
    const lineCount = 100_000
    let generation = 0
    mocks.visibleRows = 100
    mocks.firstRow = 50
    mocks.open.mockResolvedValue({
      status: 'indexing',
      sessionId: 'session-1',
      fileBytes: 40_000_000
    } satisfies LargeFileOpenResult)
    mocks.readLines.mockImplementation(
      async (input: { startLine: number }): Promise<LargeFileLinesResult> => {
        generation += 1
        const at = generation
        return {
          startLine: input.startLine,
          lines: Array.from({ length: 200 }, (_, i) => `row ${input.startLine + i} v${at}`),
          truncated: [],
          lineCount
        }
      }
    )
    render(<LargeFileViewer noteId="note-1" reason="file-bytes" measuredBytes={40_000_000} />)
    await waitFor(() => expect(mocks.open).toHaveBeenCalled())
    emitIndex({ sessionId: 'session-1', status: 'ready', fileBytes: 40_000_000, lineCount })
    expect(await screen.findByText('row 50 v1')).toBeInTheDocument()

    // #when the reader scrolls back to the top, and the page fetched for line 0
    // runs 200 lines — straight over the one that started at 50
    await scrollTo(0, lineCount)

    // #then every line reads from the page that arrived last. Two pages both
    // claiming line 60 would answer differently depending on where the search
    // landed, which is not a bug worth being able to have.
    expect(await screen.findByText('row 60 v2')).toBeInTheDocument()
    expect(screen.queryByText('row 60 v1')).not.toBeInTheDocument()
  })

  it('renders the head of a very long line, with a way to see the rest', async () => {
    // #given one 18 KB minified record — a single file line that wraps into
    // ~200 visual rows, which is the layout cost the freeze was made of
    const head = 'a'.repeat(2_048)
    const tail = `TAIL-MARKER${'b'.repeat(6_000)}`
    mocks.open.mockResolvedValue({
      status: 'indexing',
      sessionId: 'session-1',
      fileBytes: 69_420_544
    } satisfies LargeFileOpenResult)
    mocks.readLines.mockResolvedValue({
      startLine: 0,
      lines: [head + tail],
      truncated: [],
      lineCount: 1
    } satisfies LargeFileLinesResult)
    render(<LargeFileViewer noteId="note-1" reason="file-bytes" measuredBytes={69_420_544} />)
    await waitFor(() => expect(mocks.open).toHaveBeenCalled())
    emitIndex({ sessionId: 'session-1', status: 'ready', fileBytes: 69_420_544, lineCount: 1 })

    // #then — the row is drawn short, and says so
    const showRest = await screen.findByRole('button', { name: /show the rest of this line/i })
    expect(document.body.textContent).not.toContain('TAIL-MARKER')

    // #when the reader asks for the rest
    await userEvent.click(showRest)

    // #then it is all there, and the control is gone
    await waitFor(() => expect(document.body.textContent).toContain('TAIL-MARKER'))
    expect(
      screen.queryByRole('button', { name: /show the rest of this line/i })
    ).not.toBeInTheDocument()
  })

  it('leaves an ordinary line whole, with no control on it', async () => {
    // #given/when a file of normal lines
    await openReady(500)

    // #then — the cap is for the pathological case; it must not put a control
    // on every row of a log file
    expect(await screen.findByText('row 0')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /show the rest of this line/i })
    ).not.toBeInTheDocument()
  })

  it('gives up cleanly when the open itself fails', async () => {
    // #given main refusing the open outright
    mocks.open.mockRejectedValue(new Error('EIO'))

    // #when
    render(<LargeFileViewer noteId="note-1" reason="file-bytes" measuredBytes={900_000} />)

    // #then — one fixed sentence, not a spinner and not a raw errno
    expect(
      await screen.findByText('This file could not be prepared for reading.')
    ).toBeInTheDocument()
  })

  it('closes a session it learns about only after the viewer is gone', async () => {
    // #given an open that resolves after unmount — a tab closed while the main
    // process was still opening the file
    let release: ((value: LargeFileOpenResult) => void) | null = null
    mocks.open.mockImplementation(
      () =>
        new Promise<LargeFileOpenResult>((resolve) => {
          release = resolve
        })
    )
    const { unmount } = render(
      <LargeFileViewer noteId="note-1" reason="file-bytes" measuredBytes={900_000} />
    )
    await waitFor(() => expect(release).not.toBeNull())

    // #when
    unmount()
    release!({ status: 'indexing', sessionId: 'session-late', fileBytes: 900_000 })

    // #then — the handle is released. Nobody is left to close it otherwise, and
    // it would be pinned for the life of the app.
    await waitFor(() => expect(mocks.close).toHaveBeenCalledWith('session-late'))
  })

  it('releases the file handle when the viewer goes away', async () => {
    // #given an open session
    const { unmount } = await openReady(500)
    await screen.findByText('row 0')

    // #when the tab closes
    unmount()

    // #then the session is released — one OS file handle per file ever opened
    // is not something a long-running app can carry
    await waitFor(() => expect(mocks.close).toHaveBeenCalledWith('session-1'))
  })

  it('finds inside the file on the same shortcut the rest of the app uses', async () => {
    // #given a ready file whose text is not in any search index
    await openReady(400)
    mocks.search.mockResolvedValue({
      status: 'complete',
      query: 'row 7',
      hits: [
        { line: 7, ordinal: 0 },
        { line: 70, ordinal: 0 }
      ],
      total: 2,
      limited: false
    } satisfies LargeFileSearchResult)

    // #when the user presses the app's find shortcut
    await findInFile('row 7')

    // #then — the search runs in the main process over the open session, and
    // the count is the file's, not the handful of rows on screen
    await waitFor(() =>
      expect(mocks.search).toHaveBeenCalledWith({ sessionId: 'session-1', query: 'row 7' })
    )
    expect(await screen.findByText('1/2')).toBeInTheDocument()
  })

  it('marks a count that is still growing as still growing', async () => {
    // #given a search that has not finished crossing the file
    await openReady(400)
    mocks.search.mockReturnValue(new Promise(() => {}))

    // #when the pass reports what it has so far
    await findInFile('row')
    await waitFor(() => expect(mocks.search).toHaveBeenCalled())
    emitSearchProgress({
      sessionId: 'session-1',
      query: 'row',
      bytesSearched: 1_000,
      fileBytes: 40_000_000,
      total: 12
    })

    // #then — a partial count rendered as "12" would read as the answer. At
    // 2 GB the pass takes seconds, so it has to say it is not done.
    expect(await screen.findByText(/12 so far/)).toBeInTheDocument()
    expect(screen.queryByText('1/12')).not.toBeInTheDocument()
  })

  it('says a capped hit list is capped instead of passing it off as the total', async () => {
    // #given more matches than the navigable list holds
    await openReady(400)
    mocks.search.mockResolvedValue({
      status: 'complete',
      query: 'row',
      hits: Array.from({ length: 3 }, (_, i) => ({ line: i, ordinal: 0 })),
      total: 900_000,
      limited: true
    } satisfies LargeFileSearchResult)

    // #when
    await findInFile('row')

    // #then — the navigable list is 3 long and the file holds 900 000. Showing
    // "1/900000" would promise 900 000 stops the bar cannot make.
    expect(await screen.findByText('1/3 of 900000')).toBeInTheDocument()
  })

  it('highlights the matches on the rows the viewer is showing', async () => {
    // #given a file whose visible rows contain the query
    await openReady(400)
    mocks.search.mockResolvedValue({
      status: 'complete',
      query: 'ow 1',
      hits: [{ line: 1, ordinal: 0 }],
      total: 1,
      limited: false
    } satisfies LargeFileSearchResult)

    // #when
    await findInFile('ow 1')

    // #then — the highlight is drawn from the line text already on screen, so
    // nothing extra is fetched to draw it
    const marks = await screen.findAllByText('ow 1', { selector: 'mark' })
    expect(marks.length).toBeGreaterThan(0)
  })

  it('moves to the next hit and takes the viewport with it', async () => {
    // #given two hits, one of them far down the file
    await openReady(4000)
    mocks.search.mockResolvedValue({
      status: 'complete',
      query: 'row 7',
      hits: [
        { line: 7, ordinal: 0 },
        { line: 3_500, ordinal: 0 }
      ],
      total: 2,
      limited: false
    } satisfies LargeFileSearchResult)
    const input = await findInFile('row 7')
    expect(await screen.findByText('1/2')).toBeInTheDocument()

    // #when
    await userEvent.type(input, '{Enter}')

    // #then — a hit 3 500 rows down is unreachable without this
    expect(await screen.findByText('2/2')).toBeInTheDocument()
    await waitFor(() => expect(mocks.scrollToIndex).toHaveBeenCalledWith(3_500, expect.anything()))
  })

  it('wraps backwards from the first hit rather than stopping at it', async () => {
    // #given
    await openReady(400)
    mocks.search.mockResolvedValue({
      status: 'complete',
      query: 'row',
      hits: [
        { line: 1, ordinal: 0 },
        { line: 2, ordinal: 0 },
        { line: 3, ordinal: 0 }
      ],
      total: 3,
      limited: false
    } satisfies LargeFileSearchResult)
    const input = await findInFile('row')
    expect(await screen.findByText('1/3')).toBeInTheDocument()

    // #when
    await userEvent.type(input, '{Shift>}{Enter}{/Shift}')

    // #then
    expect(await screen.findByText('3/3')).toBeInTheDocument()
  })

  it('closes the find bar and drops its highlights on Escape', async () => {
    // #given a search with a hit on screen
    await openReady(400)
    mocks.search.mockResolvedValue({
      status: 'complete',
      query: 'ow 1',
      hits: [{ line: 1, ordinal: 0 }],
      total: 1,
      limited: false
    } satisfies LargeFileSearchResult)
    const input = await findInFile('ow 1')
    expect(await screen.findAllByText('ow 1', { selector: 'mark' })).not.toHaveLength(0)

    // #when
    await userEvent.type(input, '{Escape}')

    // #then
    await waitFor(() => expect(screen.queryByText('ow 1', { selector: 'mark' })).toBeNull())
    expect(input.closest('[aria-hidden]')).toHaveAttribute('aria-hidden', 'true')

    // #and reopening starts from nothing rather than the last search
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true }))
    })
    expect(await screen.findByRole('textbox', { name: /find/i })).toHaveValue('')
  })

  it('stops saying it is searching when the session has gone', async () => {
    // #given a session the main process no longer has — evicted behind another
    // file, or a restart — answering only once the bar is already searching
    await openReady(400)
    let answer = (): void => {}
    mocks.search.mockReturnValue(
      new Promise((resolve) => {
        answer = () => resolve(null)
      })
    )
    const input = await findInFile('row')
    const bar = input.parentElement as HTMLElement
    expect(await screen.findByText(/0 so far/)).toBeInTheDocument()

    // #when
    act(() => answer())

    // #then — the bar settles rather than spinning on a count that will never
    // arrive. The next keystroke searches the reopened session.
    await waitFor(() => expect(within(bar).getByText('0')).toBeInTheDocument())
    expect(screen.queryByText(/so far/)).not.toBeInTheDocument()
  })

  it('settles rather than spinning when the search itself fails', async () => {
    // #given a search that fails once the bar is already searching
    await openReady(400)
    let fail = (): void => {}
    mocks.search.mockReturnValue(
      new Promise((_resolve, reject) => {
        fail = () => reject(new Error('EBADF'))
      })
    )
    const input = await findInFile('row')
    const bar = input.parentElement as HTMLElement
    expect(await screen.findByText(/0 so far/)).toBeInTheDocument()

    // #when
    act(() => fail())

    // #then — "searching" that never ends is the one state the bar must not
    // get stuck in, because it reads as "still counting" forever
    await waitFor(() => expect(within(bar).getByText('0')).toBeInTheDocument())
    expect(screen.queryByText(/so far/)).not.toBeInTheDocument()
  })

  it.runIf(process.env.MEMRY_LARGE_FILE_STRESS === '1')(
    'measures what one viewport of the worst-shaped file costs',
    { timeout: 120_000 },
    async () => {
      // The real report: a 66.2 MB log of 3 863 lines, ~17 KB each, every line
      // one minified JSON record. Reported, not asserted — jsdom has no layout
      // engine, so what this bounds is the JS and DOM half: how much text the
      // design commits to the document for one screen, and what React costs to
      // put it there and to move it. Chromium's cost of breaking that text into
      // line boxes is not measurable here and is not claimed.
      //
      //   MEMRY_LARGE_FILE_STRESS=1 npx vitest run --config config/vitest.config.ts \
      //     --project renderer src/renderer/src/components/note/large-file-viewer.test.tsx
      const lineCount = 3_863
      const record = `{"ts":"2026-08-15T09:12:03Z","level":"info","msg":"${'x'.repeat(17_000)}"}`
      // One 66.2 MB line at a time is far more than fits: rows tall enough to
      // hold a wrapped 17 KB record leave one or two visible, and the overscan
      // is 24 either side.
      mocks.visibleRows = 50
      mocks.open.mockResolvedValue({
        status: 'indexing',
        sessionId: 'session-1',
        fileBytes: 66_200_000
      } satisfies LargeFileOpenResult)
      mocks.readLines.mockImplementation(
        async (input: { startLine: number; count: number }): Promise<LargeFileLinesResult> => ({
          startLine: input.startLine,
          lines: Array.from({ length: Math.min(input.count, lineCount - input.startLine) }, () =>
            record.slice()
          ),
          truncated: [],
          lineCount
        })
      )

      const openedAt = performance.now()
      render(<LargeFileViewer noteId="note-1" reason="file-bytes" measuredBytes={66_200_000} />)
      await waitFor(() => expect(mocks.open).toHaveBeenCalled())
      emitIndex({ sessionId: 'session-1', status: 'ready', fileBytes: 66_200_000, lineCount })
      const viewer = await screen.findByTestId('large-file-viewer')
      await waitFor(() => expect(viewer.textContent?.length ?? 0).toBeGreaterThan(100_000))
      const firstPaintMs = performance.now() - openedAt

      const scrolledAt = performance.now()
      await scrollTo(1_000, lineCount)
      const scrollMs = performance.now() - scrolledAt

      // eslint-disable-next-line no-console
      console.info('large-file viewer, 66.2 MB / 17 KB lines:', {
        rowsDrawn: viewer.querySelectorAll('[data-index]').length,
        charsInDom: viewer.textContent?.length ?? 0,
        firstPaintMs: Math.round(firstPaintMs),
        scrollMs: Math.round(scrollMs)
      })
    }
  )

  it("settles when something else takes the file's one search", async () => {
    // #given another window on the same file starting its own search, which
    // supersedes this one in the main process
    await openReady(400)
    let supersede = (): void => {}
    mocks.search.mockReturnValue(
      new Promise((resolve) => {
        supersede = () => resolve({ status: 'cancelled', query: 'row' })
      })
    )
    const input = await findInFile('row')
    const bar = input.parentElement as HTMLElement
    expect(await screen.findByText(/0 so far/)).toBeInTheDocument()

    // #when
    act(() => supersede())

    // #then — a query this bar did not replace has to settle here, or the bar
    // counts forever against a pass that is not running
    await waitFor(() => expect(within(bar).getByText('0')).toBeInTheDocument())
    expect(screen.queryByText(/so far/)).not.toBeInTheDocument()
  })
})

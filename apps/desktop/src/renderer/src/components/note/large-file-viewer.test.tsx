import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  LargeFileIndexEvent,
  LargeFileLinesResult,
  LargeFileOpenResult
} from '@memry/contracts/notes-api'

const mocks = vi.hoisted(() => ({
  /** How many rows the virtualizer is pretending fit on screen. */
  visibleRows: 40,
  /** Index of the first row on screen — the test's scroll position. */
  firstRow: 0,
  open: vi.fn(),
  readLines: vi.fn(),
  close: vi.fn(),
  openExternal: vi.fn(),
  revealInFinder: vi.fn(),
  indexListeners: [] as Array<(event: LargeFileIndexEvent) => void>
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
      measureElement: () => {}
    }
  }
}))

import { LargeFileViewer } from './large-file-viewer'

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

  it('drops pages far behind the viewport instead of keeping every line scrolled past', async () => {
    // #given a long file, scrolled from the top
    const lineCount = 200_000
    await openReady(lineCount)
    await screen.findByText('row 0')
    const fetchesOfFirstPage = () =>
      mocks.readLines.mock.calls.filter(([input]) => input.startLine === 0).length
    expect(fetchesOfFirstPage()).toBe(1)

    // #when the viewport travels past the page cache — 60 pages of 200 lines,
    // against a 48-page cache
    for (let page = 1; page <= 60; page++) {
      await scrollTo(page * 200, lineCount)
    }

    // #then — scrolling back to the top re-fetches page 0, because it was let
    // go. A viewer that kept every page walked through a 2 GB file would end up
    // holding the file, which is the thing this design exists to avoid.
    await scrollTo(0, lineCount)
    await waitFor(() => expect(fetchesOfFirstPage()).toBe(2))
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
})

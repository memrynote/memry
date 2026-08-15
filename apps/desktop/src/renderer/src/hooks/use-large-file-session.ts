/**
 * Owns one read-only session over a large vault file.
 *
 * The file is never fetched. The main process holds an open handle and a sparse
 * line-offset index; this hook asks it for bounded pages of lines as the
 * viewport moves, and keeps only the pages near the viewport. That is the whole
 * reason a 2 GB file can be scrolled: V8 caps a string at ~512 MB, so any
 * design that assembles the file in the renderer stops well short of the
 * ceiling.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { createLogger } from '@/lib/logger'
import type { LargeFileIndexEvent } from '@memry/contracts/notes-api'

const log = createLogger('LargeFileSession')

/**
 * Ceiling on the lines in one fetched page. One screenful is ~50 rows; this is
 * a few of those.
 *
 * A ceiling, not the page size: the main process ends a page early once it has
 * filled `LARGE_FILE_PAGE_BYTES` (`main/vault/large-file-index.ts`), so a file
 * of 18 KB lines pages ~15 lines at a time and an ordinary log pages 200. Page
 * identity therefore cannot be `line / LARGE_FILE_PAGE_LINES` — pages are kept
 * as a sorted, non-overlapping run and looked up by the line they cover.
 */
export const LARGE_FILE_PAGE_LINES = 200

/**
 * Characters of line text the page cache holds. **The dial for memory.**
 *
 * A page count was the old bound (48 pages) and it never once fired on the file
 * that motivated this: 3 863 lines at 200 per page is 20 pages, so the cache
 * "never full" meant the renderer holding all 69 MB as JS strings. Bytes are
 * the bound that means anything when pages vary in size.
 *
 * 16 M characters is roughly 16–32 MB of V8 string memory — one character is
 * one byte for Latin-1 text and two once anything else appears on the line.
 * Lower it if memory matters more than not re-fetching; raise it if scrolling
 * back over a stretch you have already read re-fetches too eagerly.
 */
const PAGE_CACHE_CHARS = 16 * 1024 * 1024

export type LargeFileViewState =
  | { status: 'opening' }
  | { status: 'indexing'; fileBytes: number; bytesScanned: number }
  | { status: 'ready'; fileBytes: number; lineCount: number }
  | { status: 'too-large'; fileBytes: number; maxBytes: number }
  | { status: 'missing' }
  // Deliberately message-free: the viewer shows one fixed sentence, and the
  // detail (an errno, a worker fault) belongs in the log, not on screen.
  | { status: 'error' }

/**
 * One page as it landed: the lines the main process chose to end it at.
 *
 * `startLine` is the page's identity. Nothing divides to find it, because the
 * main process ends a page at a byte budget and the renderer only learns how
 * long a page is when it arrives.
 */
interface Page {
  startLine: number
  lines: string[]
  truncated: Set<number>
  /** Characters of line text held here, which is what the cache bound counts. */
  chars: number
  /** Monotonic touch counter, for least-recently-used trimming. */
  lastUsed: number
}

export interface LargeFileSession {
  state: LargeFileViewState
  /** The open session, for anything else that reads through it — search. */
  sessionId: string | null
  /** Undefined until the page holding this line has arrived. */
  getLine: (line: number) => string | undefined
  isTruncated: (line: number) => boolean
  /** Ask for the pages covering this line range, if they are not already here. */
  ensureRange: (startLine: number, endLine: number) => void
}

export function useLargeFileSession(noteId: string): LargeFileSession {
  const [state, setState] = useState<LargeFileViewState>({ status: 'opening' })
  // Mirrors `sessionIdRef` as state, because the search hook has to re-run when
  // the session behind the viewer changes.
  const [sessionId, setSessionId] = useState<string | null>(null)
  // Bumped whenever a page lands, so the viewer repaints. The pages themselves
  // live in a ref: they are a cache keyed by position, not render state, and
  // copying the map on every arriving page would be the expensive part.
  const [, setPagesRevision] = useState(0)
  // Bumped to reopen after the main process let the session go.
  const [generation, setGeneration] = useState(0)

  // Sorted by `startLine` and non-overlapping, so a line is found by binary
  // search rather than by dividing.
  const pagesRef = useRef<Page[]>([])
  // One request at a time: the next page starts where the last one ended, and
  // that is only known once it has landed.
  const inFlightRef = useRef<number | null>(null)
  // The range the viewport last asked for, so a page arriving can carry on
  // filling it without the viewer having to ask again.
  const rangeRef = useRef<{ start: number; end: number } | null>(null)
  const tickRef = useRef(0)
  const sessionIdRef = useRef<string | null>(null)

  useEffect(() => {
    let cancelled = false
    // Events can arrive before `largeFileOpen` resolves — a small file can be
    // scanned faster than the open round trip completes — and the session id
    // only exists once it does. Hold them rather than drop them.
    const buffered: LargeFileIndexEvent[] = []

    pagesRef.current = []
    inFlightRef.current = null
    rangeRef.current = null
    sessionIdRef.current = null

    const apply = (event: LargeFileIndexEvent): void => {
      if (event.sessionId !== sessionIdRef.current) return
      if (event.status === 'scanning') {
        setState({
          status: 'indexing',
          fileBytes: event.fileBytes,
          bytesScanned: event.bytesScanned
        })
        return
      }
      if (event.status === 'ready') {
        setState({ status: 'ready', fileBytes: event.fileBytes, lineCount: event.lineCount })
        return
      }
      if (event.status === 'closed') {
        // The main process let the session go — the file changed, or it needed
        // the handle back. Nothing failed, so reopening is the answer rather
        // than an error page, which is a dead end. This is the same recovery a
        // null page read triggers; it is here because a viewer that never
        // became ready never reads a page and would otherwise wait forever.
        setState({ status: 'opening' })
        setGeneration((n) => n + 1)
        return
      }
      log.warn('Line-offset scan failed', { message: event.message })
      setState({ status: 'error' })
    }

    const unsubscribe = window.api.onLargeFileIndex((event) => {
      if (cancelled) return
      if (sessionIdRef.current === null) {
        buffered.push(event)
        return
      }
      apply(event)
    })

    void (async () => {
      try {
        const opened = await window.api.notes.largeFileOpen(noteId)
        if (cancelled) {
          if (opened.status === 'indexing' || opened.status === 'ready') {
            void window.api.notes.largeFileClose(opened.sessionId)
          }
          return
        }

        if (opened.status === 'too-large') {
          setState({ status: 'too-large', fileBytes: opened.fileBytes, maxBytes: opened.maxBytes })
          return
        }
        if (opened.status === 'missing') {
          setState({ status: 'missing' })
          return
        }

        sessionIdRef.current = opened.sessionId
        setSessionId(opened.sessionId)
        setState(
          opened.status === 'ready'
            ? { status: 'ready', fileBytes: opened.fileBytes, lineCount: opened.lineCount }
            : { status: 'indexing', fileBytes: opened.fileBytes, bytesScanned: 0 }
        )
        // Synchronous drain: no await between learning the id and this, so the
        // listener above cannot interleave a later event ahead of an older one.
        for (const event of buffered.splice(0)) apply(event)
      } catch (err) {
        if (cancelled) return
        log.error('Failed to open large file', err)
        setState({ status: 'error' })
      }
    })()

    return () => {
      cancelled = true
      unsubscribe()
      const openSessionId = sessionIdRef.current
      sessionIdRef.current = null
      // Cleared here rather than at the top of the effect: a session id that
      // outlives its session would have the search hook query a closed one.
      setSessionId(null)
      if (openSessionId) void window.api.notes.largeFileClose(openSessionId)
    }
    // `noteId` is in the deps for correctness, but the viewer keys this hook by
    // it, so in practice only `generation` (a reopen) re-runs the effect.
  }, [noteId, generation])

  /**
   * Fetch the first line of the wanted range that no page covers yet.
   *
   * One request in flight, and a self-call once it lands: where the next page
   * starts is the end of the one before it, which is not known until it has
   * arrived. Walking the range up front — the old `firstPage..lastPage` loop —
   * needs a page size, and there is no longer one.
   */
  const fill = useCallback(function fillPages(): void {
    const sessionId = sessionIdRef.current
    const range = rangeRef.current
    if (!sessionId || !range || inFlightRef.current !== null) return

    const pages = pagesRef.current
    // Pages touched in this pass are the ones on screen, and are never the
    // trim's target however long ago they were fetched.
    const keepTick = tickRef.current + 1
    let cursor = range.start
    while (cursor <= range.end) {
      const page = findPage(pages, cursor)
      if (!page) break
      page.lastUsed = ++tickRef.current
      cursor = page.startLine + page.lines.length
    }
    if (cursor > range.end) return

    const requested = cursor
    inFlightRef.current = requested
    void window.api.notes
      .largeFileReadLines({ sessionId, startLine: requested, count: LARGE_FILE_PAGE_LINES })
      .then((result) => {
        inFlightRef.current = null
        // A different file is open now; this page belongs to nothing.
        if (sessionIdRef.current !== sessionId) return
        if (!result) {
          // The session is gone — evicted behind another file, or the main
          // process restarted. Reopening is cheaper than telling the user.
          setGeneration((n) => n + 1)
          return
        }
        // Past the end of the file. Carrying on would ask for the same line
        // forever, since nothing would ever cover it.
        if (result.lines.length === 0) return

        insertPage(pages, {
          startLine: requested,
          lines: result.lines,
          truncated: new Set(result.truncated),
          chars: result.lines.reduce((total, line) => total + line.length, 0),
          lastUsed: ++tickRef.current
        })
        trimPages(pages, keepTick)
        setPagesRevision((n) => n + 1)
        fillPages()
      })
      .catch((err: unknown) => {
        inFlightRef.current = null
        log.warn('Failed to read large-file lines', err)
      })
  }, [])

  const ensureRange = useCallback(
    (startLine: number, endLine: number) => {
      const start = Math.max(0, startLine)
      rangeRef.current = { start, end: Math.max(start, endLine) }
      fill()
    },
    [fill]
  )

  const getLine = useCallback((line: number): string | undefined => {
    const page = findPage(pagesRef.current, line)
    return page?.lines[line - page.startLine]
  }, [])

  const isTruncated = useCallback((line: number): boolean => {
    return findPage(pagesRef.current, line)?.truncated.has(line) ?? false
  }, [])

  return { state, sessionId, getLine, isTruncated, ensureRange }
}

/** The page covering `line`, or undefined. Binary search over the sorted run. */
function findPage(pages: Page[], line: number): Page | undefined {
  let low = 0
  let high = pages.length - 1
  let found = -1
  while (low <= high) {
    const mid = (low + high) >> 1
    if (pages[mid].startLine <= line) {
      found = mid
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  if (found < 0) return undefined
  const page = pages[found]
  return line < page.startLine + page.lines.length ? page : undefined
}

/**
 * Add a page, keeping the run sorted and non-overlapping.
 *
 * Overlap should not happen — a page is only ever asked for at a line nothing
 * covers — but a run with two pages claiming one line would have `findPage`
 * answer differently depending on where the search landed, and that is not a
 * bug worth being able to have.
 */
function insertPage(pages: Page[], page: Page): void {
  const end = page.startLine + page.lines.length
  for (let i = pages.length - 1; i >= 0; i--) {
    const other = pages[i]
    if (other.startLine < end && page.startLine < other.startLine + other.lines.length) {
      pages.splice(i, 1)
    }
  }
  let at = 0
  while (at < pages.length && pages[at].startLine < page.startLine) at += 1
  pages.splice(at, 0, page)
}

/**
 * Drop the least recently used pages until the cache is inside its byte bound.
 *
 * Without this, scrolling the length of a 2 GB file accumulates every line it
 * passed — the same unbounded string, assembled slowly. Counting pages instead
 * of characters is what let a 69 MB file of 18 KB lines sit in the renderer
 * whole: 20 pages is nothing to a 48-page cache, and is the entire file.
 *
 * Pages touched at or after `keepTick` are on screen and are never taken; if
 * they alone are over the bound the viewport wins and the cache runs over.
 */
function trimPages(pages: Page[], keepTick: number): void {
  let total = 0
  for (const page of pages) total += page.chars

  while (total > PAGE_CACHE_CHARS) {
    let victim = -1
    for (let i = 0; i < pages.length; i++) {
      if (pages[i].lastUsed >= keepTick) continue
      if (victim < 0 || pages[i].lastUsed < pages[victim].lastUsed) victim = i
    }
    if (victim < 0) return
    total -= pages[victim].chars
    pages.splice(victim, 1)
  }
}

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

/** Lines per fetched page. One screenful is ~50 rows; this is a few of those. */
export const LARGE_FILE_PAGE_LINES = 200

/** Pages kept in memory. 48 x 200 lines is a generous scrollback, and bounded. */
const PAGE_CACHE_LIMIT = 48

/** Pages either side of the viewport kept when the cache is trimmed. */
const PAGE_CACHE_MARGIN = 2

export type LargeFileViewState =
  | { status: 'opening' }
  | { status: 'indexing'; fileBytes: number; bytesScanned: number }
  | { status: 'ready'; fileBytes: number; lineCount: number }
  | { status: 'too-large'; fileBytes: number; maxBytes: number }
  | { status: 'missing' }
  // Deliberately message-free: the viewer shows one fixed sentence, and the
  // detail (an errno, a worker fault) belongs in the log, not on screen.
  | { status: 'error' }

interface Page {
  lines: string[]
  truncated: Set<number>
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

  const pagesRef = useRef(new Map<number, Page>())
  const inFlightRef = useRef(new Set<number>())
  const sessionIdRef = useRef<string | null>(null)

  useEffect(() => {
    let cancelled = false
    // Events can arrive before `largeFileOpen` resolves — a small file can be
    // scanned faster than the open round trip completes — and the session id
    // only exists once it does. Hold them rather than drop them.
    const buffered: LargeFileIndexEvent[] = []

    pagesRef.current = new Map()
    inFlightRef.current = new Set()
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

  const ensureRange = useCallback((startLine: number, endLine: number) => {
    const sessionId = sessionIdRef.current
    if (!sessionId) return

    const firstPage = Math.max(0, Math.floor(startLine / LARGE_FILE_PAGE_LINES))
    const lastPage = Math.max(firstPage, Math.floor(endLine / LARGE_FILE_PAGE_LINES))

    for (let page = firstPage; page <= lastPage; page++) {
      if (pagesRef.current.has(page) || inFlightRef.current.has(page)) continue
      inFlightRef.current.add(page)

      const requested = page
      void window.api.notes
        .largeFileReadLines({
          sessionId,
          startLine: requested * LARGE_FILE_PAGE_LINES,
          count: LARGE_FILE_PAGE_LINES
        })
        .then((result) => {
          inFlightRef.current.delete(requested)
          // A different file is open now; this page belongs to nothing.
          if (sessionIdRef.current !== sessionId) return
          if (!result) {
            // The session is gone — evicted behind another file, or the main
            // process restarted. Reopening is cheaper than telling the user.
            setGeneration((n) => n + 1)
            return
          }
          pagesRef.current.set(requested, {
            lines: result.lines,
            truncated: new Set(result.truncated)
          })
          trimPages(pagesRef.current, firstPage, lastPage)
          setPagesRevision((n) => n + 1)
        })
        .catch((err: unknown) => {
          inFlightRef.current.delete(requested)
          log.warn('Failed to read large-file lines', err)
        })
    }
  }, [])

  const getLine = useCallback((line: number): string | undefined => {
    const page = pagesRef.current.get(Math.floor(line / LARGE_FILE_PAGE_LINES))
    return page?.lines[line % LARGE_FILE_PAGE_LINES]
  }, [])

  const isTruncated = useCallback((line: number): boolean => {
    const page = pagesRef.current.get(Math.floor(line / LARGE_FILE_PAGE_LINES))
    return page?.truncated.has(line) ?? false
  }, [])

  return { state, sessionId, getLine, isTruncated, ensureRange }
}

/**
 * Drop pages far from the viewport once the cache is over its limit.
 *
 * Without this, scrolling the length of a 2 GB file accumulates every line it
 * passed — the same unbounded string, assembled slowly.
 */
function trimPages(pages: Map<number, Page>, firstPage: number, lastPage: number): void {
  if (pages.size <= PAGE_CACHE_LIMIT) return
  const keepFrom = firstPage - PAGE_CACHE_MARGIN
  const keepTo = lastPage + PAGE_CACHE_MARGIN
  for (const page of pages.keys()) {
    if (page < keepFrom || page > keepTo) pages.delete(page)
  }
}

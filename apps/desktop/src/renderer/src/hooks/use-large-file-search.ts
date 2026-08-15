/**
 * Find-in-file for the large-file viewer.
 *
 * Large-file-class files never enter FTS, so the global search box cannot see
 * inside them; this is the only search that can. The pass itself runs in the
 * main process on a worker, over the session's already-open handle — nothing
 * here ever holds the file, and nothing here searches the rendered rows, which
 * are a few dozen lines out of millions.
 *
 * The count arrives in two parts: partial counts on an event while the pass is
 * still crossing the file, then a final result. `searching` is what keeps the
 * UI from showing the first as if it were the second.
 */

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { createLogger } from '@/lib/logger'
import type { LargeFileSearchHit } from '@memry/contracts/notes-api'

const log = createLogger('LargeFileSearch')

/**
 * How long the bar waits after the last keystroke before searching.
 *
 * The same 150 ms the note find bar uses, for a sharper reason: one search is a
 * pass over every byte of the file, and the intermediate prefixes — the ones
 * with the most matches — are the expensive ones nobody reads.
 */
const QUERY_DEBOUNCE_MS = 150

/** Matches the contract's cap. The query is carried between read windows. */
const MAX_QUERY_LENGTH = 200

export interface LargeFileSearch {
  isOpen: boolean
  query: string
  /** Positions to navigate. Shorter than `total` when `limited`. */
  hits: LargeFileSearchHit[]
  /** Matches in the file. Still growing while `searching`. */
  total: number
  limited: boolean
  searching: boolean
  currentIndex: number
  currentHit: LargeFileSearchHit | null
  open: () => void
  close: () => void
  setQuery: (query: string) => void
  next: () => void
  prev: () => void
  inputRef: RefObject<HTMLInputElement | null>
}

export function useLargeFileSearch(sessionId: string | null): LargeFileSearch {
  const [isOpen, setIsOpen] = useState(false)
  const [query, setQueryState] = useState('')
  const [hits, setHits] = useState<LargeFileSearchHit[]>([])
  const [total, setTotal] = useState(0)
  const [limited, setLimited] = useState(false)
  const [searching, setSearching] = useState(false)
  const [currentIndex, setCurrentIndex] = useState(0)

  const inputRef = useRef<HTMLInputElement | null>(null)
  const sessionRef = useRef<string | null>(sessionId)
  const queryRef = useRef('')
  const searchingRef = useRef(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingRef = useRef<string | null>(null)
  const focusFrameRef = useRef<number | null>(null)

  useEffect(() => {
    sessionRef.current = sessionId
  }, [sessionId])

  const runSearch = useCallback((next: string) => {
    const session = sessionRef.current
    queryRef.current = next

    if (!session || next.length === 0) {
      searchingRef.current = false
      setSearching(false)
      setHits([])
      setTotal(0)
      setLimited(false)
      setCurrentIndex(0)
      return
    }

    searchingRef.current = true
    setSearching(true)
    setHits([])
    setTotal(0)
    setLimited(false)
    setCurrentIndex(0)

    void window.api.notes
      .largeFileSearch({ sessionId: session, query: next })
      .then((result) => {
        // A newer query, or a different file, owns the bar now.
        if (queryRef.current !== next || sessionRef.current !== session) return
        if (!result) {
          // The session is gone — evicted behind another file, or the main
          // process restarted. The viewer reopens; the next keystroke searches.
          searchingRef.current = false
          setSearching(false)
          return
        }
        // Superseded in the main process: its replacement will answer.
        if (result.status === 'cancelled') return
        setHits(result.hits)
        setTotal(result.total)
        setLimited(result.limited)
        setCurrentIndex(0)
        searchingRef.current = false
        setSearching(false)
      })
      .catch((err: unknown) => {
        log.warn('In-file search failed', err)
        if (queryRef.current !== next) return
        searchingRef.current = false
        setSearching(false)
      })
  }, [])

  const cancelPending = useCallback(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current)
    timerRef.current = null
    pendingRef.current = null
  }, [])

  /** Search now rather than at the end of the debounce. */
  const flushPending = useCallback(() => {
    const pending = pendingRef.current
    if (pending === null) return
    cancelPending()
    runSearch(pending)
  }, [cancelPending, runSearch])

  useEffect(() => {
    const unsubscribe = window.api.onLargeFileSearchProgress((event) => {
      if (!searchingRef.current) return
      if (event.sessionId !== sessionRef.current || event.query !== queryRef.current) return
      setTotal(event.total)
    })
    return unsubscribe
  }, [])

  const setQuery = useCallback(
    (next: string) => {
      const clamped = next.slice(0, MAX_QUERY_LENGTH)
      setQueryState(clamped)
      cancelPending()
      pendingRef.current = clamped
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        pendingRef.current = null
        runSearch(clamped)
      }, QUERY_DEBOUNCE_MS)
    },
    [cancelPending, runSearch]
  )

  const open = useCallback(() => {
    setIsOpen(true)
    if (focusFrameRef.current !== null) cancelAnimationFrame(focusFrameRef.current)
    focusFrameRef.current = requestAnimationFrame(() => {
      focusFrameRef.current = null
      inputRef.current?.focus()
      inputRef.current?.select()
    })
  }, [])

  const close = useCallback(() => {
    setIsOpen(false)
    cancelPending()
    setQueryState('')
    queryRef.current = ''
    searchingRef.current = false
    setSearching(false)
    setHits([])
    setTotal(0)
    setLimited(false)
    setCurrentIndex(0)
  }, [cancelPending])

  const step = useCallback(
    (delta: number) => {
      flushPending()
      setCurrentIndex((index) => {
        if (hits.length === 0) return 0
        return (index + delta + hits.length) % hits.length
      })
    },
    [flushPending, hits.length]
  )

  const next = useCallback(() => step(1), [step])
  const prev = useCallback(() => step(-1), [step])

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current)
      if (focusFrameRef.current !== null) cancelAnimationFrame(focusFrameRef.current)
    }
  }, [])

  return {
    isOpen,
    query,
    hits,
    total,
    limited,
    searching,
    currentIndex,
    currentHit: hits[currentIndex] ?? null,
    open,
    close,
    setQuery,
    next,
    prev,
    inputRef
  }
}

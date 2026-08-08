import {
  useState,
  useEffect,
  useCallback,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  type RefObject
} from 'react'

/**
 * How long the find bar waits after the last keystroke before searching.
 *
 * One search is a `TreeWalker` over the entire note plus one `Range` per match,
 * so running it per character makes every intermediate prefix — the ones with
 * the most matches, e.g. a bare `a` — the expensive ones, and none of them is
 * ever read. 150 ms swallows a typed burst while staying under the ~200 ms
 * where a UI starts to feel unresponsive.
 *
 * Trailing edge only: there is deliberately no leading-edge call, because the
 * first character is the worst case. The final keystroke always searches — the
 * timer is only ever restarted by another keystroke, or cancelled by `close()`
 * / unmount, and `next()` / `prev()` flush it rather than skip it.
 */
const QUERY_DEBOUNCE_MS = 150

interface FindInPageResult {
  isOpen: boolean
  query: string
  matchCount: number
  currentIndex: number
  open: () => void
  close: () => void
  setQuery: (query: string) => void
  next: () => void
  prev: () => void
  inputRef: RefObject<HTMLInputElement | null>
}

function findTextRanges(element: HTMLElement, query: string): Range[] {
  const ranges: Range[] = []
  const lowerQuery = query.toLowerCase()
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)

  let node: Node | null
  while ((node = walker.nextNode())) {
    const text = node.textContent?.toLowerCase() ?? ''
    let startPos = 0
    while (startPos < text.length) {
      const index = text.indexOf(lowerQuery, startPos)
      if (index === -1) break
      try {
        const range = new Range()
        range.setStart(node, index)
        range.setEnd(node, index + query.length)
        ranges.push(range)
      } catch {
        // Node may have been removed between TreeWalker iteration and Range creation
      }
      startPos = index + 1
    }
  }

  return ranges
}

export function useFindInPage(
  containerRef: RefObject<HTMLElement | null>,
  enabled = true
): FindInPageResult {
  const [isOpen, setIsOpen] = useState(false)
  const [query, setQueryState] = useState('')
  const [matchCount, setMatchCount] = useState(0)
  const [currentIndex, setCurrentIndex] = useState(-1)
  const matchesRef = useRef<Range[]>([])
  const inputRef = useRef<HTMLInputElement | null>(null)

  const clearHighlights = useCallback(() => {
    try {
      CSS.highlights.delete('find-matches')
      CSS.highlights.delete('find-current')
    } catch {
      // CSS Highlight API not supported
    }
  }, [])

  const highlightAndScroll = useCallback((index: number) => {
    try {
      CSS.highlights.delete('find-current')
    } catch {
      return
    }
    const matches = matchesRef.current
    if (index >= 0 && index < matches.length) {
      try {
        CSS.highlights.set('find-current', new Highlight(matches[index]))
        const el = matches[index].startContainer.parentElement
        el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      } catch {
        // Range may have been invalidated
      }
    }
  }, [])

  const currentIndexRef = useRef(-1)

  const performSearch = useCallback(
    (searchQuery: string) => {
      clearHighlights()

      if (!searchQuery || !containerRef.current) {
        matchesRef.current = []
        setMatchCount(0)
        setCurrentIndex(-1)
        currentIndexRef.current = -1
        return
      }

      const ranges = findTextRanges(containerRef.current, searchQuery)
      matchesRef.current = ranges
      setMatchCount(ranges.length)

      if (ranges.length > 0) {
        try {
          CSS.highlights.set('find-matches', new Highlight(...ranges))
        } catch {
          // CSS Highlight API not supported
        }
        setCurrentIndex(0)
        currentIndexRef.current = 0
        highlightAndScroll(0)
      } else {
        setCurrentIndex(-1)
        currentIndexRef.current = -1
      }
    },
    [containerRef, clearHighlights, highlightAndScroll]
  )

  // Pending debounced search. `pendingQueryRef` is the query the timer will run,
  // and is null exactly when no timer is armed. Nothing about the DOM is cached:
  // a flushed search walks the note from scratch, so an edit that lands inside
  // the debounce window can never feed stale ranges into the highlight.
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingQueryRef = useRef<string | null>(null)

  const cancelPendingSearch = useCallback(() => {
    if (searchTimeoutRef.current !== null) clearTimeout(searchTimeoutRef.current)
    searchTimeoutRef.current = null
    pendingQueryRef.current = null
  }, [])

  const flushPendingSearch = useCallback(() => {
    const pending = pendingQueryRef.current
    if (pending === null) return
    cancelPendingSearch()
    performSearch(pending)
  }, [cancelPendingSearch, performSearch])

  // Highlight current match + scroll into view on navigation (next/prev)
  useEffect(() => {
    highlightAndScroll(currentIndex)
  }, [currentIndex, highlightAndScroll])

  const rerunSearch = useEffectEvent(() => {
    performSearch(query)
  })

  // Re-search when editor DOM mutates while find bar is open
  useLayoutEffect(() => {
    const container = containerRef.current
    if (!isOpen || !query || !container) return

    let timeoutId: ReturnType<typeof setTimeout>
    const observer = new MutationObserver(() => {
      clearTimeout(timeoutId)
      timeoutId = setTimeout(() => rerunSearch(), 300)
    })

    observer.observe(container, {
      childList: true,
      subtree: true,
      characterData: true
    })

    return () => {
      clearTimeout(timeoutId)
      observer.disconnect()
    }
  }, [isOpen, query, containerRef])

  const open = useCallback(() => {
    setIsOpen(true)
    if (query) {
      performSearch(query)
    }
    requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
  }, [performSearch, query])

  const close = useCallback(() => {
    setIsOpen(false)
    cancelPendingSearch()
    setQueryState('')
    clearHighlights()
    matchesRef.current = []
    setMatchCount(0)
    setCurrentIndex(-1)
    currentIndexRef.current = -1
  }, [cancelPendingSearch, clearHighlights])

  const setQuery = useCallback(
    (q: string) => {
      setQueryState(q)
      if (!isOpen) return
      cancelPendingSearch()
      pendingQueryRef.current = q
      searchTimeoutRef.current = setTimeout(() => {
        searchTimeoutRef.current = null
        pendingQueryRef.current = null
        performSearch(q)
      }, QUERY_DEBOUNCE_MS)
    },
    [isOpen, performSearch, cancelPendingSearch]
  )

  const next = useCallback(() => {
    flushPendingSearch()
    const len = matchesRef.current.length
    if (len === 0) return
    const newIndex = (currentIndexRef.current + 1) % len
    currentIndexRef.current = newIndex
    setCurrentIndex(newIndex)
    highlightAndScroll(newIndex)
  }, [flushPendingSearch, highlightAndScroll])

  const prev = useCallback(() => {
    flushPendingSearch()
    const len = matchesRef.current.length
    if (len === 0) return
    const newIndex = (currentIndexRef.current - 1 + len) % len
    currentIndexRef.current = newIndex
    setCurrentIndex(newIndex)
    highlightAndScroll(newIndex)
  }, [flushPendingSearch, highlightAndScroll])

  // Cmd+F / Ctrl+F shortcut
  useEffect(() => {
    if (!enabled) return

    const handler = (e: KeyboardEvent) => {
      const isMac = navigator.platform.toUpperCase().includes('MAC')
      const modifier = isMac ? e.metaKey : e.ctrlKey
      if (modifier && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        e.stopPropagation()
        if (isOpen) {
          inputRef.current?.focus()
          inputRef.current?.select()
        } else {
          open()
        }
      }
    }

    window.addEventListener('keydown', handler, { capture: true })
    return () => window.removeEventListener('keydown', handler, { capture: true })
  }, [enabled, isOpen, open])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cancelPendingSearch()
      clearHighlights()
    }
  }, [cancelPendingSearch, clearHighlights])

  return {
    isOpen,
    query,
    matchCount,
    currentIndex,
    open,
    close,
    setQuery,
    next,
    prev,
    inputRef
  }
}

import {
  useState,
  useEffect,
  useCallback,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  type RefObject
} from 'react'

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
    setQueryState('')
    clearHighlights()
    matchesRef.current = []
    setMatchCount(0)
    setCurrentIndex(-1)
    currentIndexRef.current = -1
  }, [clearHighlights])

  const setQuery = useCallback(
    (q: string) => {
      setQueryState(q)
      if (isOpen) {
        performSearch(q)
      }
    },
    [isOpen, performSearch]
  )

  const next = useCallback(() => {
    const len = matchesRef.current.length
    if (len === 0) return
    const newIndex = (currentIndexRef.current + 1) % len
    currentIndexRef.current = newIndex
    setCurrentIndex(newIndex)
    highlightAndScroll(newIndex)
  }, [highlightAndScroll])

  const prev = useCallback(() => {
    const len = matchesRef.current.length
    if (len === 0) return
    const newIndex = (currentIndexRef.current - 1 + len) % len
    currentIndexRef.current = newIndex
    setCurrentIndex(newIndex)
    highlightAndScroll(newIndex)
  }, [highlightAndScroll])

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
    return () => clearHighlights()
  }, [clearHighlights])

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

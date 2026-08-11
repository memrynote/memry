import { act, renderHook, type RenderHookResult } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useFindInPage } from './use-find-in-page'

/**
 * Counters for the DOM work one search costs. `findTextRanges` walks the whole
 * container with a `TreeWalker` and allocates one `Range` per match, so these
 * three numbers are the entire per-search cost and they are what the debounce
 * has to hold down while the user is typing.
 */
let treeWalks = 0
let textNodesVisited = 0
let rangesAllocated = 0

/** Captured once: re-reading `globalThis.Range` per test would nest the counter. */
const NativeRange = globalThis.Range

/** Typing burst: how long a fast typist leaves between two characters. */
const KEYSTROKE_GAP_MS = 30
/** The longest a user should wait after the last keystroke before results land. */
const RESULTS_DEADLINE_MS = 200

type Hook = RenderHookResult<ReturnType<typeof useFindInPage>, unknown>

/** `node.textContent[start-end]` for every highlighted range, in document order. */
function describeRanges(value: unknown): string[] {
  const ranges = (value as { ranges?: Range[] } | undefined)?.ranges ?? []
  return ranges.map((r) => `${r.startContainer.textContent}[${r.startOffset}-${r.endOffset}]`)
}

describe('useFindInPage', () => {
  let container: HTMLDivElement
  let ref: { current: HTMLElement | null }
  let highlights: Map<string, unknown>

  beforeEach(() => {
    vi.useFakeTimers()
    container = document.createElement('div')
    container.innerHTML = '<p>Alpha beta alpha</p><p>Beta</p>'
    document.body.append(container)
    ref = { current: container }
    highlights = new Map()

    treeWalks = 0
    textNodesVisited = 0
    rangesAllocated = 0

    const createTreeWalker = document.createTreeWalker.bind(document)
    vi.spyOn(document, 'createTreeWalker').mockImplementation((root, whatToShow, filter) => {
      treeWalks += 1
      const walker = createTreeWalker(root, whatToShow, filter)
      const nextNode = walker.nextNode.bind(walker)
      walker.nextNode = () => {
        const node = nextNode()
        if (node) textNodesVisited += 1
        return node
      }
      return walker
    })

    Object.defineProperty(globalThis, 'Range', {
      configurable: true,
      writable: true,
      value: class CountingRange extends NativeRange {
        constructor() {
          super()
          rangesAllocated += 1
        }
      }
    })

    Object.defineProperty(globalThis, 'CSS', {
      configurable: true,
      value: {
        highlights: {
          set: vi.fn((key: string, value: unknown) => highlights.set(key, value)),
          delete: vi.fn((key: string) => highlights.delete(key))
        }
      }
    })
    Object.defineProperty(globalThis, 'Highlight', {
      configurable: true,
      value: vi.fn(function MockHighlight(...ranges: Range[]) {
        return { ranges }
      })
    })
    Element.prototype.scrollIntoView = vi.fn()
    window.requestAnimationFrame = (callback: FrameRequestCallback) => {
      callback(0)
      return 0
    }
  })

  afterEach(() => {
    document.body.innerHTML = ''
    Object.defineProperty(globalThis, 'Range', {
      configurable: true,
      writable: true,
      value: NativeRange
    })
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  /** Type a query and wait long enough that the user would expect results. */
  function typeQuery(hook: Hook, query: string): void {
    act(() => {
      hook.result.current.setQuery(query)
      vi.advanceTimersByTime(RESULTS_DEADLINE_MS)
    })
  }

  it('opens, searches text ranges, navigates matches, and closes cleanly', () => {
    const hook = renderHook(() => useFindInPage(ref))
    const { result, unmount } = hook
    const input = document.createElement('input')
    result.current.inputRef.current = input
    vi.spyOn(input, 'focus')
    vi.spyOn(input, 'select')

    act(() => result.current.open())
    expect(result.current.isOpen).toBe(true)
    expect(input.focus).toHaveBeenCalled()
    expect(input.select).toHaveBeenCalled()

    typeQuery(hook, 'alpha')
    expect(result.current.query).toBe('alpha')
    expect(result.current.matchCount).toBe(2)
    expect(result.current.currentIndex).toBe(0)
    expect(CSS.highlights.set).toHaveBeenCalledWith('find-matches', expect.anything())

    act(() => result.current.next())
    expect(result.current.currentIndex).toBe(1)
    act(() => result.current.next())
    expect(result.current.currentIndex).toBe(0)
    act(() => result.current.prev())
    expect(result.current.currentIndex).toBe(1)

    typeQuery(hook, 'missing')
    expect(result.current.matchCount).toBe(0)
    expect(result.current.currentIndex).toBe(-1)

    act(() => result.current.close())
    expect(result.current.isOpen).toBe(false)
    expect(result.current.query).toBe('')
    expect(result.current.matchCount).toBe(0)

    unmount()
    expect(CSS.highlights.delete).toHaveBeenCalledWith('find-matches')
  })

  it('handles keyboard shortcut, disabled mode, DOM mutations, and missing containers', async () => {
    Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' })
    const hook = renderHook(({ enabled }) => useFindInPage(ref, enabled), {
      initialProps: { enabled: true }
    })
    const { result, rerender } = hook

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true }))
    })
    expect(result.current.isOpen).toBe(true)

    typeQuery(hook, 'beta')
    expect(result.current.matchCount).toBe(2)

    await act(async () => {
      container.append(document.createTextNode(' beta'))
      await Promise.resolve()
      vi.advanceTimersByTime(300)
    })
    expect(result.current.matchCount).toBe(3)

    act(() => result.current.close())
    rerender({ enabled: false })
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true }))
    })
    expect(result.current.isOpen).toBe(false)

    ref.current = null
    rerender({ enabled: true })
    act(() => {
      result.current.open()
      result.current.setQuery('alpha')
      vi.advanceTimersByTime(RESULTS_DEADLINE_MS)
    })
    expect(result.current.matchCount).toBe(0)
  })

  describe('query debounce', () => {
    it('costs one whole-container walk for a typed burst, not one per keystroke', () => {
      // 200 paragraphs, each `alpha beta gamma alpha`: 200 text nodes, and 'a'
      // alone matches 7 times per paragraph.
      container.innerHTML = '<p>alpha beta gamma alpha</p>'.repeat(200)

      const hook = renderHook(() => useFindInPage(ref))
      act(() => hook.result.current.open())

      const prefixes = ['a', 'al', 'alp', 'alph', 'alpha']
      for (const prefix of prefixes) {
        act(() => {
          hook.result.current.setQuery(prefix)
          vi.advanceTimersByTime(KEYSTROKE_GAP_MS)
        })
      }

      // Mid-burst: every intermediate prefix was skipped entirely.
      expect(treeWalks).toBe(0)
      expect(textNodesVisited).toBe(0)
      expect(rangesAllocated).toBe(0)
      expect(hook.result.current.query).toBe('alpha')

      // Trailing edge: the last keystroke always lands, and within the deadline.
      act(() => vi.advanceTimersByTime(RESULTS_DEADLINE_MS - KEYSTROKE_GAP_MS))

      expect(treeWalks).toBe(1)
      expect(textNodesVisited).toBe(200)
      expect(rangesAllocated).toBe(400)
      expect(hook.result.current.matchCount).toBe(400)
      expect(hook.result.current.currentIndex).toBe(0)
      expect(describeRanges(highlights.get('find-matches'))).toHaveLength(400)
    })

    it('pins the exact match set produced by the trailing keystroke', () => {
      const hook = renderHook(() => useFindInPage(ref))
      act(() => hook.result.current.open())

      act(() => {
        hook.result.current.setQuery('alph')
        vi.advanceTimersByTime(KEYSTROKE_GAP_MS)
        hook.result.current.setQuery('alpha')
        vi.advanceTimersByTime(KEYSTROKE_GAP_MS)
      })
      expect(treeWalks).toBe(0)
      expect(hook.result.current.matchCount).toBe(0)

      act(() => vi.advanceTimersByTime(RESULTS_DEADLINE_MS - KEYSTROKE_GAP_MS))

      expect(treeWalks).toBe(1)
      expect(hook.result.current.matchCount).toBe(2)
      expect(describeRanges(highlights.get('find-matches'))).toEqual([
        'Alpha beta alpha[0-5]',
        'Alpha beta alpha[11-16]'
      ])
      expect(describeRanges(highlights.get('find-current'))).toEqual(['Alpha beta alpha[0-5]'])
    })

    it('cancels the pending search when the bar is closed', () => {
      const hook = renderHook(() => useFindInPage(ref))
      act(() => hook.result.current.open())

      act(() => {
        hook.result.current.setQuery('alpha')
        vi.advanceTimersByTime(KEYSTROKE_GAP_MS)
      })
      act(() => hook.result.current.close())
      act(() => vi.advanceTimersByTime(5000))

      expect(treeWalks).toBe(0)
      expect(hook.result.current.matchCount).toBe(0)
      expect(hook.result.current.query).toBe('')
      expect(highlights.has('find-matches')).toBe(false)

      // Reopening starts clean rather than resurrecting the cancelled search.
      act(() => hook.result.current.open())
      act(() => vi.advanceTimersByTime(5000))
      expect(treeWalks).toBe(0)
      expect(hook.result.current.matchCount).toBe(0)
    })

    it('flushes the pending search before next/prev so navigation uses the current query', () => {
      container.innerHTML = '<p>one two two three three three</p>'
      const hook = renderHook(() => useFindInPage(ref))
      act(() => hook.result.current.open())

      typeQuery(hook, 'two')
      expect(hook.result.current.matchCount).toBe(2)
      expect(treeWalks).toBe(1)

      // Enter pressed inside the debounce window: the stale 'two' match set must
      // not be what gets navigated.
      act(() => {
        hook.result.current.setQuery('three')
        vi.advanceTimersByTime(KEYSTROKE_GAP_MS)
      })
      act(() => hook.result.current.next())

      expect(treeWalks).toBe(2)
      expect(hook.result.current.matchCount).toBe(3)
      expect(hook.result.current.currentIndex).toBe(1)
      expect(describeRanges(highlights.get('find-current'))).toEqual([
        'one two two three three three[18-23]'
      ])

      // The flush consumed the pending search; the timer must not fire again.
      act(() => vi.advanceTimersByTime(5000))
      expect(treeWalks).toBe(2)

      act(() => hook.result.current.prev())
      expect(hook.result.current.currentIndex).toBe(0)
      expect(describeRanges(highlights.get('find-current'))).toEqual([
        'one two two three three three[12-17]'
      ])

      // Same again but with Shift+Enter as the first navigation after a change:
      // prev() must flush too, or it walks backwards through the 'three' set.
      act(() => {
        hook.result.current.setQuery('two')
        vi.advanceTimersByTime(KEYSTROKE_GAP_MS)
      })
      act(() => hook.result.current.prev())

      expect(treeWalks).toBe(3)
      expect(hook.result.current.matchCount).toBe(2)
      expect(hook.result.current.currentIndex).toBe(1)
      expect(describeRanges(highlights.get('find-current'))).toEqual([
        'one two two three three three[8-11]'
      ])
    })

    it('re-runs the search when the note is edited or swapped under an open bar', async () => {
      const hook = renderHook(() => useFindInPage(ref))
      act(() => hook.result.current.open())
      typeQuery(hook, 'alpha')
      expect(hook.result.current.matchCount).toBe(2)

      // Edit while the bar is open.
      await act(async () => {
        container.querySelector('p')?.append(document.createTextNode(' alpha'))
        await Promise.resolve()
        vi.advanceTimersByTime(300)
      })
      expect(hook.result.current.matchCount).toBe(3)
      expect(describeRanges(highlights.get('find-matches'))).toEqual([
        'Alpha beta alpha[0-5]',
        'Alpha beta alpha[11-16]',
        ' alpha[1-6]'
      ])

      // Note switched under the open bar: the container's content is replaced.
      await act(async () => {
        container.innerHTML = '<p>alpha</p>'
        await Promise.resolve()
        vi.advanceTimersByTime(300)
      })
      expect(hook.result.current.matchCount).toBe(1)
      expect(describeRanges(highlights.get('find-matches'))).toEqual(['alpha[0-5]'])
    })

    it('cancels the pending search on unmount', () => {
      const hook = renderHook(() => useFindInPage(ref))
      act(() => hook.result.current.open())
      act(() => {
        hook.result.current.setQuery('alpha')
        vi.advanceTimersByTime(KEYSTROKE_GAP_MS)
      })

      hook.unmount()
      act(() => vi.advanceTimersByTime(5000))

      expect(treeWalks).toBe(0)
    })
  })
})

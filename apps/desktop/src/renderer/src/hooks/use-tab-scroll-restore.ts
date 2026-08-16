/**
 * Tab scroll restore
 *
 * Saves and restores a tab's scroll offset against the element the page actually
 * scrolls, which is never the tab wrapper: every page renders an `h-full`
 * `overflow-hidden` root and owns an inner scroller.
 *
 * Three rules the previous mechanism broke, and this one must not:
 *
 * 1. NEVER read the scroll offset from the DOM at teardown. Only the active tab
 *    is rendered, and `TabContent` reuses its page instance across a tab switch,
 *    so a passive-effect cleanup runs AFTER the new DOM is committed — by then
 *    `scrollTop` has already been clamped to 0. The live offset is mirrored into
 *    a ref by the scroll listener and the ref is what gets persisted.
 * 2. `0` is a valid offset. Restore must not be guarded on truthiness.
 * 3. Not every scroll event is the user scrolling. When a page's content
 *    remounts, the scroller can survive while its content height collapses; the
 *    browser then clamps `scrollTop` and fires a scroll event carrying the
 *    clamped value. Recording that value poisons the ref before teardown even
 *    runs, which is rule 1's bug travelling through the ref instead of the DOM.
 */

import { useEffect, useLayoutEffect, useRef } from 'react'
import { useTabActionsOptional } from '@/contexts/tabs'
import { useTabIdentity } from '@/contexts/tabs/tab-identity'

/** How often the live offset is committed to tab state while scrolling. */
const SAVE_THROTTLE_MS = 500
/**
 * How long re-application waits for the content to grow again before concluding
 * it has settled. A range that stopped growing short of the target means the
 * target is unreachable, which is a better exit than a wall-clock deadline: a
 * large note's lazy chunk, note fetch and editor mount routinely take seconds.
 */
const RESTORE_SETTLE_MS = 2000
/** Hard upper bound on re-application, so the observer can never leak. */
const RESTORE_MAX_MS = 15000
/** Sub-pixel tolerance when deciding whether a target offset was reached. */
const OFFSET_EPSILON = 1
/**
 * Keys that scroll. Anything else is typing — cancelling a pending restore on
 * every keypress would abort it the moment the user starts editing the note
 * they just came back to.
 */
const SCROLL_KEYS = new Set([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'PageUp',
  'PageDown',
  'Home',
  'End',
  ' '
])

/** How far the element can scroll right now. `0` while content is still empty. */
function scrollRangeOf(element: HTMLElement): number {
  return Math.max(0, element.scrollHeight - element.clientHeight)
}

/**
 * The slice of `@tanstack/react-virtual`'s `Virtualizer` this hook needs.
 * Structural rather than imported so the hook stays free of the virtual
 * library's generics (and so tests can drive it with a stub).
 */
export interface TabScrollVirtualizer {
  /** Current total scrollable height. An ESTIMATE until every row measures. */
  getTotalSize: () => number
  scrollToOffset: (offset: number, options?: { align?: 'start'; behavior?: 'auto' }) => void
}

export interface UseTabScrollRestoreOptions {
  /**
   * Returns the scrolling element. A getter rather than a ref so callers can
   * resolve a Radix ScrollArea viewport (`[data-radix-scroll-area-viewport]`)
   * or any other element they do not hold a ref to directly.
   */
  getScrollElement: () => HTMLElement | null
  /** Set false to leave scrolling alone entirely (default true). */
  enabled?: boolean
  /**
   * Extra identity discriminator. Changing it flushes the current offset and
   * re-runs restore, exactly like a tab or entity change does. It is also
   * stamped into the saved record, so a page with several scrollers never
   * restores one pane's offset into another.
   */
  key?: string
  /**
   * Pass the list's virtualizer when the scroller is virtualized. Raw
   * `scrollTop` is wrong there: the total height is an estimate until the rows
   * measure, so an early write lands on the wrong row and the content then
   * shifts under the user. With a virtualizer the offset is applied through its
   * own API and re-applied until the total size stops moving.
   */
  virtualizer?: TabScrollVirtualizer | null
}

export function useTabScrollRestore({
  getScrollElement,
  enabled = true,
  key,
  virtualizer
}: UseTabScrollRestoreOptions): void {
  const identity = useTabIdentity()
  // Optional: `NoteLayout` and friends also render outside a tab (previews,
  // standalone tests), where there is no tab state to save into.
  const actions = useTabActionsOptional()
  const dispatch = actions?.dispatch
  const getTab = actions?.getTab

  /** Live scroll offset. The single source of truth for every save. */
  const offsetRef = useRef(0)
  const getScrollElementRef = useRef(getScrollElement)
  const virtualizerRef = useRef(virtualizer)

  // Layout effects all run before any passive effect in the same commit, so the
  // main effect below always sees the current render's getter.
  useLayoutEffect(() => {
    getScrollElementRef.current = getScrollElement
  }, [getScrollElement])

  // Kept out of the effect's deps: a virtualizer is a stable instance whose
  // internals mutate, and re-running the effect for it would restart restore.
  useLayoutEffect(() => {
    virtualizerRef.current = virtualizer
  }, [virtualizer])

  const tabId = identity?.tabId
  const groupId = identity?.groupId
  const entityId = identity?.entityId

  useEffect(() => {
    if (!enabled || !tabId || !groupId || !dispatch || !getTab) return undefined

    const element = getScrollElementRef.current()
    if (!element) return undefined

    let saveTimer: ReturnType<typeof setTimeout> | null = null
    let pendingSave = false
    /** The offset our own programmatic write actually produced. */
    let lastWrittenOffset: number | null = null
    /** The scrollable range as of the last scroll event we looked at. */
    let lastRange = scrollRangeOf(element)
    /** The offset the last dispatch actually put into tab state. */
    let lastDispatchedOffset: number | null = null
    /**
     * Total size reported by the virtualizer at the previous apply. `NaN` never
     * equals itself, so the first apply can never claim the list has measured.
     */
    let lastTotalSize = Number.NaN
    /** Whether anything happened that is worth persisting at teardown. */
    let touched = false
    let restoring = false
    let restoreObserver: ResizeObserver | null = null
    let restoreDeadline: ReturnType<typeof setTimeout> | null = null
    let restoreSettle: ReturnType<typeof setTimeout> | null = null

    const commit = (): void => {
      saveTimer = null
      if (!pendingSave) return
      pendingSave = false
      const offset = offsetRef.current
      // Every dispatch mints a new tab-system state object and re-renders the
      // tab bar plus every `useTabGroup` consumer. A throttled save that would
      // write the value already in state is pure churn.
      if (offset === lastDispatchedOffset) return
      lastDispatchedOffset = offset
      dispatch({
        type: 'SAVE_TAB_STATE',
        payload: { tabId, groupId, scrollState: { offset, entityId, key } }
      })
    }

    const scheduleSave = (): void => {
      pendingSave = true
      if (saveTimer === null) saveTimer = setTimeout(commit, SAVE_THROTTLE_MS)
    }

    const stopRestoring = (): void => {
      restoring = false
      restoreObserver?.disconnect()
      restoreObserver = null
      if (restoreDeadline !== null) {
        clearTimeout(restoreDeadline)
        restoreDeadline = null
      }
      if (restoreSettle !== null) {
        clearTimeout(restoreSettle)
        restoreSettle = null
      }
    }

    /**
     * Writes `target` and reports whether it stuck. The browser clamps the write
     * to the currently available scroll range, so the value read back is the
     * only truth about whether the content is tall enough yet. The ref keeps the
     * target rather than the clamp: a partial write is our failure to restore,
     * not the user choosing a new position, and tearing down mid-restore must
     * persist what they asked for.
     */
    const applyOffset = (target: number): boolean => {
      const scroller = getScrollElementRef.current()
      if (!scroller) return false
      const virtual = virtualizerRef.current

      if (virtual) {
        // The total size before the write is what the offset was interpreted
        // against. If it moved since the last attempt, rows are still measuring
        // and the row now under the offset is not the row the user left.
        const totalSize = virtual.getTotalSize()
        const measured = totalSize === lastTotalSize
        lastTotalSize = totalSize
        virtual.scrollToOffset(target, { align: 'start' })
        lastWrittenOffset = scroller.scrollTop
        return measured && Math.abs(lastWrittenOffset - target) <= OFFSET_EPSILON
      }

      scroller.scrollTop = target
      lastWrittenOffset = scroller.scrollTop
      return Math.abs(lastWrittenOffset - target) <= OFFSET_EPSILON
    }

    const handleScroll = (): void => {
      const scroller = getScrollElementRef.current()
      if (!scroller) return
      const next = scroller.scrollTop
      const range = scrollRangeOf(scroller)
      const previousRange = lastRange
      lastRange = range

      // The echo of our own restore write. Scroll events are delivered
      // asynchronously, so one can still land after re-application stopped.
      if (next === lastWrittenOffset) return

      // A shrinking scrollable range that has fallen to the incoming offset is
      // the browser clamping `scrollTop` because the content collapsed — a page
      // body remounting under a surviving scroller, a Suspense swap — not the
      // user scrolling. The stored offset has to survive that untouched. A real
      // scroll (including one to the very top) happens while the range is stable
      // or growing, or lands short of the range's new ceiling.
      if (previousRange > range && next >= range - OFFSET_EPSILON && next < offsetRef.current) {
        return
      }

      // Anything else came from the user (scrollbar drag, momentum, keyboard) —
      // stop chasing the target or we would undo their scroll.
      lastWrittenOffset = null
      if (restoring) stopRestoring()
      offsetRef.current = next
      touched = true
      scheduleSave()
    }

    // Intent events fire before the scroll they cause, so cancelling here beats
    // waiting for the resulting scroll event.
    const handleUserIntent = (): void => {
      if (restoring) stopRestoring()
    }

    const handleKeyDown = (event: Event): void => {
      if (!SCROLL_KEYS.has((event as KeyboardEvent).key)) return
      handleUserIntent()
    }

    element.addEventListener('scroll', handleScroll, { passive: true })
    element.addEventListener('wheel', handleUserIntent, { passive: true })
    element.addEventListener('touchmove', handleUserIntent, { passive: true })
    element.addEventListener('keydown', handleKeyDown, { passive: true })

    const saved = getTab(tabId, groupId)?.scrollState
    // A tab keeps its identity when it navigates to another note, so an offset
    // stamped with a different entity describes content that is gone — and one
    // stamped with a different scroller describes a different pane of this page.
    const restorable =
      saved !== undefined &&
      saved.entityId === entityId &&
      saved.key === key &&
      Number.isFinite(saved.offset)

    if (restorable) {
      const target = saved.offset
      offsetRef.current = target
      // Tab state already holds exactly this record, so a save that reproduces
      // it is a no-op re-render.
      lastDispatchedOffset = target
      restoring = true

      /** Largest scrollable range seen since re-application began. */
      let grownTo = -1

      const tryApply = (): void => {
        if (!restoring) return
        const scroller = getScrollElementRef.current()
        if (!scroller) return
        const range = scrollRangeOf(scroller)
        const virtual = virtualizerRef.current
        // Content is still arriving, so the target is not yet unreachable: give
        // it another settle window. A virtualized list's total size can SHRINK
        // as rows measure under their estimate, so there any movement counts.
        const stillArriving = virtual ? virtual.getTotalSize() !== lastTotalSize : range > grownTo
        if (range > grownTo) grownTo = range
        if (stillArriving) {
          if (restoreSettle !== null) clearTimeout(restoreSettle)
          restoreSettle = setTimeout(stopRestoring, RESTORE_SETTLE_MS)
        }
        if (applyOffset(target)) stopRestoring()
      }

      tryApply()

      if (restoring) {
        // Content arrives async (lazy chunk, note fetch, editor mount): the
        // container has almost no height on the first pass, so keep re-applying
        // as it grows. Observing the child too — the scroller itself is `h-full`
        // and never resizes when its content does.
        restoreObserver = new ResizeObserver(tryApply)
        restoreObserver.observe(element)
        if (element.firstElementChild) restoreObserver.observe(element.firstElementChild)
        restoreDeadline = setTimeout(stopRestoring, RESTORE_MAX_MS)
      }
    }

    return () => {
      stopRestoring()
      element.removeEventListener('scroll', handleScroll)
      element.removeEventListener('wheel', handleUserIntent)
      element.removeEventListener('touchmove', handleUserIntent)
      element.removeEventListener('keydown', handleKeyDown)
      if (saveTimer !== null) clearTimeout(saveTimer)

      // Final save under THIS effect's identity, read from the ref. Reading the
      // DOM here is exactly the bug this hook replaces. A tab that was never
      // scrolled and has no record to correct has nothing to persist — writing
      // `{ offset: 0 }` for every tab the user merely opens is churn in state
      // that gets serialised to disk. A record belonging to a DIFFERENT scroller
      // is not ours to correct either: merely opening the insights pane must not
      // wipe the list pane's offset.
      if (touched || (saved !== undefined && saved.key === key)) {
        dispatch({
          type: 'SAVE_TAB_STATE',
          payload: { tabId, groupId, scrollState: { offset: offsetRef.current, entityId, key } }
        })
      }
      offsetRef.current = 0
    }
  }, [enabled, tabId, groupId, entityId, key, dispatch, getTab])
}

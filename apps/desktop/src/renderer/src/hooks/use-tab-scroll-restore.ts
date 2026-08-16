/**
 * Tab scroll restore
 *
 * Saves and restores a tab's scroll offset against the element the page actually
 * scrolls, which is never the tab wrapper: every page renders an `h-full`
 * `overflow-hidden` root and owns an inner scroller.
 *
 * Two rules the previous mechanism broke, and this one must not:
 *
 * 1. NEVER read the scroll offset from the DOM at teardown. Only the active tab
 *    is rendered, and `TabContent` reuses its page instance across a tab switch,
 *    so a passive-effect cleanup runs AFTER the new DOM is committed — by then
 *    `scrollTop` has already been clamped to 0. The live offset is mirrored into
 *    a ref by the scroll listener and the ref is what gets persisted.
 * 2. `0` is a valid offset. Restore must not be guarded on truthiness.
 */

import { useEffect, useLayoutEffect, useRef } from 'react'
import { useTabActionsOptional } from '@/contexts/tabs'
import { useTabIdentity } from '@/contexts/tabs/tab-identity'

/** How often the live offset is committed to tab state while scrolling. */
const SAVE_THROTTLE_MS = 500
/** How long re-application keeps chasing content that is still loading. */
const RESTORE_TIMEOUT_MS = 1000
/** Sub-pixel tolerance when deciding whether a target offset was reached. */
const OFFSET_EPSILON = 1

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
   * re-runs restore, exactly like a tab or entity change does.
   */
  key?: string
}

export function useTabScrollRestore({
  getScrollElement,
  enabled = true,
  key
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

  // Layout effects all run before any passive effect in the same commit, so the
  // main effect below always sees the current render's getter.
  useLayoutEffect(() => {
    getScrollElementRef.current = getScrollElement
  }, [getScrollElement])

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
    let restoring = false
    let restoreObserver: ResizeObserver | null = null
    let restoreDeadline: ReturnType<typeof setTimeout> | null = null

    const commit = (): void => {
      saveTimer = null
      if (!pendingSave) return
      pendingSave = false
      dispatch({
        type: 'SAVE_TAB_STATE',
        payload: { tabId, groupId, scrollState: { offset: offsetRef.current, entityId } }
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
    }

    /**
     * Writes `target` and reports whether it stuck. The browser clamps the write
     * to the currently available scroll range, so the value read back is the
     * only truth about whether the content is tall enough yet.
     */
    const applyOffset = (target: number): boolean => {
      const scroller = getScrollElementRef.current()
      if (!scroller) return false
      scroller.scrollTop = target
      lastWrittenOffset = scroller.scrollTop
      offsetRef.current = lastWrittenOffset
      return Math.abs(lastWrittenOffset - target) <= OFFSET_EPSILON
    }

    const handleScroll = (): void => {
      const scroller = getScrollElementRef.current()
      if (!scroller) return
      const next = scroller.scrollTop
      // Anything that is not the value our own write produced came from the
      // user (scrollbar drag, momentum, keyboard) — stop chasing the target or
      // we would undo their scroll.
      if (restoring && next !== lastWrittenOffset) stopRestoring()
      offsetRef.current = next
      scheduleSave()
    }

    // Intent events fire before the scroll they cause, so cancelling here beats
    // waiting for the resulting scroll event.
    const handleUserIntent = (): void => {
      if (restoring) stopRestoring()
    }

    element.addEventListener('scroll', handleScroll, { passive: true })
    element.addEventListener('wheel', handleUserIntent, { passive: true })
    element.addEventListener('touchmove', handleUserIntent, { passive: true })
    element.addEventListener('keydown', handleUserIntent)

    const saved = getTab(tabId, groupId)?.scrollState
    // A tab keeps its identity when it navigates to another note, so an offset
    // stamped with a different entity describes content that is gone.
    const restorable =
      saved !== undefined && saved.entityId === entityId && Number.isFinite(saved.offset)

    if (restorable) {
      const target = saved.offset
      offsetRef.current = target
      restoring = true

      const tryApply = (): void => {
        if (!restoring) return
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
        restoreDeadline = setTimeout(stopRestoring, RESTORE_TIMEOUT_MS)
      }
    }

    return () => {
      stopRestoring()
      element.removeEventListener('scroll', handleScroll)
      element.removeEventListener('wheel', handleUserIntent)
      element.removeEventListener('touchmove', handleUserIntent)
      element.removeEventListener('keydown', handleUserIntent)
      if (saveTimer !== null) clearTimeout(saveTimer)

      // Final save under THIS effect's identity, read from the ref. Reading the
      // DOM here is exactly the bug this hook replaces.
      dispatch({
        type: 'SAVE_TAB_STATE',
        payload: { tabId, groupId, scrollState: { offset: offsetRef.current, entityId } }
      })
      offsetRef.current = 0
    }
  }, [enabled, tabId, groupId, entityId, key, dispatch, getTab])
}

/**
 * Presentational overlay that recolors inline date pills whose reminder has
 * fired. Fired state is per-device (derived from the reminders DB) and is never
 * written into pill props or note markdown.
 */

import { useEffect, useMemo, useRef } from 'react'
import type { RefObject } from 'react'
import { useRemindersForTarget } from '@/hooks/use-reminders'

/** Reminder fields needed to decide fired state. */
interface FiredCandidate {
  anchorId: string | null
  triggeredAt: string | null
}

/**
 * Anchor ids of note_date reminders that have fired at least once (triggeredAt
 * stamped). Survives dismiss/snooze; cleared only when the pill is re-armed.
 */
export function computeFiredAnchorIds(reminders: FiredCandidate[]): Set<string> {
  const ids = new Set<string>()
  for (const r of reminders) {
    if (r.triggeredAt && r.anchorId) ids.add(r.anchorId)
  }
  return ids
}

/**
 * Toggle `data-fired` on every date pill in `container` so CSS can recolor fired
 * ones. Idempotent — safe to call repeatedly.
 */
export function applyFiredState(container: HTMLElement, firedAnchorIds: Set<string>): void {
  const pills = container.querySelectorAll<HTMLElement>('.date-mention[data-anchor-id]')
  pills.forEach((pill) => {
    const anchorId = pill.getAttribute('data-anchor-id')
    if (anchorId && firedAnchorIds.has(anchorId)) {
      pill.setAttribute('data-fired', 'true')
    } else {
      pill.removeAttribute('data-fired')
    }
  })
}

/**
 * Re-apply fired state whenever BlockNote recreates pill DOM (raw node-views are
 * rebuilt on updateBlock). `getFiredAnchorIds` is read lazily so the latest set
 * is used on every mutation. Returns a cleanup that disconnects the observer.
 */
export function watchFiredPills(
  container: HTMLElement,
  getFiredAnchorIds: () => Set<string>
): () => void {
  const observer = new MutationObserver(() => {
    applyFiredState(container, getFiredAnchorIds())
  })
  observer.observe(container, { childList: true, subtree: true })
  return () => observer.disconnect()
}

/**
 * Paint fired date pills inside the editor container via `data-fired`. Applies
 * immediately when the fired set changes and re-applies when BlockNote recreates
 * pill DOM.
 */
export function useTriggeredDatePills(
  containerRef: RefObject<HTMLElement | null>,
  firedAnchorIds: Set<string>
): void {
  const firedRef = useRef(firedAnchorIds)
  firedRef.current = firedAnchorIds

  useEffect(() => {
    const container = containerRef.current
    if (container) applyFiredState(container, firedAnchorIds)
  }, [containerRef, firedAnchorIds])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    return watchFiredPills(container, () => firedRef.current)
  }, [containerRef])
}

/**
 * Fired anchor ids for a note's inline date pills. `useRemindersForTarget`
 * already invalidates on create/delete/dismiss, but not on a reminder *firing*,
 * so we also refetch on the due event to recolor a pill live while the note is
 * open.
 */
export function useFiredDatePillAnchors(noteId: string | undefined): Set<string> {
  const { reminders, refetch } = useRemindersForTarget('note_date', noteId ?? '')

  const refetchRef = useRef(refetch)
  refetchRef.current = refetch

  useEffect(() => {
    if (!noteId) return
    return window.api.onReminderDue((event) => {
      const matches = event.reminders.some(
        (r) => r.targetType === 'note_date' && r.targetId === noteId
      )
      if (matches) refetchRef.current()
    })
  }, [noteId])

  return useMemo(() => computeFiredAnchorIds(reminders), [reminders])
}

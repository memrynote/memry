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

const PILL_SELECTOR = '.date-mention[data-anchor-id]'

function isElement(node: Node): node is HTMLElement {
  return node.nodeType === Node.ELEMENT_NODE
}

/** `root` itself when it is a date pill, plus every date pill inside it. */
function collectPills(root: HTMLElement): HTMLElement[] {
  const pills = root.matches(PILL_SELECTOR) ? [root] : []
  pills.push(...root.querySelectorAll<HTMLElement>(PILL_SELECTOR))
  return pills
}

/** Toggle `data-fired` on the given pills. Idempotent. */
function paintPills(pills: HTMLElement[], firedAnchorIds: Set<string>): void {
  for (const pill of pills) {
    const anchorId = pill.getAttribute('data-anchor-id')
    if (anchorId && firedAnchorIds.has(anchorId)) {
      pill.setAttribute('data-fired', 'true')
    } else {
      pill.removeAttribute('data-fired')
    }
  }
}

/**
 * Toggle `data-fired` on every date pill in `container` so CSS can recolor fired
 * ones. Idempotent — safe to call repeatedly.
 */
export function applyFiredState(container: HTMLElement, firedAnchorIds: Set<string>): void {
  paintPills(collectPills(container), firedAnchorIds)
}

/**
 * The pills a mutation batch can have left unpainted: pills inside freshly
 * attached elements, and pills whose anchor id just changed. A keystroke that
 * only rewrites text yields none, so nothing is scanned.
 */
function pillsTouchedBy(records: MutationRecord[]): HTMLElement[] {
  const pills: HTMLElement[] = []
  for (const record of records) {
    if (record.type === 'attributes') {
      if (isElement(record.target)) pills.push(record.target)
      continue
    }
    for (const node of record.addedNodes) {
      if (isElement(node)) pills.push(...collectPills(node))
    }
  }
  return pills
}

/**
 * Re-apply fired state whenever BlockNote recreates pill DOM (raw node-views are
 * rebuilt on updateBlock). Only the changed subtrees are scanned — ProseMirror
 * touches the DOM on every keystroke, so scanning the whole note here costs a
 * full-document query per character. `getFiredAnchorIds` is read lazily so the
 * latest set is used on every mutation. Returns a cleanup that disconnects the
 * observer.
 */
export function watchFiredPills(
  container: HTMLElement,
  getFiredAnchorIds: () => Set<string>
): () => void {
  const observer = new MutationObserver((records) => {
    const pills = pillsTouchedBy(records)
    if (pills.length > 0) paintPills(pills, getFiredAnchorIds())
  })
  // `data-fired` is deliberately not in the filter: painting must not re-trigger
  // the observer.
  observer.observe(container, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['data-anchor-id']
  })
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

  useEffect(() => {
    firedRef.current = firedAnchorIds
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
  useEffect(() => {
    refetchRef.current = refetch
  })

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

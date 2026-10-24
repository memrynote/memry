/**
 * Live inputs for the canvas note-edit lock: whether this window already holds a
 * live Yjs fragment for a given note — the thing that actually makes a second
 * editor safe, see canvas-note-lock.ts — and which notes are currently editable
 * in a visible pane. Kept separate from canvas-note-lock.ts so the decision
 * stays pure.
 */
import { useMemo } from 'react'
import { useTabs } from '@/contexts/tabs'
import { useLiveFragmentQuery } from '@/sync/use-yjs-collaboration'
import type { CanvasCardRef } from './canvas-cards'
import {
  collectVisibleNoteTabIds,
  evaluateNoteLock,
  noteCardClaims,
  type NoteLockReason
} from './canvas-note-lock'

export interface NoteEditLockContext {
  /**
   * Per-note, because the lock is asked per card. Identity changes only when an
   * answer could have changed, so this context object — and the card list
   * memoized on it in canvas-card-overlay.tsx — stays stable between them.
   */
  hasLiveFragment: (noteId: string) => boolean
  visibleNoteTabIds: ReadonlySet<string>
}

export function useNoteEditLock(): NoteEditLockContext {
  const { state: tabState } = useTabs()
  // Read-only: this registers no registry consumer, so it does not make the
  // note's sole editor report non-owner (#1495).
  const hasLiveFragment = useLiveFragmentQuery()
  const visibleNoteTabIds = useMemo(
    () => collectVisibleNoteTabIds(tabState.tabGroups),
    [tabState.tabGroups]
  )
  return useMemo(
    () => ({ hasLiveFragment, visibleNoteTabIds }),
    [hasLiveFragment, visibleNoteTabIds]
  )
}

/**
 * Only note cards are guarded. Task and event cards autosave field-level
 * patches through their own IPC services, not a whole-body last-write-wins
 * markdown save, so they are not exposed to the M6 clobber.
 */
export function lockReasonForCard(
  ctx: NoteEditLockContext,
  card: CanvasCardRef
): NoteLockReason | null {
  if (card.entityType !== 'note') return null
  return evaluateNoteLock({
    fragmentLive: ctx.hasLiveFragment(card.entityId),
    visibleNoteTabIds: ctx.visibleNoteTabIds,
    claimedBy: noteCardClaims.claimedBy(card.entityId),
    cardElementId: card.elementId,
    noteId: card.entityId
  })
}

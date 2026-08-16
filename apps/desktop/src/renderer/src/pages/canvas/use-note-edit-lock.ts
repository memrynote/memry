/**
 * Live inputs for the canvas note-edit lock: whether a remote sync session is
 * live — which is now a proxy for "main's CRDT provider is up", not for "this
 * editor is collaborative"; see canvas-note-lock.ts — and which notes are
 * currently editable in a visible pane. Kept separate from canvas-note-lock.ts
 * so the decision stays pure.
 */
import { useMemo } from 'react'
import { useSync } from '@/contexts/sync-context'
import { useTabs } from '@/contexts/tabs'
import { isCollaborationActive } from '@/sync/collaboration-status'
import type { CanvasCardRef } from './canvas-cards'
import {
  collectVisibleNoteTabIds,
  evaluateNoteLock,
  noteCardClaims,
  type NoteLockReason
} from './canvas-note-lock'

export interface NoteEditLockContext {
  collaborationActive: boolean
  visibleNoteTabIds: ReadonlySet<string>
}

export function useNoteEditLock(): NoteEditLockContext {
  const { state: syncState } = useSync()
  const { state: tabState } = useTabs()
  const collaborationActive = isCollaborationActive(syncState.status)
  const visibleNoteTabIds = useMemo(
    () => collectVisibleNoteTabIds(tabState.tabGroups),
    [tabState.tabGroups]
  )
  return useMemo(
    () => ({ collaborationActive, visibleNoteTabIds }),
    [collaborationActive, visibleNoteTabIds]
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
    collaborationActive: ctx.collaborationActive,
    visibleNoteTabIds: ctx.visibleNoteTabIds,
    claimedBy: noteCardClaims.claimedBy(card.entityId),
    cardElementId: card.elementId,
    noteId: card.entityId
  })
}

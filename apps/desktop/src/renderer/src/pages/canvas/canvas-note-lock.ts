/**
 * Why a canvas note card sometimes refuses to become editable.
 *
 * ContentArea only engages Yjs collaboration for an authenticated sync session.
 * Unauthenticated users therefore edit through a NON-collaborative BlockNote
 * that debounce-saves whole markdown. Two such editors on one note (a note tab
 * in one pane + an active canvas card in another) clobber each other
 * last-save-wins, and each independently runs ContentArea's task
 * auto-conversion, so a checkbox can become two tasks.
 *
 * The rule is "the tab always wins": a card refuses to activate and stays a
 * read-only preview with an open-in-tab affordance. Authenticated users never
 * satisfy the first conjunct, so their shared-Y.Doc co-editing is untouched.
 *
 * Excalidraw-free and React-free so it unit-tests in jsdom, matching
 * canvas-active.ts.
 */
import type { TabGroup } from '@/contexts/tabs'

export type NoteLockReason = 'note-open-in-tab' | 'note-active-on-another-card'

export interface NoteLockInput {
  /** From isCollaborationActive(syncStatus). True => authenticated shared Y.Doc. */
  collaborationActive: boolean
  /** Note ids that are the ACTIVE tab of some pane (see collectVisibleNoteTabIds). */
  visibleNoteTabIds: ReadonlySet<string>
  /** Card element id currently claiming this note, or null. */
  claimedBy: string | null
  /** The card asking to activate. */
  cardElementId: string
  noteId: string
}

export function evaluateNoteLock(input: NoteLockInput): NoteLockReason | null {
  if (input.collaborationActive) return null
  if (input.visibleNoteTabIds.has(input.noteId)) return 'note-open-in-tab'
  if (input.claimedBy !== null && input.claimedBy !== input.cardElementId) {
    return 'note-active-on-another-card'
  }
  return null
}

/**
 * Note ids reachable for editing right now. components/split-view/tab-pane.tsx
 * renders ONLY `group.tabs.find(t => t.id === group.activeTabId)`, so a
 * background tab in the same group is unmounted and cannot clobber anything.
 * Checking active tabs is therefore exact, not an approximation — if tab
 * rendering ever keeps background tabs mounted, this function must change.
 */
export function collectVisibleNoteTabIds(tabGroups: Record<string, TabGroup>): Set<string> {
  const ids = new Set<string>()
  for (const group of Object.values(tabGroups)) {
    const active = group.tabs.find((tab) => tab.id === group.activeTabId)
    if (active?.type === 'note' && active.entityId) {
      ids.add(active.entityId)
    }
  }
  return ids
}

export interface NoteCardClaims {
  /** True when this card now owns the note (already-owner re-claims succeed). */
  claim(noteId: string, cardElementId: string): boolean
  /** No-op unless this card is the current owner. */
  release(noteId: string, cardElementId: string): void
  claimedBy(noteId: string): string | null
}

export function createNoteCardClaims(): NoteCardClaims {
  const claims = new Map<string, string>()
  return {
    claim(noteId, cardElementId) {
      const current = claims.get(noteId)
      if (current !== undefined && current !== cardElementId) return false
      claims.set(noteId, cardElementId)
      return true
    },
    release(noteId, cardElementId) {
      if (claims.get(noteId) === cardElementId) claims.delete(noteId)
    },
    claimedBy(noteId) {
      return claims.get(noteId) ?? null
    }
  }
}

/**
 * Module singleton — two CanvasCardLayer instances in two panes are separate
 * React trees, so the claim must live outside React. Mirrors the module-level
 * registry in sync/use-yjs-collaboration.ts. Tests use createNoteCardClaims().
 */
export const noteCardClaims = createNoteCardClaims()

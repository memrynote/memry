/**
 * Why a canvas note card sometimes refuses to become editable.
 *
 * As built (M7 §3.1): ContentArea engaged Yjs only for an authenticated sync
 * session, so an unauthenticated user edited through a NON-collaborative
 * BlockNote that debounce-saved whole markdown. Two of those on one note — a
 * note tab in one pane, an active canvas card in another — clobbered each other
 * last-save-wins, and each ran ContentArea's task auto-conversion on its own
 * onChange, so one checkbox became two tasks.
 *
 * `f89d23ed5` deleted that premise. ContentArea binds the local Y.Doc for every
 * note, session or none, so a tab and a card in one window acquire ONE entry
 * from the registry in sync/use-yjs-collaboration.ts and share its doc, exactly
 * as an authenticated pair already did. Both halves close with it: the shared
 * fragment suppresses the whole-markdown save (`!yjsFragment`, in
 * content-area/hooks/use-editor-sync.ts), and the registry names exactly one
 * `isSideEffectOwner` — the duplicate conversion only ever existed because a
 * DISABLED mount defaulted that flag to true.
 *
 * What survives is the binding FAILING. `crdt:open-doc` answers
 * `success: false` while main's provider is uninitialized; the entry then
 * destroys its provider and publishes a null fragment for the life of the slot
 * (use-yjs-collaboration.ts, "fails open") with no rebind — so the first editor
 * to open that note, and every editor that later joins it, is a whole-markdown
 * saver again. That is the original clobber, unchanged.
 *
 * Until #1504 this gate asked the SYNC SESSION about that (`!isCollaborationActive`),
 * because main is uninitialized only after `resetCrdtProvider()` and no such
 * state reports idle/syncing/offline. That was a conservative over-approximation
 * and wrong in both directions: it locked every healthy never-signed-in user —
 * who cannot reach a provider reset at all — out of canvas editing, and it never
 * saw the signed-in fail-open, where a live `idle` session sits on a note whose
 * own `connect()` rejected. It asks the fragment directly now:
 * `fragmentLive` is `useLiveFragmentQuery()` over the registry's read-only
 * `peek`, which registers no consumer and so does not make the note's sole
 * editor report non-owner — the hazard that blocked this in #1495.
 *
 * Note that `fragmentLive` short-circuits ONLY the tab conjunct. It is a safety
 * answer ("a second editor cannot clobber the first"), not the one-active-card
 * invariant: `canvas-card-overlay.tsx` refuses a second activation through
 * `noteCardClaims.claim` regardless, so leaving the claim conjunct behind the
 * safety answer would have made that refusal silent — the card would show no
 * lock badge and simply not activate, and `claimFailedTick` (which exists to
 * re-evaluate this decision after exactly that refusal) would be dead.
 *
 * The rule is "the tab always wins": a card refuses to activate and stays a
 * read-only preview with an open-in-tab affordance.
 *
 * Excalidraw-free and React-free so it unit-tests in jsdom, matching
 * canvas-active.ts.
 */
import type { TabGroup } from '@/contexts/tabs'

export type NoteLockReason = 'note-open-in-tab' | 'note-active-on-another-card'

export interface NoteLockInput {
  /**
   * Does THIS window hold a live Yjs fragment for this note — a settled
   * `connect()` that produced one? See `useLiveFragmentQuery`. True means every
   * editor that binds this note here shares that fragment, so a second one
   * cannot clobber the first. False covers all three unsafe shapes at once: the
   * fail-open (settled, no fragment), the still-connecting slot, and no slot at
   * all. Cross-window is out of its reach and always was — the registry and
   * `visibleNoteTabIds` are both window-local, so a note open in ANOTHER window
   * has never reached this decision.
   */
  fragmentLive: boolean
  /** Note ids that are the ACTIVE tab of some pane (see collectVisibleNoteTabIds). */
  visibleNoteTabIds: ReadonlySet<string>
  /** Card element id currently claiming this note, or null. */
  claimedBy: string | null
  /** The card asking to activate. */
  cardElementId: string
  noteId: string
}

export function evaluateNoteLock(input: NoteLockInput): NoteLockReason | null {
  if (!input.fragmentLive && input.visibleNoteTabIds.has(input.noteId)) return 'note-open-in-tab'
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

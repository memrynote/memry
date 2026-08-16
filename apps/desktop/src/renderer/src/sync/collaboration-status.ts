/**
 * Two questions that used to be one switch.
 *
 * `isCollaborationActive` answers "is a REMOTE sync session available?".
 * `isLocalCrdtDocLive` answers "should this window's local Y.Doc be live?".
 * They are not the same question, and answering both with the first one is what
 * destroyed signed-out edits: with no session the editor was never bound to a
 * Y.Doc at all, so keystrokes went to markdown alone and never became CRDT
 * operations — and the Y.Doc is canonical, so the sign-in that rebuilt it from
 * the server wrote it straight back over them. Nothing failed to merge; there
 * was nothing to merge.
 */
export type SyncStatus = 'idle' | 'syncing' | 'paused' | 'error' | 'offline' | 'unknown'

/**
 * Is a remote sync session available?
 *
 * The canvas note-card lock (pages/canvas/canvas-note-lock.ts) gates on its
 * NEGATION, and still must — but not for the reason it was written. It no
 * longer means "this user has no shared Y.Doc": since `f89d23ed5` every note
 * has one, signed in or not, so a note tab and a canvas card in one window
 * share it either way. What the negation now selects is "main's CRDT provider
 * may be down", because the only thing that leaves it uninitialized is
 * `resetCrdtProvider()` from the sync runtime's stop and start-failure paths —
 * and an editor that opens a note while main is down falls open to a
 * whole-markdown saver for the life of its mount, which is the original
 * clobber. Still one predicate, then: a second copy that drifts stops matching
 * a live data-loss path with no test going red. The full argument, and what
 * would replace this, is in canvas-note-lock.ts. These statuses are produced in
 * contexts/sync-context.tsx.
 *
 * NOT the editor's gate. ContentArea used to call this and no longer does — see
 * `isLocalCrdtDocLive`.
 */
export function isCollaborationActive(status: SyncStatus): boolean {
  return status === 'idle' || status === 'syncing' || status === 'offline'
}

/**
 * Should this window's local Y.Doc be live?
 *
 * Yes, for every note — signed in or not, online or not, with an account or
 * with none. The doc is local: main opens it from this vault's own CRDT store
 * (see crdt-store-path.ts, which is why sign-out no longer wipes it), persists
 * to it, and writes markdown back from it. None of that needs a server, and the
 * session must only ever decide whether anything is *synced*.
 *
 * Deliberately not a constant: this is the seam the editor gate lives on, so it
 * is greppable and so nobody re-points ContentArea at `isCollaborationActive`.
 * The note id is the whole input — there is no doc without a note, and a note
 * only exists inside an open vault.
 */
export function isLocalCrdtDocLive(noteId: string | undefined): boolean {
  return Boolean(noteId)
}

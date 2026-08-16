/**
 * The sync session's status, and the one predicate that must NOT be derived
 * from it.
 *
 * There used to be an `isCollaborationActive(status)` here answering "is a
 * REMOTE sync session available?", and the editor gate was that same call.
 * Answering both questions with it is what destroyed signed-out edits: with no
 * session the editor was never bound to a Y.Doc at all, so keystrokes went to
 * markdown alone and never became CRDT operations — and the Y.Doc is canonical,
 * so the sign-in that rebuilt it from the server wrote it straight back over
 * them. Nothing failed to merge; there was nothing to merge.
 *
 * Its last caller was the canvas note-card lock, which gated on its NEGATION as
 * a proxy for "main's CRDT provider may be down". #1504 re-keyed that lock on
 * the fragment itself (`useLiveFragmentQuery`), which answers the question the
 * session was only ever approximating, so the predicate is gone rather than
 * left behind for someone to re-point the editor at. Statuses are produced in
 * contexts/sync-context.tsx.
 */
export type SyncStatus = 'idle' | 'syncing' | 'paused' | 'error' | 'offline' | 'unknown'

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
 * is greppable and so nobody re-derives it from `SyncStatus`. The note id is the
 * whole input — there is no doc without a note, and a note only exists inside an
 * open vault.
 */
export function isLocalCrdtDocLive(noteId: string | undefined): boolean {
  return Boolean(noteId)
}

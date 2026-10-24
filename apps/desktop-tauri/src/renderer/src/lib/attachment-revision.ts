/**
 * How an already-open note learns that one of its attachments just arrived.
 *
 * A note resolves its attachment URLs once, while its blocks are being built,
 * and nothing re-runs that afterwards: BlockNote calls `resolveFileUrl` a single
 * time per block and keeps the answer, and the inline PDF preview latches its
 * load error and never retries. So a file that syncs in a second later is
 * invisible — and closing the note does not help, because the editor stays
 * mounted for the life of the window. Only quitting the app made it appear.
 *
 * Bumping a note's revision changes the URL its blocks render (`?v=<n>`), which
 * is the one thing that reliably makes a block ask for the file again: a
 * different URL is a different request and a different React dependency, so the
 * latched error is dropped with it.
 *
 * A module store rather than context: the blocks that need this are mounted by
 * BlockNote, outside any provider we control.
 */

let subscribed = false
const revisions = new Map<string, number>()
const listeners = new Set<() => void>()

/** Test seam — drops every revision and listener. */
export function resetAttachmentRevisions(): void {
  revisions.clear()
  listeners.clear()
  subscribed = false
}

export function getAttachmentRevision(noteId: string | undefined): number {
  if (!noteId) return 0
  return revisions.get(noteId) ?? 0
}

export function bumpAttachmentRevision(noteId: string): void {
  revisions.set(noteId, (revisions.get(noteId) ?? 0) + 1)
  for (const listener of listeners) listener()
}

export function subscribeToAttachmentRevisions(listener: () => void): () => void {
  listeners.add(listener)
  // Bind to main lazily and once: this module is imported by block components,
  // so binding at import time would attach before the preload API exists on the
  // surfaces that render an editor during boot.
  if (!subscribed) {
    subscribed = true
    window.api?.onAttachmentMaterialized?.(({ noteId }) => bumpAttachmentRevision(noteId))
  }
  return () => {
    listeners.delete(listener)
  }
}

/**
 * The URL to render for `resolved`, carrying the note's current revision.
 *
 * Revision 0 returns the URL untouched, so a note that never had an attachment
 * arrive mid-session renders exactly the string it always did — nothing in the
 * markdown, and nothing on disk, is affected either way. The suffix only ever
 * exists in the DOM.
 */
export function withAttachmentRevision(resolved: string, revision: number): string {
  if (revision <= 0 || !resolved) return resolved
  // A bare relative ref would make `new URL` throw, and it is not something we
  // can meaningfully version anyway — it has not been resolved yet.
  if (!/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(resolved)) return resolved
  const separator = resolved.includes('?') ? '&' : '?'
  return `${resolved}${separator}v=${revision}`
}

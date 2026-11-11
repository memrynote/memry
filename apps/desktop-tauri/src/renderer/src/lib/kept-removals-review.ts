/**
 * Whether the review of the notes kept after their files were deleted outside the app is open
 * (#4140): the `keptRemovals` notice's toast opens it, and the app root renders
 * `KeptRemovalsDialog` once.
 *
 * @module lib/kept-removals-review
 */

let open = false
const listeners = new Set<() => void>()

export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const isReviewOpen = (): boolean => open

export function setReviewOpen(next: boolean): void {
  if (open === next) return
  open = next
  for (const listener of listeners) listener()
}

/** A kept note's name: its file's, without the folder or `.md`, on any platform's separators. */
export const keptName = (path: string): string =>
  (path.split(/[\\/]/).pop() || path).replace(/\.md$/i, '')

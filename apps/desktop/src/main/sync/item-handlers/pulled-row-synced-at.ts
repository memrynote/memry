/**
 * The `syncedAt` a pull stamps on the note or journal row it writes. The row
 * holds the server's state, so it never reads as edited since its sync
 * (`modifiedAt > syncedAt`), even when its `modifiedAt` comes from a sender
 * whose clock runs ahead or from a parse stamped after `now`. Read as edited, a
 * store that never held the doc owes the row's file to it
 * (`oweUnsyncedFileBody`): a file an update record left empty then replaces the
 * server body on every device. Compared as strings, as that rule compares.
 */
export function pulledRowSyncedAt(modifiedAt: string, now: string): string {
  return modifiedAt > now ? modifiedAt : now
}

/**
 * The single source of truth for "is Yjs collaboration live for note editors?".
 *
 * ContentArea gates useYjsCollaboration on this; the canvas note-card lock
 * (pages/canvas/canvas-note-lock.ts) gates on its NEGATION. Both must read this
 * one predicate: if two copies drift, the canvas guard silently stops matching
 * the condition it exists to guard, and unauthenticated split-view body clobber
 * comes back without any test going red.
 *
 * Collaboration is reachable only for an authenticated sync session — see
 * contexts/sync-context.tsx, where these statuses are produced.
 */
export type SyncStatus = 'idle' | 'syncing' | 'paused' | 'error' | 'offline' | 'unknown'

export function isCollaborationActive(status: SyncStatus): boolean {
  return status === 'idle' || status === 'syncing' || status === 'offline'
}

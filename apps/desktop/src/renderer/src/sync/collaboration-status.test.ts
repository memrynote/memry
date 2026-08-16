import { describe, it, expect } from 'vitest'
import { isLocalCrdtDocLive, type SyncStatus } from './collaboration-status'

const ALL_STATUSES: SyncStatus[] = ['idle', 'syncing', 'paused', 'error', 'offline', 'unknown']

// `isCollaborationActive` lived here and is gone: its last consumer, the canvas
// note-card lock, reads the fragment now (#1504). No test replaces it — the
// lock's own suites (canvas-note-lock.test.ts, use-note-edit-lock.test.tsx) own
// that decision, and TypeScript pins that no sync status can reach it.
describe('isLocalCrdtDocLive', () => {
  it('is true for a note on every sync status, including having none', () => {
    // The local Y.Doc is the editor's store, not a sync feature: main opens it
    // from this vault's own CRDT store and writes markdown back from it. Gating
    // it on the session is what let a signed-out edit reach markdown alone and
    // be overwritten by the Y.Doc the next sign-in rebuilt from the server.
    expect(ALL_STATUSES).not.toHaveLength(0)
    expect(ALL_STATUSES.every(() => isLocalCrdtDocLive('note-1'))).toBe(true)
  })

  it('is false with no note, which is the only thing it depends on', () => {
    expect(isLocalCrdtDocLive(undefined)).toBe(false)
    expect(isLocalCrdtDocLive('')).toBe(false)
  })
})

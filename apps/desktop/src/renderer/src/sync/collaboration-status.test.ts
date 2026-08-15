import { describe, it, expect } from 'vitest'
import { isCollaborationActive, isLocalCrdtDocLive, type SyncStatus } from './collaboration-status'
import { evaluateNoteLock } from '@/pages/canvas/canvas-note-lock'

const ALL_STATUSES: SyncStatus[] = ['idle', 'syncing', 'paused', 'error', 'offline', 'unknown']

describe('isCollaborationActive', () => {
  it('is true only for live sync statuses', () => {
    expect(isCollaborationActive('idle')).toBe(true)
    expect(isCollaborationActive('syncing')).toBe(true)
    expect(isCollaborationActive('offline')).toBe(true)
  })

  it('is false before a sync session exists or when it has failed', () => {
    expect(isCollaborationActive('unknown')).toBe(false)
    expect(isCollaborationActive('paused')).toBe(false)
    expect(isCollaborationActive('error')).toBe(false)
  })

  it('covers every SyncStatus member', () => {
    expect(ALL_STATUSES.filter(isCollaborationActive)).toEqual(['idle', 'syncing', 'offline'])
  })

  // The canvas note-card lock gates on this predicate's NEGATION. Splitting the
  // editor gate off must leave it reading the SESSION question, or the guard
  // silently stops matching the condition it exists to guard.
  it('still locks an unauthenticated canvas note card whose note is open in a tab', () => {
    const lockedStatuses = ALL_STATUSES.filter(
      (status) =>
        evaluateNoteLock({
          collaborationActive: isCollaborationActive(status),
          visibleNoteTabIds: new Set(['note-1']),
          claimedBy: null,
          cardElementId: 'card-a',
          noteId: 'note-1'
        }) === 'note-open-in-tab'
    )
    expect(lockedStatuses).toEqual(['paused', 'error', 'unknown'])
  })
})

describe('isLocalCrdtDocLive', () => {
  it('is true for a note on exactly the statuses collaboration is not', () => {
    // The local Y.Doc is the editor's store, not a sync feature: main opens it
    // from this vault's own CRDT store and writes markdown back from it. Gating
    // it on the session is what let a signed-out edit reach markdown alone and
    // be overwritten by the Y.Doc the next sign-in rebuilt from the server.
    const sessionless = ALL_STATUSES.filter((status) => !isCollaborationActive(status))
    expect(sessionless).not.toHaveLength(0)
    expect(sessionless.every(() => isLocalCrdtDocLive('note-1'))).toBe(true)
  })

  it('is false with no note, which is the only thing it depends on', () => {
    expect(isLocalCrdtDocLive(undefined)).toBe(false)
    expect(isLocalCrdtDocLive('')).toBe(false)
  })
})

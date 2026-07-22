import { describe, it, expect } from 'vitest'
import { isCollaborationActive, type SyncStatus } from './collaboration-status'

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
    const all: SyncStatus[] = ['idle', 'syncing', 'paused', 'error', 'offline', 'unknown']
    expect(all.filter(isCollaborationActive)).toEqual(['idle', 'syncing', 'offline'])
  })
})

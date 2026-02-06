/**
 * Tests for crdt-sync-bridge.ts
 * Tests CRDT sync bridge functionality including journal sync and signature verification.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('./api-client', () => ({
  getSyncApiClient: vi.fn(() => ({
    pushCrdtUpdates: vi.fn().mockResolvedValue({
      accepted: [],
      rejected: [],
      serverTime: Date.now()
    }),
    pullCrdtUpdates: vi.fn().mockResolvedValue({
      noteId: 'test-note',
      updates: [],
      hasMore: false,
      latestSequence: 0,
      serverTime: Date.now()
    }),
    pullCrdtSnapshot: vi.fn().mockResolvedValue(null)
  })),
  isSyncApiError: vi.fn(() => false)
}))

vi.mock('./network', () => ({
  getNetworkMonitor: vi.fn(() => ({
    isOnline: () => true,
    on: vi.fn(),
    off: vi.fn()
  }))
}))

vi.mock('./queue', () => {
  const mockQueue = {
    add: vi.fn().mockResolvedValue(undefined)
  }
  return {
    getSyncQueue: vi.fn(() => mockQueue)
  }
})

vi.mock('./engine', () => ({
  getSyncEngine: vi.fn(() => ({
    push: vi.fn().mockResolvedValue(undefined)
  }))
}))

vi.mock('../vault/notes', () => ({
  getNotesByIds: vi.fn().mockResolvedValue([])
}))

vi.mock('../vault/journal', () => ({
  getJournalEntriesByIds: vi.fn().mockResolvedValue([])
}))

vi.mock('../crypto/keychain', () => ({
  retrieveDeviceKeyPair: vi.fn().mockResolvedValue({
    deviceId: 'test-device-123',
    publicKey: new Uint8Array(32).fill(1),
    privateKey: new Uint8Array(64).fill(2)
  })
}))

vi.mock('../crypto/signatures', () => ({
  sign: vi.fn().mockResolvedValue(new Uint8Array(64).fill(3)),
  verify: vi.fn().mockResolvedValue(true)
}))

vi.mock('../database', () => ({
  getDatabase: vi.fn(() => ({
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => []),
          get: vi.fn(() => null)
        })),
        get: vi.fn(() => null)
      }))
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        onConflictDoUpdate: vi.fn(() => ({
          run: vi.fn()
        }))
      }))
    }))
  }))
}))

vi.mock('./token-refresh', () => ({
  refreshAccessToken: vi.fn().mockResolvedValue(true)
}))

vi.mock('./auth-state', () => ({
  isSyncAuthReady: vi.fn(() => true)
}))

import { CrdtSyncBridge } from './crdt-sync-bridge'
import type { CrdtProvider } from './crdt-provider'
import { getSyncQueue } from './queue'
import { getNotesByIds } from '../vault/notes'
import { getJournalEntriesByIds } from '../vault/journal'
import { getSyncApiClient } from './api-client'
import { sign, verify } from '../crypto/signatures'
import { getDatabase } from '../database'

describe('CrdtSyncBridge', () => {
  let bridge: CrdtSyncBridge
  let mockCrdtProvider: Partial<CrdtProvider>

  beforeEach(() => {
    vi.clearAllMocks()

    mockCrdtProvider = {
      on: vi.fn(),
      off: vi.fn(),
      applyUpdate: vi.fn(),
      getOrCreateDoc: vi.fn().mockResolvedValue({
        getText: vi.fn(() => ({ toString: () => 'content' }))
      }),
      hasDoc: vi.fn().mockReturnValue(false)
    }

    bridge = new CrdtSyncBridge()
    bridge.initialize(mockCrdtProvider as CrdtProvider)
  })

  afterEach(() => {
    bridge.shutdown()
  })

  describe('isJournalId detection', () => {
    it('detects valid journal ID format', () => {
      // #given
      const isJournalId = (
        bridge as unknown as { isJournalId: (id: string) => boolean }
      ).isJournalId.bind(bridge)

      // #then
      expect(isJournalId('j2024-01-15')).toBe(true)
      expect(isJournalId('j2026-12-31')).toBe(true)
      expect(isJournalId('j1999-06-01')).toBe(true)
    })

    it('rejects invalid formats', () => {
      // #given
      const isJournalId = (
        bridge as unknown as { isJournalId: (id: string) => boolean }
      ).isJournalId.bind(bridge)

      // #then
      expect(isJournalId('abc123')).toBe(false)
      expect(isJournalId('j123')).toBe(false)
      expect(isJournalId('j2024-1-15')).toBe(false)
      expect(isJournalId('2024-01-15')).toBe(false)
      expect(isJournalId('jnot-a-date')).toBe(false)
    })
  })

  describe('syncItemToServer', () => {
    it('queues journal entry with correct type', async () => {
      // #given
      const journalEntry = {
        id: 'j2024-01-15',
        date: '2024-01-15',
        content: 'Test journal content',
        wordCount: 3,
        characterCount: 20,
        tags: ['daily'],
        properties: { mood: 'good' },
        createdAt: '2024-01-15T08:00:00.000Z',
        modifiedAt: '2024-01-15T10:00:00.000Z'
      }

      // #when
      const syncItemToServer = (
        bridge as unknown as {
          syncItemToServer: (id: string, data: unknown) => Promise<boolean>
        }
      ).syncItemToServer.bind(bridge)
      const result = await syncItemToServer('j2024-01-15', journalEntry)

      // #then
      expect(result).toBe(true)
      const queue = getSyncQueue()
      expect(queue.add).toHaveBeenCalledWith(
        'journal',
        'j2024-01-15',
        'create',
        expect.stringContaining('"id":"j2024-01-15"'),
        10
      )
    })

    it('queues note entry with correct type', async () => {
      // #given
      const note = {
        id: 'abc123',
        title: 'Test Note',
        path: 'notes/test.md',
        content: 'Test content',
        frontmatter: {},
        created: new Date('2024-01-15T08:00:00.000Z'),
        modified: new Date('2024-01-15T10:00:00.000Z'),
        tags: [],
        aliases: [],
        wordCount: 2,
        properties: {}
      }

      // #when
      const syncItemToServer = (
        bridge as unknown as {
          syncItemToServer: (id: string, data: unknown) => Promise<boolean>
        }
      ).syncItemToServer.bind(bridge)
      const result = await syncItemToServer('abc123', note)

      // #then
      expect(result).toBe(true)
      const queue = getSyncQueue()
      expect(queue.add).toHaveBeenCalledWith(
        'note',
        'abc123',
        'create',
        expect.stringContaining('"id":"abc123"'),
        10
      )
    })
  })

  describe('Signature verification', () => {
    it('should sign updates when pushing', async () => {
      // #given
      const note = {
        id: 'test-note',
        title: 'Test',
        path: 'test.md',
        content: '',
        frontmatter: {},
        created: new Date(),
        modified: new Date(),
        tags: [],
        aliases: [],
        wordCount: 0,
        properties: {}
      }
      vi.mocked(getNotesByIds).mockResolvedValueOnce([note])

      // Access private method via type assertion
      const flushUpdates = bridge as unknown as {
        flushUpdates: () => Promise<void>
        pendingUpdates: Map<
          string,
          Array<{ noteId: string; update: Uint8Array; timestamp: number }>
        >
        syncedNotes: Set<string>
      }

      // Add pending update
      flushUpdates.pendingUpdates.set('test-note', [
        { noteId: 'test-note', update: new Uint8Array([1, 2, 3]), timestamp: Date.now() }
      ])
      flushUpdates.syncedNotes.add('test-note')

      // #when
      await flushUpdates.flushUpdates.call(bridge)

      // #then
      expect(sign).toHaveBeenCalled()
    })

    it('does not enqueue metadata when note already has persisted sync clock', async () => {
      // #given
      const note = {
        id: 'test-note',
        title: 'Test',
        path: 'test.md',
        content: '',
        frontmatter: {},
        created: new Date(),
        modified: new Date(),
        tags: [],
        aliases: [],
        wordCount: 0,
        properties: {}
      }
      vi.mocked(getNotesByIds).mockResolvedValueOnce([note])

      vi.mocked(getDatabase).mockReturnValue({
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn(() => []),
              get: vi.fn(() => ({
                value: JSON.stringify({ 'test-device-123': 1 })
              }))
            })),
            get: vi.fn(() => ({
              value: JSON.stringify({ 'test-device-123': 1 })
            }))
          }))
        })),
        insert: vi.fn(() => ({
          values: vi.fn(() => ({
            onConflictDoUpdate: vi.fn(() => ({
              run: vi.fn()
            }))
          }))
        }))
      } as unknown as ReturnType<typeof getDatabase>)

      const flushUpdates = bridge as unknown as {
        flushUpdates: () => Promise<void>
        pendingUpdates: Map<
          string,
          Array<{ noteId: string; update: Uint8Array; timestamp: number }>
        >
      }

      flushUpdates.pendingUpdates.set('test-note', [
        { noteId: 'test-note', update: new Uint8Array([1, 2, 3]), timestamp: Date.now() }
      ])

      // #when
      await flushUpdates.flushUpdates.call(bridge)

      // #then
      const queue = getSyncQueue()
      expect(queue.add).not.toHaveBeenCalled()
      expect(sign).toHaveBeenCalled()
    })

    it('should verify signatures when pulling updates', async () => {
      // #given
      const mockClient = {
        pullCrdtUpdates: vi.fn().mockResolvedValue({
          noteId: 'test-note',
          updates: [
            {
              sequenceNum: 1,
              updateData: 'AQID', // base64 for [1,2,3]
              signature: 'AAAA', // mock signature
              signerDeviceId: 'test-device-123',
              createdAt: Date.now()
            }
          ],
          hasMore: false,
          latestSequence: 1,
          serverTime: Date.now()
        }),
        pushCrdtUpdates: vi.fn()
      }
      vi.mocked(getSyncApiClient).mockReturnValue(mockClient as ReturnType<typeof getSyncApiClient>)

      // #when
      await bridge.pullUpdatesForNote('test-note')

      // #then
      expect(verify).toHaveBeenCalled()
    })

    it('should reject updates with invalid signatures', async () => {
      // #given
      vi.mocked(verify).mockResolvedValueOnce(false)

      const mockClient = {
        pullCrdtUpdates: vi.fn().mockResolvedValue({
          noteId: 'test-note',
          updates: [
            {
              sequenceNum: 1,
              updateData: 'AQID',
              signature: 'invalid',
              signerDeviceId: 'unknown-device',
              createdAt: Date.now()
            }
          ],
          hasMore: false,
          latestSequence: 1,
          serverTime: Date.now()
        }),
        pushCrdtUpdates: vi.fn()
      }
      vi.mocked(getSyncApiClient).mockReturnValue(mockClient as ReturnType<typeof getSyncApiClient>)

      // #when
      await bridge.pullUpdatesForNote('test-note')

      // #then
      expect(mockCrdtProvider.applyUpdate).not.toHaveBeenCalled()
    })
  })

  describe('Batch database queries', () => {
    it('should separate journal and note IDs for batch fetching', () => {
      // #given
      const isJournalId = (
        bridge as unknown as { isJournalId: (id: string) => boolean }
      ).isJournalId.bind(bridge)

      const noteIds = ['note-1', 'note-2', 'j2024-01-15', 'j2024-01-16']

      // #when
      const journalIds = noteIds.filter((id) => isJournalId(id))
      const regularNoteIds = noteIds.filter((id) => !isJournalId(id))

      // #then
      expect(journalIds).toEqual(['j2024-01-15', 'j2024-01-16'])
      expect(regularNoteIds).toEqual(['note-1', 'note-2'])
    })
  })

  describe('Listener cleanup', () => {
    it('should remove listeners on shutdown', () => {
      // #given
      bridge.shutdown()

      // #then
      expect(mockCrdtProvider.off).toHaveBeenCalledWith('crdt:doc-updated', expect.any(Function))
    })
  })

  describe('Server-assigned sequences', () => {
    it('should not send sequenceNum in push updates', async () => {
      // #given
      const note = {
        id: 'test-note',
        title: 'Test',
        path: 'test.md',
        content: '',
        frontmatter: {},
        created: new Date(),
        modified: new Date(),
        tags: [],
        aliases: [],
        wordCount: 0,
        properties: {}
      }
      vi.mocked(getNotesByIds).mockResolvedValueOnce([note])

      const mockPushCrdtUpdates = vi.fn().mockResolvedValue({
        accepted: [{ noteId: 'test-note', sequenceNum: 1 }],
        rejected: [],
        serverTime: Date.now()
      })

      vi.mocked(getSyncApiClient).mockReturnValue({
        pushCrdtUpdates: mockPushCrdtUpdates,
        pullCrdtUpdates: vi.fn(),
        pullCrdtSnapshot: vi.fn(),
        pushCrdtSnapshot: vi.fn()
      } as unknown as ReturnType<typeof getSyncApiClient>)

      const flushUpdates = bridge as unknown as {
        flushUpdates: () => Promise<void>
        pendingUpdates: Map<
          string,
          Array<{ noteId: string; update: Uint8Array; timestamp: number }>
        >
        syncedNotes: Set<string>
      }

      flushUpdates.pendingUpdates.set('test-note', [
        { noteId: 'test-note', update: new Uint8Array([1, 2, 3]), timestamp: Date.now() }
      ])
      flushUpdates.syncedNotes.add('test-note')

      // #when
      await flushUpdates.flushUpdates.call(bridge)

      // #then
      expect(mockPushCrdtUpdates).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            noteId: 'test-note',
            updateData: expect.any(String),
            signature: expect.any(String),
            signerDeviceId: 'test-device-123'
          })
        ])
      )

      const pushedUpdates = mockPushCrdtUpdates.mock.calls[0][0]
      expect(pushedUpdates[0]).not.toHaveProperty('sequenceNum')
    })

    it('should update lastKnownSequence from server response', async () => {
      // #given
      const note = {
        id: 'test-note',
        title: 'Test',
        path: 'test.md',
        content: '',
        frontmatter: {},
        created: new Date(),
        modified: new Date(),
        tags: [],
        aliases: [],
        wordCount: 0,
        properties: {}
      }
      vi.mocked(getNotesByIds).mockResolvedValueOnce([note])

      const mockPushCrdtUpdates = vi.fn().mockResolvedValue({
        accepted: [{ noteId: 'test-note', sequenceNum: 42 }],
        rejected: [],
        serverTime: Date.now()
      })

      vi.mocked(getSyncApiClient).mockReturnValue({
        pushCrdtUpdates: mockPushCrdtUpdates,
        pullCrdtUpdates: vi.fn(),
        pullCrdtSnapshot: vi.fn(),
        pushCrdtSnapshot: vi.fn()
      } as unknown as ReturnType<typeof getSyncApiClient>)

      const bridgeInternal = bridge as unknown as {
        flushUpdates: () => Promise<void>
        pendingUpdates: Map<
          string,
          Array<{ noteId: string; update: Uint8Array; timestamp: number }>
        >
        syncedNotes: Set<string>
        sequenceState: Map<string, { lastKnownSequence: number }>
      }

      bridgeInternal.pendingUpdates.set('test-note', [
        { noteId: 'test-note', update: new Uint8Array([1, 2, 3]), timestamp: Date.now() }
      ])
      bridgeInternal.syncedNotes.add('test-note')

      // #when
      await bridgeInternal.flushUpdates.call(bridge)

      // #then
      const state = bridgeInternal.sequenceState.get('test-note')
      expect(state?.lastKnownSequence).toBe(42)
    })
  })

  describe('pullUpdatesForAllLoadedDocs', () => {
    it('should pull updates for all loaded docs', async () => {
      // #given
      const mockPullCrdtUpdates = vi.fn().mockResolvedValue({
        noteId: 'note-1',
        updates: [],
        hasMore: false,
        latestSequence: 0,
        serverTime: Date.now()
      })

      vi.mocked(getSyncApiClient).mockReturnValue({
        pushCrdtUpdates: vi.fn(),
        pullCrdtUpdates: mockPullCrdtUpdates,
        pullCrdtSnapshot: vi.fn(),
        pushCrdtSnapshot: vi.fn()
      } as unknown as ReturnType<typeof getSyncApiClient>)

      const loadedDocIds = ['note-1', 'note-2', 'note-3']
      mockCrdtProvider.getLoadedDocIds = vi.fn().mockReturnValue(loadedDocIds)

      // #when
      await bridge.pullUpdatesForAllLoadedDocs()

      // #then
      expect(mockCrdtProvider.getLoadedDocIds).toHaveBeenCalled()
      expect(mockPullCrdtUpdates).toHaveBeenCalledTimes(3)
    })

    it('should skip pull when offline', async () => {
      // #given
      const { getNetworkMonitor } = await import('./network')
      vi.mocked(getNetworkMonitor).mockReturnValue({
        isOnline: () => false,
        on: vi.fn(),
        off: vi.fn()
      })

      mockCrdtProvider.getLoadedDocIds = vi.fn().mockReturnValue(['note-1'])

      // #when
      await bridge.pullUpdatesForAllLoadedDocs()

      // #then
      expect(mockCrdtProvider.getLoadedDocIds).not.toHaveBeenCalled()
    })

    it('should not call pullCrdtUpdates when no docs are loaded', async () => {
      // #given
      const mockPullCrdtUpdates = vi.fn().mockResolvedValue({
        noteId: 'test',
        updates: [],
        hasMore: false,
        latestSequence: 0,
        serverTime: Date.now()
      })

      vi.mocked(getSyncApiClient).mockReturnValue({
        pushCrdtUpdates: vi.fn(),
        pullCrdtUpdates: mockPullCrdtUpdates,
        pullCrdtSnapshot: vi.fn(),
        pushCrdtSnapshot: vi.fn()
      } as unknown as ReturnType<typeof getSyncApiClient>)

      mockCrdtProvider.getLoadedDocIds = vi.fn().mockReturnValue([])

      // #when
      await bridge.pullUpdatesForAllLoadedDocs()

      // #then
      expect(mockPullCrdtUpdates).not.toHaveBeenCalled()
    })
  })

  describe('unsynced sync coordination', () => {
    it('coalesces concurrent unsynced sync calls into a single run', async () => {
      // #given
      const bridgeInternal = bridge as unknown as {
        runUnsyncedLocalDocsSync: () => Promise<{ notes: number; journals: number }>
      }

      const runSpy = vi
        .spyOn(bridgeInternal, 'runUnsyncedLocalDocsSync')
        .mockImplementation(async () => {
          await new Promise((resolve) => setTimeout(resolve, 25))
          return { notes: 2, journals: 1 }
        })

      // #when
      const [first, second] = await Promise.all([
        bridge.syncUnsyncedLocalDocs(),
        bridge.syncUnsyncedLocalDocs()
      ])

      // #then
      expect(runSpy).toHaveBeenCalledTimes(1)
      expect(first).toEqual({ notes: 2, journals: 1 })
      expect(second).toEqual({ notes: 2, journals: 1 })
    })

    it('clears pending snapshot IDs after successful snapshot push', async () => {
      // #given
      const { getNetworkMonitor } = await import('./network')
      vi.mocked(getNetworkMonitor).mockReturnValue({
        isOnline: () => true,
        on: vi.fn(),
        off: vi.fn()
      })

      const pushCrdtSnapshot = vi.fn().mockResolvedValue({
        noteId: 'note-1',
        sequenceNum: 3,
        storageType: 'd1',
        updatesPruned: 0
      })
      vi.mocked(getSyncApiClient).mockReturnValue({
        pushCrdtUpdates: vi.fn(),
        pullCrdtUpdates: vi.fn(),
        pullCrdtSnapshot: vi.fn(),
        pushCrdtSnapshot
      } as unknown as ReturnType<typeof getSyncApiClient>)

      const bridgeInternal = bridge as unknown as {
        pendingSnapshotIds: Set<string>
      }
      bridgeInternal.pendingSnapshotIds.add('note-1')

      // #when
      const pushed = await bridge.pushSnapshot('note-1', new Uint8Array([1, 2, 3]))

      // #then
      expect(pushed).toBe(true)
      expect(bridgeInternal.pendingSnapshotIds.has('note-1')).toBe(false)
    })
  })
})

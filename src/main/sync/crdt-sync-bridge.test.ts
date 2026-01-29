/**
 * Tests for crdt-sync-bridge.ts
 * Tests CRDT sync bridge functionality including journal sync.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('./api-client', () => ({
  getSyncApiClient: vi.fn(() => ({
    pushCrdtUpdates: vi.fn().mockResolvedValue({ success: true }),
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
  getNoteById: vi.fn().mockResolvedValue(null)
}))

vi.mock('../vault/journal', () => ({
  getJournalEntryById: vi.fn().mockResolvedValue(null)
}))

vi.mock('../crypto/keychain', () => ({
  retrieveDeviceKeyPair: vi.fn().mockResolvedValue({
    deviceId: 'test-device-123',
    publicKey: new Uint8Array(32),
    privateKey: new Uint8Array(64)
  })
}))

vi.mock('./token-refresh', () => ({
  refreshAccessToken: vi.fn().mockResolvedValue(true)
}))

import { CrdtSyncBridge } from './crdt-sync-bridge'
import type { CrdtProvider } from './crdt-provider'
import { getSyncQueue } from './queue'
import { getNoteById } from '../vault/notes'
import { getJournalEntryById } from '../vault/journal'

describe('CrdtSyncBridge', () => {
  let bridge: CrdtSyncBridge
  let mockCrdtProvider: Partial<CrdtProvider>

  beforeEach(() => {
    vi.clearAllMocks()

    mockCrdtProvider = {
      on: vi.fn(),
      off: vi.fn(),
      onDocUpdated: vi.fn(),
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
    it('T140f: detects valid journal ID format', () => {
      // #given - Access the private method via type assertion
      const isJournalId = (
        bridge as unknown as { isJournalId: (id: string) => boolean }
      ).isJournalId.bind(bridge)

      // #then
      expect(isJournalId('j2024-01-15')).toBe(true)
      expect(isJournalId('j2026-12-31')).toBe(true)
      expect(isJournalId('j1999-06-01')).toBe(true)
    })

    it('T140f: rejects invalid formats', () => {
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

  describe('syncJournalToServer', () => {
    it('T140f: queues journal entry with correct type', async () => {
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

      vi.mocked(getJournalEntryById).mockResolvedValueOnce(journalEntry)

      // #when
      const syncJournalToServer = (
        bridge as unknown as { syncJournalToServer: (id: string) => Promise<boolean> }
      ).syncJournalToServer.bind(bridge)
      const result = await syncJournalToServer('j2024-01-15')

      // #then
      expect(result).toBe(true)
      expect(getJournalEntryById).toHaveBeenCalledWith('j2024-01-15')

      const queue = getSyncQueue()
      expect(queue.add).toHaveBeenCalledWith(
        'journal',
        'j2024-01-15',
        'create',
        expect.stringContaining('"id":"j2024-01-15"'),
        10
      )
    })

    it('T140f: returns false when journal not found', async () => {
      // #given
      vi.mocked(getJournalEntryById).mockResolvedValueOnce(null)

      // #when
      const syncJournalToServer = (
        bridge as unknown as { syncJournalToServer: (id: string) => Promise<boolean> }
      ).syncJournalToServer.bind(bridge)
      const result = await syncJournalToServer('j2024-01-15')

      // #then
      expect(result).toBe(false)
    })
  })

  describe('ensureNoteSynced routing', () => {
    it('T140f: routes journal ID to syncJournalToServer', async () => {
      // #given
      const journalEntry = {
        id: 'j2024-01-15',
        date: '2024-01-15',
        content: 'Test',
        wordCount: 1,
        characterCount: 4,
        tags: [],
        createdAt: '2024-01-15T08:00:00.000Z',
        modifiedAt: '2024-01-15T10:00:00.000Z'
      }
      vi.mocked(getJournalEntryById).mockResolvedValueOnce(journalEntry)

      // #when
      const ensureNoteSynced = (
        bridge as unknown as { ensureNoteSynced: (id: string) => Promise<boolean> }
      ).ensureNoteSynced.bind(bridge)
      await ensureNoteSynced('j2024-01-15')

      // #then
      expect(getJournalEntryById).toHaveBeenCalledWith('j2024-01-15')
      expect(getNoteById).not.toHaveBeenCalled()
    })

    it('T140f: routes note ID to syncNoteToServer', async () => {
      // #given
      const note = {
        id: 'abc123',
        title: 'Test Note',
        path: 'notes/test.md',
        created: new Date('2024-01-15T08:00:00.000Z'),
        modified: new Date('2024-01-15T10:00:00.000Z')
      }
      vi.mocked(getNoteById).mockResolvedValueOnce(note)

      // #when
      const ensureNoteSynced = (
        bridge as unknown as { ensureNoteSynced: (id: string) => Promise<boolean> }
      ).ensureNoteSynced.bind(bridge)
      await ensureNoteSynced('abc123')

      // #then
      expect(getNoteById).toHaveBeenCalledWith('abc123')
      expect(getJournalEntryById).not.toHaveBeenCalled()
    })
  })
})

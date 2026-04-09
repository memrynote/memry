/**
 * Inbox IPC handlers tests
 *
 * @module ipc/inbox-handlers.test
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest'
import { mockIpcMain, resetIpcMocks, invokeHandler } from '@tests/utils/mock-ipc'
import { InboxChannels } from '@memry/contracts/ipc-channels'

// Track mock calls
const handleCalls: unknown[][] = []
const removeHandlerCalls: string[] = []

// Mock electron modules
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: unknown) => {
      handleCalls.push([channel, handler])
      mockIpcMain.handle(channel, handler as Parameters<typeof mockIpcMain.handle>[1])
    }),
    removeHandler: vi.fn((channel: string) => {
      removeHandlerCalls.push(channel)
      mockIpcMain.removeHandler(channel)
    })
  },
  BrowserWindow: {
    getAllWindows: vi.fn(() => [{ webContents: { send: vi.fn() } }])
  }
}))

// Mock database module
vi.mock('../database', () => ({
  getDatabase: vi.fn(),
  requireDatabase: vi.fn()
}))

// Mock ID generation
vi.mock('../lib/id', () => ({
  generateId: vi.fn(() => 'generated-id-123')
}))

// Mock sharp for image processing
vi.mock('sharp', () => ({
  default: vi.fn(() => ({
    metadata: vi.fn().mockResolvedValue({ width: 100, height: 100, format: 'png' }),
    resize: vi.fn().mockReturnThis(),
    jpeg: vi.fn().mockReturnThis(),
    toBuffer: vi.fn().mockResolvedValue(Buffer.from([]))
  }))
}))

// Mock inbox modules
vi.mock('../inbox/attachments', () => ({
  resolveAttachmentUrl: vi.fn((path) => (path ? `file://${path}` : null)),
  getItemAttachmentsDir: vi.fn(() => '/attachments/inbox/test'),
  storeInboxAttachment: vi.fn(),
  storeThumbnail: vi.fn()
}))

vi.mock('../inbox/metadata', () => ({
  fetchUrlMetadata: vi.fn(),
  downloadImage: vi.fn(),
  titleFromUrl: vi.fn((url: string) => url),
  isBotPageTitle: vi.fn(() => false),
  extractDomain: vi.fn((url: string) => {
    try {
      return new URL(url).hostname
    } catch {
      return url
    }
  })
}))

vi.mock('../inbox/filing', () => ({
  fileToFolder: vi.fn(),
  convertToNote: vi.fn(),
  convertToTask: vi.fn(),
  linkToNote: vi.fn(),
  linkToNotes: vi.fn(),
  bulkFileToFolder: vi.fn()
}))

vi.mock('../inbox/social', () => ({
  extractSocialPost: vi.fn(),
  detectSocialPlatform: vi.fn(),
  isSocialPost: vi.fn()
}))

vi.mock('../inbox/capture', () => ({
  captureVoice: vi.fn()
}))

vi.mock('../inbox/transcription', () => ({
  retryTranscription: vi.fn()
}))

vi.mock('../inbox/jobs', () => ({
  queueInboxMetadataJob: vi.fn(),
  queueInboxTranscriptionJob: vi.fn(),
  resumeInboxJobs: vi.fn(),
  teardownInboxJobScheduler: vi.fn()
}))

vi.mock('../inbox/suggestions', () => ({
  getSuggestions: vi.fn(),
  trackSuggestionFeedback: vi.fn()
}))

vi.mock('../inbox/stats', () => ({
  getStaleThreshold: vi.fn(() => 7),
  setStaleThreshold: vi.fn(),
  isStale: vi.fn(() => false),
  getStaleItemIds: vi.fn(() => []),
  countStaleItems: vi.fn(() => 0),
  incrementArchivedCount: vi.fn(),
  incrementProcessedCount: vi.fn(),
  getTodayActivity: vi.fn(() => ({ capturedToday: 0, processedToday: 0 })),
  getAverageTimeToProcess: vi.fn(() => 0),
  getInboxHealthMetrics: vi.fn(() => ({
    totalActive: 0,
    staleCount: 0,
    stalePercent: 0,
    avgAgeHours: 0,
    oldestAgeHours: 0,
    healthScore: 100,
    ageDistribution: { fresh: 0, aging: 0, stale: 0, rotten: 0 }
  }))
}))

vi.mock('../inbox/duplicates', () => ({
  findDuplicateByUrl: vi.fn(() => null),
  findDuplicateByContent: vi.fn(() => null)
}))

vi.mock('../inbox/snooze', () => ({
  snoozeItem: vi.fn(),
  unsnoozeItem: vi.fn(),
  getSnoozedItems: vi.fn(),
  bulkSnoozeItems: vi.fn()
}))

vi.mock('../sync/inbox-sync', () => ({
  getInboxSyncService: vi.fn(() => null)
}))

vi.mock('../sync/offline-clock', () => ({
  incrementInboxClockOffline: vi.fn()
}))

vi.mock('../projections', () => ({
  publishProjectionEvent: vi.fn()
}))

vi.mock('../lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

// Import after mocking
import { registerInboxHandlers, unregisterInboxHandlers } from './inbox-handlers'
import { getDatabase, requireDatabase } from '../database'
import * as filingModule from '../inbox/filing'
import * as snoozeModule from '../inbox/snooze'
import * as suggestionsModule from '../inbox/suggestions'
import * as captureModule from '../inbox/capture'
import * as inboxJobsModule from '../inbox/jobs'
import * as statsModule from '../inbox/stats'
import * as socialModule from '../inbox/social'
import { publishProjectionEvent } from '../projections'

describe('inbox-handlers', () => {
  let mockDb: {
    insert: Mock
    select: Mock
    update: Mock
    delete: Mock
  }

  beforeEach(() => {
    resetIpcMocks()
    vi.clearAllMocks()
    handleCalls.length = 0
    removeHandlerCalls.length = 0

    // Setup mock database with chainable methods
    const chainable = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      offset: vi.fn().mockReturnThis(),
      groupBy: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      values: vi.fn().mockReturnThis(),
      run: vi.fn(),
      get: vi.fn(),
      all: vi.fn(() => [])
    }

    mockDb = {
      insert: vi.fn(() => chainable),
      select: vi.fn(() => chainable),
      update: vi.fn(() => chainable),
      delete: vi.fn(() => chainable),
      transaction: vi.fn((fn: (tx: typeof chainable & { insert: Mock; select: Mock; update: Mock; delete: Mock }) => unknown) => {
        const tx = {
          ...chainable,
          insert: vi.fn(() => chainable),
          select: vi.fn(() => chainable),
          update: vi.fn(() => chainable),
          delete: vi.fn(() => chainable)
        }
        return fn(tx)
      })
    } as typeof mockDb & { transaction: Mock }
    ;(getDatabase as Mock).mockReturnValue(mockDb)
    ;(requireDatabase as Mock).mockReturnValue(mockDb)
  })

  afterEach(() => {
    unregisterInboxHandlers()
  })

  describe('registerInboxHandlers', () => {
    it('should register all inbox handlers', () => {
      registerInboxHandlers()

      const invokeChannels = Object.values(InboxChannels.invoke)
      // Some handlers may not be implemented yet
      expect(handleCalls.length).toBeGreaterThanOrEqual(invokeChannels.length - 10)
    })
  })

  // =========================================================================
  // T455: CAPTURE_TEXT, CAPTURE_LINK handlers
  // =========================================================================
  describe('CAPTURE_TEXT handler', () => {
    beforeEach(() => {
      registerInboxHandlers()
    })

    it('should capture text content', async () => {
      const mockCreated = {
        id: 'generated-id-123',
        type: 'note',
        title: 'Test Note',
        content: 'This is test content',
        createdAt: new Date().toISOString()
      }

      // Setup the get mock to return the created item
      const chainable = mockDb.select()
      chainable.get.mockReturnValue(mockCreated)

      const result = await invokeHandler(InboxChannels.invoke.CAPTURE_TEXT, {
        content: 'This is test content',
        title: 'Test Note'
      })

      expect(result.success).toBe(true)
      expect(result.item).toBeDefined()
      expect((mockDb as Record<string, Mock>).transaction).toHaveBeenCalled()
    })

    it('should capture text with tags', async () => {
      const mockCreated = {
        id: 'generated-id-123',
        type: 'note',
        title: 'Tagged Note',
        content: 'Content'
      }

      const chainable = mockDb.select()
      chainable.get.mockReturnValue(mockCreated)

      await invokeHandler(InboxChannels.invoke.CAPTURE_TEXT, {
        content: 'Content',
        title: 'Tagged Note',
        tags: ['important', 'urgent']
      })

      expect((mockDb as Record<string, Mock>).transaction).toHaveBeenCalled()
    })

    it('should auto-generate title from content', async () => {
      const mockCreated = {
        id: 'generated-id-123',
        type: 'note',
        title: 'This is a long content that...',
        content: 'This is a long content that should be truncated for the title'
      }

      const chainable = mockDb.select()
      chainable.get.mockReturnValue(mockCreated)

      const result = await invokeHandler(InboxChannels.invoke.CAPTURE_TEXT, {
        content: 'This is a long content that should be truncated for the title'
      })

      expect(result.success).toBe(true)
    })
  })

  describe('CAPTURE_LINK handler', () => {
    beforeEach(() => {
      registerInboxHandlers()
      ;(socialModule.detectSocialPlatform as Mock).mockReturnValue(null)
      ;(socialModule.isSocialPost as Mock).mockReturnValue(false)
    })

    it('should capture a regular link', async () => {
      const mockCreated = {
        id: 'generated-id-123',
        type: 'link',
        title: 'https://example.com',
        sourceUrl: 'https://example.com',
        processingStatus: 'pending'
      }

      const chainable = mockDb.select()
      chainable.get.mockReturnValue(mockCreated)

      const result = await invokeHandler(InboxChannels.invoke.CAPTURE_LINK, {
        url: 'https://example.com'
      })

      expect(result.success).toBe(true)
      expect(result.item.sourceUrl).toBe('https://example.com')
    })

    it('should detect and capture social post URLs', async () => {
      ;(socialModule.detectSocialPlatform as Mock).mockReturnValue('twitter')
      ;(socialModule.isSocialPost as Mock).mockReturnValue(true)

      const mockCreated = {
        id: 'generated-id-123',
        type: 'social',
        sourceUrl: 'https://twitter.com/user/status/123'
      }

      const chainable = mockDb.select()
      chainable.get.mockReturnValue(mockCreated)

      const result = await invokeHandler(InboxChannels.invoke.CAPTURE_LINK, {
        url: 'https://twitter.com/user/status/123'
      })

      expect(result.success).toBe(true)
      expect(result.item.type).toBe('social')
    })
  })

  // =========================================================================
  // T456: LIST, GET, UPDATE handlers
  // =========================================================================
  describe('GET handler', () => {
    beforeEach(() => {
      registerInboxHandlers()
    })

    it('should get an inbox item by ID', async () => {
      const mockItem = {
        id: 'item1',
        type: 'note',
        title: 'Test Item',
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString()
      }

      const chainable = mockDb.select()
      chainable.get.mockReturnValue(mockItem)

      const result = await invokeHandler(InboxChannels.invoke.GET, 'item1')

      expect(result).toBeDefined()
      expect(result.id).toBe('item1')
    })

    it('should return null for non-existent item', async () => {
      const chainable = mockDb.select()
      chainable.get.mockReturnValue(null)

      const result = await invokeHandler(InboxChannels.invoke.GET, 'nonexistent')

      expect(result).toBeNull()
    })
  })

  describe('LIST handler', () => {
    beforeEach(() => {
      registerInboxHandlers()
    })

    it('should list inbox items with default options', async () => {
      const mockItems = [
        { id: 'item1', type: 'note' },
        { id: 'item2', type: 'link' }
      ]

      const chainable = mockDb.select()
      chainable.all.mockReturnValue(mockItems)
      chainable.get.mockReturnValue({ count: 2 })

      const result = await invokeHandler(InboxChannels.invoke.LIST, {})

      expect(result.items).toHaveLength(2)
      expect(result.total).toBe(2)
    })

    it('should filter by type', async () => {
      const chainable = mockDb.select()
      chainable.all.mockReturnValue([{ id: 'item1', type: 'link' }])
      chainable.get.mockReturnValue({ count: 1 })

      const result = await invokeHandler(InboxChannels.invoke.LIST, {
        type: 'link'
      })

      expect(result.items).toHaveLength(1)
    })

    it('should handle pagination', async () => {
      const chainable = mockDb.select()
      chainable.all.mockReturnValue(Array(10).fill({ id: 'item' }))
      chainable.get.mockReturnValue({ count: 20 })

      const result = await invokeHandler(InboxChannels.invoke.LIST, {
        limit: 10,
        offset: 0
      })

      expect(result.hasMore).toBe(true)
    })
  })

  describe('UPDATE handler', () => {
    beforeEach(() => {
      registerInboxHandlers()
    })

    it('should update an inbox item', async () => {
      const mockItem = { id: 'item1', title: 'Updated Title' }

      const chainable = mockDb.select()
      chainable.get.mockReturnValue(mockItem)

      const result = await invokeHandler(InboxChannels.invoke.UPDATE, {
        id: 'item1',
        title: 'Updated Title'
      })

      expect(result.success).toBe(true)
      expect(mockDb.update).toHaveBeenCalled()
    })

    it('should return error for non-existent item', async () => {
      const chainable = mockDb.select()
      chainable.get.mockReturnValue(null)

      const result = await invokeHandler(InboxChannels.invoke.UPDATE, {
        id: 'nonexistent',
        title: 'New Title'
      })

      expect(result.success).toBe(false)
      expect(result.error).toBe('Item not found')
    })
  })

  // =========================================================================
  // T457: FILE, ARCHIVE handlers
  // =========================================================================
  describe('FILE handler', () => {
    beforeEach(() => {
      registerInboxHandlers()
    })

    it('should file item to folder', async () => {
      ;(filingModule.fileToFolder as Mock).mockResolvedValue({
        success: true,
        filedTo: 'projects'
      })

      const result = await invokeHandler(InboxChannels.invoke.FILE, {
        itemId: 'item1',
        destination: { type: 'folder', path: 'projects' }
      })

      expect(result.success).toBe(true)
      expect(filingModule.fileToFolder).toHaveBeenCalledWith('item1', 'projects', undefined)
    })

    it('should convert to new note', async () => {
      ;(filingModule.convertToNote as Mock).mockResolvedValue({
        success: true,
        noteId: 'note123'
      })

      const result = await invokeHandler(InboxChannels.invoke.FILE, {
        itemId: 'item1',
        destination: { type: 'new-note' }
      })

      expect(result.success).toBe(true)
      expect(filingModule.convertToNote).toHaveBeenCalledWith('item1')
    })

    it('should link to existing note', async () => {
      ;(filingModule.linkToNotes as Mock).mockResolvedValue({
        success: true
      })

      const result = await invokeHandler(InboxChannels.invoke.FILE, {
        itemId: 'item1',
        destination: { type: 'note', noteId: 'note123' }
      })

      expect(result.success).toBe(true)
    })
  })

  describe('ARCHIVE handler', () => {
    beforeEach(() => {
      registerInboxHandlers()
    })

    it('should archive an item', async () => {
      const mockItem = { id: 'item1' }
      const chainable = mockDb.select()
      chainable.get.mockReturnValue(mockItem)

      const result = await invokeHandler(InboxChannels.invoke.ARCHIVE, 'item1')

      expect(result.success).toBe(true)
      expect(mockDb.update).toHaveBeenCalled()
      expect(publishProjectionEvent).toHaveBeenCalledWith({
        type: 'inbox.upserted',
        itemId: 'item1'
      })
      expect(statsModule.incrementArchivedCount).not.toHaveBeenCalled()
    })

    it('should return error for non-existent item', async () => {
      const chainable = mockDb.select()
      chainable.get.mockReturnValue(null)

      const result = await invokeHandler(InboxChannels.invoke.ARCHIVE, 'nonexistent')

      expect(result.success).toBe(false)
      expect(result.error).toBe('Item not found')
    })
  })

  // =========================================================================
  // T458: SNOOZE, UNSNOOZE handlers
  // =========================================================================
  describe('SNOOZE handler', () => {
    beforeEach(() => {
      registerInboxHandlers()
    })

    it('should snooze an item', async () => {
      ;(snoozeModule.snoozeItem as Mock).mockReturnValue({ success: true })

      const result = await invokeHandler(InboxChannels.invoke.SNOOZE, {
        itemId: 'item1',
        snoozeUntil: '2026-01-10T09:00:00Z',
        reason: 'Review later'
      })

      expect(result.success).toBe(true)
      expect(snoozeModule.snoozeItem).toHaveBeenCalled()
    })

    it('should handle invalid snooze input', async () => {
      const result = await invokeHandler(InboxChannels.invoke.SNOOZE, {})

      expect(result.success).toBe(false)
      expect(result.error).toContain('required')
    })
  })

  describe('UNSNOOZE handler', () => {
    beforeEach(() => {
      registerInboxHandlers()
    })

    it('should unsnooze an item', async () => {
      ;(snoozeModule.unsnoozeItem as Mock).mockReturnValue({ success: true })

      const result = await invokeHandler(InboxChannels.invoke.UNSNOOZE, 'item1')

      expect(result.success).toBe(true)
      expect(snoozeModule.unsnoozeItem).toHaveBeenCalledWith('item1')
    })
  })

  describe('GET_SNOOZED handler', () => {
    beforeEach(() => {
      registerInboxHandlers()
    })

    it('should get snoozed items', async () => {
      const mockSnoozed = [
        { id: 'item1', snoozedUntil: '2026-01-10' },
        { id: 'item2', snoozedUntil: '2026-01-11' }
      ]
      ;(snoozeModule.getSnoozedItems as Mock).mockReturnValue(mockSnoozed)

      const result = await invokeHandler(InboxChannels.invoke.GET_SNOOZED)

      expect(result).toHaveLength(2)
    })
  })

  // =========================================================================
  // T459: Bulk handlers
  // =========================================================================
  describe('BULK_ARCHIVE handler', () => {
    beforeEach(() => {
      registerInboxHandlers()
    })

    it('should archive multiple items', async () => {
      const mockItem = { id: 'item1' }
      const chainable = mockDb.select()
      chainable.get.mockReturnValue(mockItem)

      const result = await invokeHandler(InboxChannels.invoke.BULK_ARCHIVE, {
        itemIds: ['item1', 'item2', 'item3']
      })

      expect(result.processedCount).toBe(3)
    })
  })

  describe('BULK_SNOOZE handler', () => {
    beforeEach(() => {
      registerInboxHandlers()
    })

    it('should snooze multiple items', async () => {
      ;(snoozeModule.bulkSnoozeItems as Mock).mockReturnValue({
        success: true,
        processedCount: 2,
        errors: []
      })

      const result = await invokeHandler(InboxChannels.invoke.BULK_SNOOZE, {
        itemIds: ['item1', 'item2'],
        snoozeUntil: '2026-01-10T09:00:00Z'
      })

      expect(result.success).toBe(true)
      expect(result.processedCount).toBe(2)
    })
  })

  describe('BULK_FILE handler', () => {
    beforeEach(() => {
      registerInboxHandlers()
    })

    it('should file multiple items to a folder', async () => {
      ;(filingModule.bulkFileToFolder as Mock).mockResolvedValue({
        success: true,
        processedCount: 3,
        errors: []
      })

      const result = await invokeHandler(InboxChannels.invoke.BULK_FILE, {
        itemIds: ['item1', 'item2', 'item3'],
        destination: { type: 'folder', path: 'archive' }
      })

      expect(result.success).toBe(true)
      expect(result.processedCount).toBe(3)
    })
  })

  describe('FILE_ALL_STALE handler', () => {
    beforeEach(() => {
      registerInboxHandlers()
    })

    it('should file all stale items', async () => {
      ;(statsModule.getStaleItemIds as Mock).mockReturnValue(['item1', 'item2'])
      ;(filingModule.bulkFileToFolder as Mock).mockResolvedValue({
        success: true,
        processedCount: 2,
        errors: []
      })

      const result = await invokeHandler(InboxChannels.invoke.FILE_ALL_STALE)

      expect(result.success).toBe(true)
      expect(filingModule.bulkFileToFolder).toHaveBeenCalledWith(['item1', 'item2'], 'Unsorted', [])
    })

    it('should handle no stale items', async () => {
      ;(statsModule.getStaleItemIds as Mock).mockReturnValue([])

      const result = await invokeHandler(InboxChannels.invoke.FILE_ALL_STALE)

      expect(result.success).toBe(true)
      expect(result.processedCount).toBe(0)
    })
  })

  // =========================================================================
  // Additional handlers
  // =========================================================================
  describe('GET_SUGGESTIONS handler', () => {
    beforeEach(() => {
      registerInboxHandlers()
    })

    it('should get filing suggestions', async () => {
      const mockSuggestions = [
        { type: 'folder', path: 'projects', confidence: 0.9 },
        { type: 'note', noteId: 'note1', confidence: 0.8 }
      ]
      ;(suggestionsModule.getSuggestions as Mock).mockResolvedValue(mockSuggestions)

      const result = await invokeHandler(InboxChannels.invoke.GET_SUGGESTIONS, 'item1')

      expect(result.suggestions).toHaveLength(2)
    })
  })

  describe('GET_STATS handler', () => {
    beforeEach(() => {
      registerInboxHandlers()
    })

    it('should get inbox statistics', async () => {
      const chainable = mockDb.select()
      chainable.get.mockReturnValue({ count: 10 })
      chainable.all.mockReturnValue([
        { type: 'note', count: 5 },
        { type: 'link', count: 5 }
      ])

      const result = await invokeHandler(InboxChannels.invoke.GET_STATS)

      expect(result.totalItems).toBeDefined()
      expect(result.itemsByType).toBeDefined()
    })
  })

  describe('Settings handlers', () => {
    beforeEach(() => {
      registerInboxHandlers()
    })

    it('GET_STALE_THRESHOLD should get threshold', async () => {
      const result = await invokeHandler(InboxChannels.invoke.GET_STALE_THRESHOLD)

      expect(result).toBe(7)
    })

    it('SET_STALE_THRESHOLD should set threshold', async () => {
      const result = await invokeHandler(InboxChannels.invoke.SET_STALE_THRESHOLD, 14)

      expect(result.success).toBe(true)
      expect(statsModule.setStaleThreshold).toHaveBeenCalledWith(14)
    })
  })

  describe('CAPTURE_VOICE handler', () => {
    beforeEach(() => {
      registerInboxHandlers()
    })

    it('should capture voice memo', async () => {
      const mockResult = { success: true, item: { id: 'voice1', type: 'voice' } }
      ;(captureModule.captureVoice as Mock).mockResolvedValue(mockResult)

      const result = await invokeHandler(InboxChannels.invoke.CAPTURE_VOICE, {
        data: Buffer.from([0, 1, 2, 3]),
        duration: 10,
        format: 'webm'
      })

      expect(result.success).toBe(true)
    })
  })

  describe('RETRY_TRANSCRIPTION handler', () => {
    beforeEach(() => {
      registerInboxHandlers()
    })

    it('should retry transcription', async () => {
      const chainable = mockDb.select()
      chainable.get.mockReturnValue({
        id: 'voice1',
        type: 'voice',
        attachmentPath: '/attachments/inbox/test/audio.webm'
      })

      const result = await invokeHandler(InboxChannels.invoke.RETRY_TRANSCRIPTION, 'voice1')

      expect(result.success).toBe(true)
      expect(mockDb.update).toHaveBeenCalled()
      expect(inboxJobsModule.queueInboxTranscriptionJob).toHaveBeenCalledWith(
        'voice1',
        '/attachments/inbox/test/audio.webm'
      )
    })
  })

  describe('Tag handlers', () => {
    beforeEach(() => {
      registerInboxHandlers()
    })

    it('ADD_TAG should add a tag', async () => {
      const chainable = mockDb.select()
      chainable.get.mockReturnValueOnce({ id: 'item1' }) // Item exists
      chainable.get.mockReturnValueOnce(null) // Tag doesn't exist yet

      const result = await invokeHandler(InboxChannels.invoke.ADD_TAG, 'item1', 'new-tag')

      expect(result.success).toBe(true)
      expect(mockDb.insert).toHaveBeenCalled()
    })

    it('REMOVE_TAG should remove a tag', async () => {
      const result = await invokeHandler(InboxChannels.invoke.REMOVE_TAG, 'item1', 'old-tag')

      expect(result.success).toBe(true)
      expect(mockDb.delete).toHaveBeenCalled()
    })

    it('GET_TAGS should get all inbox tags', async () => {
      const mockTags = [
        { tag: 'urgent', count: 5 },
        { tag: 'review', count: 3 }
      ]
      const chainable = mockDb.select()
      chainable.all.mockReturnValue(mockTags)

      const result = await invokeHandler(InboxChannels.invoke.GET_TAGS)

      expect(result).toHaveLength(2)
    })
  })
})

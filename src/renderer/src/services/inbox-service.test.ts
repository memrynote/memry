import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { createMockApi } from '@tests/setup-dom'
import {
  inboxService,
  onInboxCaptured,
  onInboxUpdated,
  onInboxArchived,
  onInboxFiled,
  onInboxSnoozed,
  onInboxSnoozeDue,
  onInboxTranscriptionComplete,
  onInboxMetadataComplete,
  onInboxProcessingError,
  getInboxItemIcon,
  getInboxItemColor,
  formatRelativeTime,
  isItemStale
} from './inbox-service'

describe('inbox-service', () => {
  let api: any

  beforeEach(() => {
    api = createMockApi()

    api.inbox.captureText = vi.fn().mockResolvedValue({ success: true })
    api.inbox.captureLink = vi.fn().mockResolvedValue({ success: true })
    api.inbox.captureImage = vi.fn().mockResolvedValue({ success: true })
    api.inbox.file = vi.fn().mockResolvedValue({ success: true })
    api.inbox.snooze = vi.fn().mockResolvedValue({ success: true })
    api.inbox.retryMetadata = vi.fn().mockResolvedValue({ success: true })
    api.inbox.bulkFile = vi.fn().mockResolvedValue({ success: true, results: [] })
    api.inbox.bulkArchive = vi.fn().mockResolvedValue({ success: true, results: [] })
    api.inbox.bulkTag = vi.fn().mockResolvedValue({ success: true, results: [] })
    api.inbox.getStats = vi.fn().mockResolvedValue({ total: 0 })
    api.inbox.getPatterns = vi.fn().mockResolvedValue({})
    api.inbox.setStaleThreshold = vi.fn().mockResolvedValue({ success: true })

    api.onInboxCaptured = vi.fn().mockReturnValue(() => {})
    api.onInboxUpdated = vi.fn().mockReturnValue(() => {})
    api.onInboxArchived = vi.fn().mockReturnValue(() => {})
    api.onInboxFiled = vi.fn().mockReturnValue(() => {})
    api.onInboxSnoozed = vi.fn().mockReturnValue(() => {})
    api.onInboxSnoozeDue = vi.fn().mockReturnValue(() => {})
    api.onInboxTranscriptionComplete = vi.fn().mockReturnValue(() => {})
    api.onInboxMetadataComplete = vi.fn().mockReturnValue(() => {})
    api.onInboxProcessingError = vi.fn().mockReturnValue(() => {})
    ;(window as Window & { api: unknown }).api = api
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('forwards capture, file, and snooze operations', async () => {
    await inboxService.captureText({ content: 'Hello' })
    expect(api.inbox.captureText).toHaveBeenCalledWith({ content: 'Hello' })

    await inboxService.captureLink({ url: 'https://example.com' })
    expect(api.inbox.captureLink).toHaveBeenCalledWith({ url: 'https://example.com' })

    const imageData = new ArrayBuffer(8)
    await inboxService.captureImage({ data: imageData, filename: 'img.png', mimeType: 'image/png' })
    expect(api.inbox.captureImage).toHaveBeenCalledWith({
      data: imageData,
      filename: 'img.png',
      mimeType: 'image/png'
    })

    await inboxService.file({
      itemId: 'item-1',
      destination: { type: 'folder', path: 'projects' }
    })
    expect(api.inbox.file).toHaveBeenCalledWith({
      itemId: 'item-1',
      destination: { type: 'folder', path: 'projects' }
    })

    await inboxService.snooze({ itemId: 'item-2', snoozeUntil: '2025-01-02' })
    expect(api.inbox.snooze).toHaveBeenCalledWith({ itemId: 'item-2', snoozeUntil: '2025-01-02' })

    await inboxService.retryMetadata('item-3')
    expect(api.inbox.retryMetadata).toHaveBeenCalledWith('item-3')
  })

  it('forwards bulk and stats operations', async () => {
    await inboxService.bulkFile({
      itemIds: ['item-1'],
      destination: { type: 'note', noteId: 'note-1' }
    })
    expect(api.inbox.bulkFile).toHaveBeenCalledWith({
      itemIds: ['item-1'],
      destination: { type: 'note', noteId: 'note-1' }
    })

    await inboxService.bulkArchive({ itemIds: ['item-2', 'item-3'] })
    expect(api.inbox.bulkArchive).toHaveBeenCalledWith({ itemIds: ['item-2', 'item-3'] })

    await inboxService.bulkTag({ itemIds: ['item-4'], tags: ['tag'] })
    expect(api.inbox.bulkTag).toHaveBeenCalledWith({ itemIds: ['item-4'], tags: ['tag'] })

    await inboxService.getStats()
    expect(api.inbox.getStats).toHaveBeenCalled()

    await inboxService.getPatterns()
    expect(api.inbox.getPatterns).toHaveBeenCalled()

    await inboxService.setStaleThreshold(14)
    expect(api.inbox.setStaleThreshold).toHaveBeenCalledWith(14)
  })

  it('registers inbox event subscriptions', () => {
    const unsubscribe = vi.fn()
    api.onInboxCaptured = vi.fn(() => unsubscribe)
    api.onInboxUpdated = vi.fn(() => unsubscribe)
    api.onInboxArchived = vi.fn(() => unsubscribe)
    api.onInboxFiled = vi.fn(() => unsubscribe)
    api.onInboxSnoozed = vi.fn(() => unsubscribe)
    api.onInboxSnoozeDue = vi.fn(() => unsubscribe)
    api.onInboxTranscriptionComplete = vi.fn(() => unsubscribe)
    api.onInboxMetadataComplete = vi.fn(() => unsubscribe)
    api.onInboxProcessingError = vi.fn(() => unsubscribe)

    expect(onInboxCaptured(vi.fn())).toBe(unsubscribe)
    expect(onInboxUpdated(vi.fn())).toBe(unsubscribe)
    expect(onInboxArchived(vi.fn())).toBe(unsubscribe)
    expect(onInboxFiled(vi.fn())).toBe(unsubscribe)
    expect(onInboxSnoozed(vi.fn())).toBe(unsubscribe)
    expect(onInboxSnoozeDue(vi.fn())).toBe(unsubscribe)
    expect(onInboxTranscriptionComplete(vi.fn())).toBe(unsubscribe)
    expect(onInboxMetadataComplete(vi.fn())).toBe(unsubscribe)
    expect(onInboxProcessingError(vi.fn())).toBe(unsubscribe)
  })

  it('returns expected utility outputs', () => {
    expect(getInboxItemIcon('link')).toBe('Link')
    expect(getInboxItemColor('image')).toBe('text-purple-500')

    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'))

    expect(formatRelativeTime('2025-01-01T00:00:00Z')).toBe('just now')
    expect(formatRelativeTime('2024-12-31T22:00:00Z')).toBe('2h ago')

    expect(isItemStale('2024-12-20T00:00:00Z', 7)).toBe(true)
    expect(isItemStale('2024-12-31T00:00:00Z', 7)).toBe(false)
  })
})

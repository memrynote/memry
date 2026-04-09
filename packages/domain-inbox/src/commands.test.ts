import { describe, expect, test, vi } from 'vitest'
import {
  createInboxCommands,
  type InboxCommandServices,
  type InboxItem
} from './index.ts'

function createItem(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    id: 'item-1',
    type: 'link',
    title: 'Title',
    content: null,
    createdAt: new Date('2026-04-09T10:00:00.000Z'),
    modifiedAt: new Date('2026-04-09T10:00:00.000Z'),
    filedAt: null,
    filedTo: null,
    filedAction: null,
    snoozedUntil: null,
    snoozeReason: null,
    viewedAt: null,
    archivedAt: null,
    processingStatus: 'pending',
    processingError: null,
    metadata: null,
    attachmentPath: null,
    attachmentUrl: null,
    thumbnailPath: null,
    thumbnailUrl: null,
    transcription: null,
    transcriptionStatus: null,
    sourceUrl: 'https://example.com',
    sourceTitle: null,
    captureSource: 'quick-capture',
    tags: [],
    isStale: false,
    ...overrides
  }
}

function createServices(overrides: Partial<InboxCommandServices> = {}): InboxCommandServices {
  return {
    findDuplicateByContent: vi.fn(() => null),
    findDuplicateByUrl: vi.fn(() => null),
    captureTextItem: vi.fn(async () => ({ success: true, item: createItem({ type: 'note' }) })),
    captureLinkItem: vi.fn(async () => ({ success: true, item: createItem() })),
    captureImageItem: vi.fn(async () => ({ success: true, item: createItem({ type: 'image' }) })),
    captureVoiceItem: vi.fn(async () => ({ success: true, item: createItem({ type: 'voice' }) })),
    isSocialPost: vi.fn(() => false),
    detectSocialPlatform: vi.fn(() => null),
    storeSocialMetadata: vi.fn(),
    queueMetadataJob: vi.fn(),
    getSuggestions: vi.fn(async () => []),
    trackSuggestionFeedback: vi.fn(),
    fileToFolder: vi.fn(async () => ({ success: true, filedTo: 'Folder/Note.md' })),
    convertToNote: vi.fn(async () => ({ success: true, filedTo: 'Inbox Note.md', noteId: 'note-1' })),
    convertToTask: vi.fn(async () => ({ success: true, taskId: 'task-1' })),
    linkToNote: vi.fn(async () => ({ success: true })),
    linkToNotes: vi.fn(async () => ({ success: true })),
    snoozeItem: vi.fn(() => ({ success: true })),
    unsnoozeItem: vi.fn(() => ({ success: true })),
    getSnoozedItems: vi.fn(async () => []),
    getItem: vi.fn(() => createItem()),
    markTranscriptionPending: vi.fn(() => ({ success: true })),
    markMetadataPending: vi.fn(() => ({ success: true })),
    queueTranscriptionJob: vi.fn(),
    reportError: vi.fn(),
    ...overrides
  }
}

describe('createInboxCommands', () => {
  test('captureText returns an existing duplicate before creating a new item', async () => {
    const services = createServices({
      findDuplicateByContent: vi.fn(() => ({
        id: 'existing-1',
        title: 'Existing',
        createdAt: '2026-04-08T12:00:00.000Z'
      }))
    })
    const commands = createInboxCommands(services)

    await expect(commands.captureText({ content: 'duplicate text' })).resolves.toEqual({
      success: true,
      item: null,
      duplicate: true,
      existingItem: {
        id: 'existing-1',
        title: 'Existing',
        createdAt: '2026-04-08T12:00:00.000Z'
      }
    })
    expect(services.captureTextItem).not.toHaveBeenCalled()
  })

  test('captureLink stores social metadata immediately for social posts', async () => {
    const services = createServices({
      isSocialPost: vi.fn(() => true),
      detectSocialPlatform: vi.fn<(url: string) => 'twitter' | 'other' | null>(() => 'twitter'),
      captureLinkItem: vi.fn(async () => ({
        success: true,
        item: createItem({ id: 'social-1', type: 'social' })
      }))
    })
    const commands = createInboxCommands(services)

    await commands.captureLink({ url: 'https://x.com/example/status/1' })

    expect(services.captureLinkItem).toHaveBeenCalled()
    expect(services.storeSocialMetadata).toHaveBeenCalledWith(
      'social-1',
      'https://x.com/example/status/1'
    )
    expect(services.queueMetadataJob).not.toHaveBeenCalled()
  })

  test('fileItem requires at least one note id when linking to existing notes', async () => {
    const services = createServices()
    const commands = createInboxCommands(services)

    await expect(
      commands.fileItem({
        itemId: 'item-1',
        destination: { type: 'note' }
      })
    ).resolves.toEqual({
      success: false,
      filedTo: null,
      error: 'At least one note ID required for linking'
    })
    expect(services.linkToNotes).not.toHaveBeenCalled()
  })

  test('retryMetadata validates link state before scheduling a metadata job', async () => {
    const services = createServices({
      getItem: vi.fn(() =>
        createItem({
          id: 'link-1',
          type: 'link',
          sourceUrl: 'https://example.com/article'
        })
      )
    })
    const commands = createInboxCommands(services)

    await expect(commands.retryMetadata('link-1')).resolves.toEqual({ success: true })
    expect(services.markMetadataPending).toHaveBeenCalledWith('link-1')
    expect(services.queueMetadataJob).toHaveBeenCalledWith('link-1', 'https://example.com/article')
  })

  test('retryTranscription validates voice attachments before scheduling a retry', async () => {
    const services = createServices({
      getItem: vi.fn(() =>
        createItem({
          id: 'voice-1',
          type: 'voice',
          attachmentPath: 'attachments/inbox/voice-1/audio.webm'
        })
      )
    })
    const commands = createInboxCommands(services)

    await expect(commands.retryTranscription('voice-1')).resolves.toEqual({ success: true })
    expect(services.markTranscriptionPending).toHaveBeenCalledWith('voice-1')
    expect(services.queueTranscriptionJob).toHaveBeenCalledWith(
      'voice-1',
      'attachments/inbox/voice-1/audio.webm'
    )
  })
})

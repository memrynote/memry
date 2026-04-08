import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { InboxChannels } from '@memry/contracts/ipc-channels'
import { inboxItems, inboxItemTags } from '@memry/db-schema/schema/inbox'
import {
  createTestDatabase,
  cleanupTestDatabase,
  type TestDatabaseResult
} from '@tests/utils/test-db'
import { MockBrowserWindow } from '@tests/utils/mock-electron'
import { BrowserWindow } from 'electron'

const mockStoreInboxAttachment = vi.hoisted(() => vi.fn())
const mockResolveAttachmentUrl = vi.hoisted(() => vi.fn())
const mockGetVoiceRecordingReadiness = vi.hoisted(() => vi.fn())
const mockQueueInboxTranscriptionJob = vi.hoisted(() => vi.fn())
const mockMarkInboxJobFailed = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: vi.fn()
  }
}))

vi.mock('../database', () => ({
  getDatabase: vi.fn()
}))

vi.mock('./attachments', () => ({
  storeInboxAttachment: mockStoreInboxAttachment,
  resolveAttachmentUrl: mockResolveAttachmentUrl
}))

vi.mock('./transcription', () => ({
  getVoiceRecordingReadiness: mockGetVoiceRecordingReadiness
}))

vi.mock('./jobs', () => ({
  queueInboxTranscriptionJob: mockQueueInboxTranscriptionJob,
  markInboxJobFailed: mockMarkInboxJobFailed
}))

import { getDatabase } from '../database'
import { captureVoice } from './capture'

describe('inbox capture', () => {
  let testDb: TestDatabaseResult
  let window: MockBrowserWindow

  beforeEach(() => {
    testDb = createTestDatabase()
    vi.mocked(getDatabase).mockReturnValue(testDb.db)

    window = new MockBrowserWindow()
    vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([window])

    mockStoreInboxAttachment.mockReset()
    mockResolveAttachmentUrl.mockImplementation((value: string | null) =>
      value ? `memry-file://${value}` : null
    )
    mockGetVoiceRecordingReadiness.mockReset().mockResolvedValue({
      ready: true,
      provider: 'local'
    })
    mockQueueInboxTranscriptionJob.mockReset()
    mockMarkInboxJobFailed.mockReset()
  })

  afterEach(() => {
    cleanupTestDatabase(testDb)
    vi.clearAllMocks()
  })

  // ==========================================================================
  // T605: capture voice flow
  // ==========================================================================
  it('captures a voice memo, stores tags, and queues transcription', async () => {
    mockStoreInboxAttachment.mockImplementation(async (id: string) => ({
      success: true,
      path: `attachments/inbox/${id}/voice-memo.webm`
    }))

    const response = await captureVoice({
      data: Buffer.from('audio-data'),
      duration: 65,
      format: 'webm',
      tags: ['work', 'idea'],
      transcribe: true
    })

    expect(response.success).toBe(true)
    expect(response.item?.title).toBe('Voice memo (1:05)')
    expect(response.item?.attachmentUrl).toMatch(/^memry-file:\/\//)
    expect(response.item?.transcriptionStatus).toBe('pending')

    const created = testDb.db
      .select()
      .from(inboxItems)
      .where(eq(inboxItems.id, response.item!.id))
      .get()

    expect(created?.attachmentPath).toContain(`/inbox/${response.item!.id}/voice-memo.webm`)

    const tags = testDb.db
      .select()
      .from(inboxItemTags)
      .where(eq(inboxItemTags.itemId, response.item!.id))
      .all()
      .map((tag) => tag.tag)
      .sort()

    expect(tags).toEqual(['idea', 'work'])

    expect(window.webContents.send).toHaveBeenCalledWith(
      InboxChannels.events.CAPTURED,
      expect.objectContaining({
        item: expect.objectContaining({ id: response.item!.id, type: 'voice' })
      })
    )

    expect(mockQueueInboxTranscriptionJob).toHaveBeenCalledWith(
      response.item!.id,
      `attachments/inbox/${response.item!.id}/voice-memo.webm`
    )
  })

  it('marks transcription as failed when unavailable', async () => {
    mockGetVoiceRecordingReadiness.mockResolvedValue({
      ready: false,
      provider: 'local',
      reason: 'missing-model',
      message: 'Download Whisper Small in Settings to record voice memos.'
    })
    mockStoreInboxAttachment.mockResolvedValue({
      success: true,
      path: 'attachments/inbox/item-1/voice-memo.webm'
    })

    const response = await captureVoice({
      data: Buffer.from('audio-data'),
      duration: 30,
      format: 'webm',
      transcribe: true
    })

    expect(response.success).toBe(true)
    expect(response.item?.transcriptionStatus).toBe('failed')
    expect(response.item?.processingError).toContain(
      'Download Whisper Small in Settings to record voice memos.'
    )
    expect(mockQueueInboxTranscriptionJob).not.toHaveBeenCalled()
    expect(mockMarkInboxJobFailed).toHaveBeenCalledWith(
      response.item!.id,
      'transcription',
      { attachmentPath: 'attachments/inbox/item-1/voice-memo.webm' },
      'Download Whisper Small in Settings to record voice memos.'
    )
  })

  it('returns an error when attachment storage fails', async () => {
    mockStoreInboxAttachment.mockResolvedValue({
      success: false,
      error: 'Storage failed'
    })

    const response = await captureVoice({
      data: Buffer.from('audio-data'),
      duration: 10,
      format: 'webm'
    })

    expect(response.success).toBe(false)
    expect(response.error).toContain('Storage failed')
  })

  it('returns an error when no vault is open', async () => {
    vi.mocked(getDatabase).mockImplementation(() => {
      throw new Error('Database not initialized')
    })

    const response = await captureVoice({
      data: Buffer.from('audio-data'),
      duration: 10,
      format: 'webm'
    })

    expect(response.success).toBe(false)
    expect(response.error).toContain('No vault is open')
  })
})

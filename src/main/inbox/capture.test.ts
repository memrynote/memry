import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { InboxChannels } from '@shared/ipc-channels'
import { inboxItems, inboxItemTags } from '@shared/db/schema/inbox'
import { createTestDatabase, cleanupTestDatabase, type TestDatabaseResult } from '@tests/utils/test-db'
import { MockBrowserWindow } from '@tests/utils/mock-electron'
import { BrowserWindow } from 'electron'

const mockStoreInboxAttachment = vi.hoisted(() => vi.fn())
const mockResolveAttachmentUrl = vi.hoisted(() => vi.fn())
const mockTranscribeAudio = vi.hoisted(() => vi.fn())
const mockIsTranscriptionAvailable = vi.hoisted(() => vi.fn())

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
  transcribeAudio: mockTranscribeAudio,
  isTranscriptionAvailable: mockIsTranscriptionAvailable
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
    mockTranscribeAudio.mockReset()
    mockIsTranscriptionAvailable.mockReset()
  })

  afterEach(() => {
    cleanupTestDatabase(testDb)
    vi.clearAllMocks()
  })

  // ==========================================================================
  // T605: capture voice flow
  // ==========================================================================
  it('captures a voice memo, stores tags, and triggers transcription', async () => {
    mockIsTranscriptionAvailable.mockReturnValue(true)
    mockStoreInboxAttachment.mockImplementation(async (id: string) => ({
      success: true,
      path: `attachments/inbox/${id}/voice-memo.webm`
    }))
    mockTranscribeAudio.mockResolvedValue({ success: true, transcription: 'hello' })

    const setImmediateSpy = vi
      .spyOn(global, 'setImmediate')
      .mockImplementation((handler: () => void) => {
        handler()
        return 0 as unknown as NodeJS.Immediate
      })

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

    expect(mockTranscribeAudio).toHaveBeenCalledWith(
      response.item!.id,
      `attachments/inbox/${response.item!.id}/voice-memo.webm`
    )

    setImmediateSpy.mockRestore()
  })

  it('marks transcription as failed when unavailable', async () => {
    mockIsTranscriptionAvailable.mockReturnValue(false)
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
    expect(response.item?.processingError).toContain('OpenAI API key not configured')
    expect(mockTranscribeAudio).not.toHaveBeenCalled()
  })

  it('returns an error when attachment storage fails', async () => {
    mockIsTranscriptionAvailable.mockReturnValue(true)
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

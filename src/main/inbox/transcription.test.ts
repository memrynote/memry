import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { eq } from 'drizzle-orm'
import { InboxChannels } from '@shared/ipc-channels'
import { inboxItems } from '@shared/db/schema/inbox'
import { createTestDatabase, cleanupTestDatabase, type TestDatabaseResult } from '@tests/utils/test-db'
import { MockBrowserWindow } from '@tests/utils/mock-electron'
import { BrowserWindow } from 'electron'

const mockCreate = vi.hoisted(() => vi.fn())
const mockToFile = vi.hoisted(() => vi.fn())
const mockEnvConfig = vi.hoisted(() => ({
  openaiApiKey: undefined as string | undefined,
  whisperModel: 'whisper-1',
  embeddingModel: 'text-embedding-3-small'
}))

const MockOpenAI = vi.hoisted(
  () =>
    class {
      audio = {
        transcriptions: {
          create: mockCreate
        }
      }
    }
)

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: vi.fn()
  }
}))

vi.mock('openai', () => ({
  default: MockOpenAI
}))

vi.mock('openai/uploads', () => ({
  toFile: mockToFile
}))

vi.mock('../index', () => ({
  envConfig: mockEnvConfig
}))

vi.mock('../database', () => ({
  getDatabase: vi.fn()
}))

vi.mock('../vault', () => ({
  getStatus: vi.fn()
}))

import { getDatabase } from '../database'
import { getStatus } from '../vault'
import { transcribeAudio, retryTranscription } from './transcription'

describe('inbox transcription', () => {
  let testDb: TestDatabaseResult
  let window: MockBrowserWindow
  let vaultPath: string

  beforeEach(() => {
    testDb = createTestDatabase()
    vi.mocked(getDatabase).mockReturnValue(testDb.db)

    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-transcribe-'))
    vi.mocked(getStatus).mockReturnValue({
      isOpen: true,
      path: vaultPath,
      name: 'Test Vault',
      isIndexing: false,
      indexProgress: 100,
      error: null
    } as ReturnType<typeof getStatus>)

    window = new MockBrowserWindow()
    vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([window])

    mockCreate.mockReset()
    mockToFile.mockReset().mockResolvedValue({ file: 'mock' })
    mockEnvConfig.openaiApiKey = undefined
  })

  afterEach(() => {
    cleanupTestDatabase(testDb)
    fs.rmSync(vaultPath, { recursive: true, force: true })
    vi.clearAllMocks()
  })

  function seedVoiceItem(id: string, attachmentPath: string) {
    const now = new Date().toISOString()
    testDb.db.insert(inboxItems).values({
      id,
      type: 'voice',
      title: 'Voice memo',
      content: null,
      createdAt: now,
      modifiedAt: now,
      attachmentPath,
      transcriptionStatus: 'pending'
    }).run()
  }

  // ==========================================================================
  // T611: transcription pipeline (mocked provider)
  // ==========================================================================
  it('transcribes audio and updates item status', async () => {
    mockEnvConfig.openaiApiKey = 'test-key'
    mockCreate.mockResolvedValue('Hello world')

    const relativePath = 'attachments/inbox/item-1/audio.webm'
    const fullPath = path.join(vaultPath, relativePath)
    fs.mkdirSync(path.dirname(fullPath), { recursive: true })
    fs.writeFileSync(fullPath, Buffer.from('audio'))

    seedVoiceItem('item-1', relativePath)

    const result = await transcribeAudio('item-1', relativePath)

    expect(result.success).toBe(true)
    expect(result.transcription).toBe('Hello world')

    const updated = testDb.db
      .select()
      .from(inboxItems)
      .where(eq(inboxItems.id, 'item-1'))
      .get()

    expect(updated?.transcriptionStatus).toBe('complete')
    expect(updated?.transcription).toBe('Hello world')
    expect(updated?.processingError).toBeNull()

    expect(window.webContents.send).toHaveBeenCalledWith(
      InboxChannels.events.TRANSCRIPTION_COMPLETE,
      expect.objectContaining({ id: 'item-1', transcription: 'Hello world' })
    )
  })

  // ==========================================================================
  // T612: error handling and retry flows
  // ==========================================================================
  it('fails when API key is missing', async () => {
    const relativePath = 'attachments/inbox/item-2/audio.webm'
    const fullPath = path.join(vaultPath, relativePath)
    fs.mkdirSync(path.dirname(fullPath), { recursive: true })
    fs.writeFileSync(fullPath, Buffer.from('audio'))

    seedVoiceItem('item-2', relativePath)

    const result = await transcribeAudio('item-2', relativePath)

    expect(result.success).toBe(false)
    expect(result.error).toContain('OpenAI API key not configured')

    expect(window.webContents.send).toHaveBeenCalledWith(
      InboxChannels.events.PROCESSING_ERROR,
      expect.objectContaining({ id: 'item-2' })
    )
  })

  it('fails on unsupported formats', async () => {
    mockEnvConfig.openaiApiKey = 'test-key'

    const relativePath = 'attachments/inbox/item-3/audio.txt'
    const fullPath = path.join(vaultPath, relativePath)
    fs.mkdirSync(path.dirname(fullPath), { recursive: true })
    fs.writeFileSync(fullPath, Buffer.from('audio'))

    seedVoiceItem('item-3', relativePath)

    const result = await transcribeAudio('item-3', relativePath)

    expect(result.success).toBe(false)
    expect(result.error).toContain('Unsupported audio format')

    const updated = testDb.db
      .select()
      .from(inboxItems)
      .where(eq(inboxItems.id, 'item-3'))
      .get()

    expect(updated?.transcriptionStatus).toBe('failed')
  })

  it('maps provider errors and supports retry', async () => {
    mockEnvConfig.openaiApiKey = 'test-key'
    mockCreate.mockRejectedValue(new Error('rate_limit'))

    const relativePath = 'attachments/inbox/item-4/audio.webm'
    const fullPath = path.join(vaultPath, relativePath)
    fs.mkdirSync(path.dirname(fullPath), { recursive: true })
    fs.writeFileSync(fullPath, Buffer.from('audio'))

    seedVoiceItem('item-4', relativePath)

    const result = await transcribeAudio('item-4', relativePath)

    expect(result.success).toBe(false)
    expect(result.error).toContain('Rate limit exceeded')

    mockCreate.mockResolvedValue('Recovered')

    const retryResult = await retryTranscription('item-4')
    expect(retryResult.success).toBe(true)

    const updated = testDb.db
      .select()
      .from(inboxItems)
      .where(eq(inboxItems.id, 'item-4'))
      .get()

    expect(updated?.transcriptionStatus).toBe('complete')
    expect(updated?.transcription).toBe('Recovered')
  })

  it('returns errors for invalid retry requests', async () => {
    const responseMissing = await retryTranscription('missing')
    expect(responseMissing.success).toBe(false)

    const now = new Date().toISOString()
    testDb.db.insert(inboxItems).values({
      id: 'item-5',
      type: 'link',
      title: 'Not voice',
      content: null,
      createdAt: now,
      modifiedAt: now
    }).run()

    const responseType = await retryTranscription('item-5')
    expect(responseType.success).toBe(false)

    testDb.db.insert(inboxItems).values({
      id: 'item-6',
      type: 'voice',
      title: 'Voice',
      content: null,
      createdAt: now,
      modifiedAt: now
    }).run()

    const responseAttachment = await retryTranscription('item-6')
    expect(responseAttachment.success).toBe(false)
  })
})

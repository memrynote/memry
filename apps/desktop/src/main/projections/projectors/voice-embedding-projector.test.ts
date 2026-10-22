import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  items: [] as Array<Record<string, unknown>>,
  states: new Map<string, { source: string; inputVersion: number; chunks: number }>(),
  replace: vi.fn(),
  remove: vi.fn(),
  embedAudio: vi.fn(),
  audioEnabled: vi.fn(),
  generateEmbedding: vi.fn(),
  readFile: vi.fn(),
  getSetting: vi.fn()
}))

vi.mock('../../database', () => ({
  getDatabase: () => ({
    select: () => ({ from: () => ({ where: () => ({ all: () => mocks.items }) }) })
  }),
  getRawIndexDatabase: () => ({})
}))
vi.mock('@main/database/queries/settings', () => ({ getSetting: mocks.getSetting }))
vi.mock('../../database/voice-vectors', () => ({
  deleteVoiceVectors: mocks.remove,
  readVoiceVectorStates: () => mocks.states,
  replaceVoiceVectors: mocks.replace
}))
vi.mock('../../lib/audio-embedding', () => ({
  decodeWavForEmbedding: () => new Float32Array(32_000),
  embedAudio: mocks.embedAudio,
  isAudioEmbeddingEnabled: mocks.audioEnabled
}))
vi.mock('../../lib/embeddings', () => ({
  generateEmbedding: mocks.generateEmbedding,
  initEmbeddingModel: vi.fn().mockResolvedValue(true),
  isModelLoaded: () => true
}))
vi.mock('../../lib/paths', () => ({
  openVaultFile: async () => ({ readFile: mocks.readFile, close: vi.fn() })
}))
vi.mock('../../lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

import { createVoiceEmbeddingProjector, planVoiceEmbedding } from './voice-embedding-projector'

const memo = (over: Record<string, unknown> = {}) => ({
  id: 'memo-1',
  title: 'Voice memo',
  transcription: null,
  transcriptionStatus: null,
  attachmentPath: 'attachments/inbox/memo-1/memo.wav',
  ...over
})

describe('planVoiceEmbedding', () => {
  it('uses the transcript when it carries speech and audio when it does not', () => {
    const speech = memo({
      transcription: 'call the dentist tomorrow',
      transcriptionStatus: 'complete'
    })
    expect(planVoiceEmbedding(speech as never)).toMatchObject({ source: 'transcript' })
    for (const transcription of ['', 'Thank you.', '[Music]', null]) {
      expect(
        planVoiceEmbedding(memo({ transcription, transcriptionStatus: 'complete' }) as never)
      ).toEqual({ source: 'audio' })
    }
    expect(planVoiceEmbedding(memo({ transcriptionStatus: 'failed' }) as never)).toEqual({
      source: 'audio'
    })
    expect(planVoiceEmbedding(memo({ transcriptionStatus: null }) as never)).toEqual({
      source: 'audio'
    })
  })

  it('waits for a transcription that is still running', () => {
    expect(planVoiceEmbedding(memo({ transcriptionStatus: 'pending' }) as never)).toBe('wait')
    expect(planVoiceEmbedding(memo({ transcriptionStatus: 'processing' }) as never)).toBe('wait')
  })
})

describe('voice embedding projector', () => {
  const projector = createVoiceEmbeddingProjector(() => '/vault')

  beforeEach(() => {
    vi.resetAllMocks()
    mocks.items = []
    mocks.states = new Map()
    mocks.getSetting.mockReturnValue(undefined)
    mocks.audioEnabled.mockReturnValue(true)
    mocks.embedAudio.mockResolvedValue([new Float32Array(256)])
    mocks.generateEmbedding.mockResolvedValue(new Float32Array(256))
    mocks.readFile.mockResolvedValue(Buffer.alloc(0))
  })

  it('embeds a memo without a transcript from its audio', async () => {
    mocks.items = [memo({ transcriptionStatus: 'failed' })]
    await projector.project({ type: 'inbox.upserted', itemId: 'memo-1' })
    expect(mocks.embedAudio).toHaveBeenCalledOnce()
    expect(mocks.replace).toHaveBeenCalledWith({}, 'memo-1', 'audio', 1, expect.any(Array))
  })

  it('embeds a transcribed memo from text and never touches the audio encoder', async () => {
    mocks.items = [
      memo({ transcription: 'call the dentist tomorrow', transcriptionStatus: 'complete' })
    ]
    await projector.project({ type: 'inbox.upserted', itemId: 'memo-1' })
    expect(mocks.generateEmbedding).toHaveBeenCalledOnce()
    expect(mocks.embedAudio).not.toHaveBeenCalled()
    expect(mocks.replace).toHaveBeenCalledWith({}, 'memo-1', 'transcript', expect.any(Number), [
      expect.any(Float32Array)
    ])
  })

  it('writes nothing while the audio encoder setting is off', async () => {
    mocks.audioEnabled.mockReturnValue(false)
    mocks.items = [memo({ transcriptionStatus: 'failed' })]
    await projector.project({ type: 'inbox.upserted', itemId: 'memo-1' })
    expect(mocks.embedAudio).not.toHaveBeenCalled()
    expect(mocks.replace).not.toHaveBeenCalled()
  })

  it('reconcile prunes gone memos and skips memos already embedded the same way', async () => {
    mocks.items = [
      memo({ id: 'done', transcriptionStatus: 'failed' }),
      memo({ id: 'owed', transcriptionStatus: 'failed' })
    ]
    mocks.states = new Map([
      ['done', { source: 'audio', inputVersion: 1, chunks: 1 }],
      ['gone', { source: 'audio', inputVersion: 1, chunks: 1 }]
    ])
    await projector.reconcile()
    expect(mocks.remove).toHaveBeenCalledWith({}, 'gone')
    expect(mocks.replace).toHaveBeenCalledTimes(1)
    expect(mocks.replace.mock.calls[0][1]).toBe('owed')
  })

  it('reconcile re-embeds a memo whose transcript arrived after its audio vector', async () => {
    mocks.items = [
      memo({ transcription: 'call the dentist tomorrow', transcriptionStatus: 'complete' })
    ]
    mocks.states = new Map([['memo-1', { source: 'audio', inputVersion: 1, chunks: 1 }]])
    await projector.reconcile()
    expect(mocks.replace.mock.calls[0][2]).toBe('transcript')
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { VOICE_TRANSCRIPTION_SETTINGS_DEFAULTS } from '@memry/contracts/settings-schemas'

const mocks = vi.hoisted(() => ({
  getDatabase: vi.fn(),
  getSetting: vi.fn(),
  getVoiceModelStatus: vi.fn(),
  hasOpenAiKey: vi.fn()
}))

vi.mock('../database', () => ({
  getDatabase: mocks.getDatabase
}))

vi.mock('@main/database/queries/settings', () => ({
  getSetting: mocks.getSetting
}))

vi.mock('./voice-model', () => ({
  getVoiceModelStatus: mocks.getVoiceModelStatus
}))

vi.mock('./voice-transcription-keychain', () => ({
  hasVoiceTranscriptionOpenAIApiKey: mocks.hasOpenAiKey
}))

import {
  getVoiceRecordingReadiness,
  getVoiceTranscriptionSettings
} from './voice-transcription-settings'

describe('voice transcription settings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getDatabase.mockReturnValue({ id: 'db' })
    mocks.getSetting.mockReturnValue(null)
    mocks.getVoiceModelStatus.mockReturnValue({ downloaded: false })
    mocks.hasOpenAiKey.mockResolvedValue(false)
  })

  it('returns defaults when the vault is closed, missing settings, or invalid JSON', () => {
    mocks.getDatabase.mockImplementationOnce(() => {
      throw new Error('no vault')
    })
    expect(getVoiceTranscriptionSettings()).toEqual(VOICE_TRANSCRIPTION_SETTINGS_DEFAULTS)

    expect(getVoiceTranscriptionSettings()).toEqual(VOICE_TRANSCRIPTION_SETTINGS_DEFAULTS)

    mocks.getSetting.mockReturnValueOnce('{bad json')
    expect(getVoiceTranscriptionSettings()).toEqual(VOICE_TRANSCRIPTION_SETTINGS_DEFAULTS)
  })

  it('merges stored settings and checks local-model readiness', async () => {
    mocks.getSetting.mockReturnValue(JSON.stringify({ provider: 'local' }))
    expect(getVoiceTranscriptionSettings()).toEqual({
      ...VOICE_TRANSCRIPTION_SETTINGS_DEFAULTS,
      provider: 'local'
    })

    await expect(getVoiceRecordingReadiness()).resolves.toEqual({
      ready: false,
      provider: 'local',
      reason: 'missing-model',
      message: 'Download Whisper Small in Settings to record voice memos.'
    })

    mocks.getVoiceModelStatus.mockReturnValue({ downloaded: true })
    await expect(getVoiceRecordingReadiness()).resolves.toEqual({
      ready: true,
      provider: 'local'
    })
  })

  it('checks OpenAI key readiness when OpenAI is selected', async () => {
    mocks.getSetting.mockReturnValue(JSON.stringify({ provider: 'openai' }))

    await expect(getVoiceRecordingReadiness()).resolves.toEqual({
      ready: false,
      provider: 'openai',
      reason: 'missing-api-key',
      message: 'Add your OpenAI API key in Settings to record voice memos.'
    })

    mocks.hasOpenAiKey.mockResolvedValue(true)
    await expect(getVoiceRecordingReadiness()).resolves.toEqual({
      ready: true,
      provider: 'openai'
    })
  })
})

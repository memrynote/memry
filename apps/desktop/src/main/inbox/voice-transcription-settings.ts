import { getSetting } from '@main/database/queries/settings'
import {
  VOICE_TRANSCRIPTION_SETTINGS_DEFAULTS,
  type VoiceTranscriptionSettings
} from '@memry/contracts/settings-schemas'

import { getDatabase } from '../database'
import { getVoiceModelStatus } from './voice-model'
import { hasVoiceTranscriptionOpenAIApiKey } from './voice-transcription-keychain'

const SETTINGS_KEY = 'voiceTranscription'

export interface VoiceRecordingReadiness {
  ready: boolean
  provider: VoiceTranscriptionSettings['provider']
  reason?: 'missing-model' | 'missing-api-key'
  message?: string
}

function getDbOrNull() {
  try {
    return getDatabase()
  } catch {
    return null
  }
}

export function getVoiceTranscriptionSettings(): VoiceTranscriptionSettings {
  const db = getDbOrNull()
  if (!db) {
    return { ...VOICE_TRANSCRIPTION_SETTINGS_DEFAULTS }
  }

  const raw = getSetting(db, SETTINGS_KEY)
  if (!raw) {
    return { ...VOICE_TRANSCRIPTION_SETTINGS_DEFAULTS }
  }

  try {
    const parsed = JSON.parse(raw) as Partial<VoiceTranscriptionSettings>
    return { ...VOICE_TRANSCRIPTION_SETTINGS_DEFAULTS, ...parsed }
  } catch {
    return { ...VOICE_TRANSCRIPTION_SETTINGS_DEFAULTS }
  }
}

export async function getVoiceRecordingReadiness(): Promise<VoiceRecordingReadiness> {
  const settings = getVoiceTranscriptionSettings()

  if (settings.provider === 'local') {
    const modelStatus = getVoiceModelStatus()
    if (modelStatus.downloaded) {
      return { ready: true, provider: 'local' }
    }

    return {
      ready: false,
      provider: 'local',
      reason: 'missing-model',
      message: 'Download Whisper Small in Settings to record voice memos.'
    }
  }

  const hasApiKey = await hasVoiceTranscriptionOpenAIApiKey()
  if (hasApiKey) {
    return { ready: true, provider: 'openai' }
  }

  return {
    ready: false,
    provider: 'openai',
    reason: 'missing-api-key',
    message: 'Add your OpenAI API key in Settings to record voice memos.'
  }
}

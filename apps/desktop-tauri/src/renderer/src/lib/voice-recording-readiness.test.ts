import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  ensureVoiceRecordingReady,
  getVoiceRecordingSettingsTarget
} from './voice-recording-readiness'

describe('ensureVoiceRecordingReady', () => {
  beforeEach(() => {
    const settingsMock = window.api.settings as Record<string, unknown>
    settingsMock.getVoiceRecordingReadiness = vi.fn()
  })

  it('returns true when the selected provider is ready', async () => {
    ;(window.api.settings.getVoiceRecordingReadiness as ReturnType<typeof vi.fn>).mockResolvedValue(
      {
        ready: true,
        provider: 'local'
      }
    )

    const onBlocked = vi.fn()
    const ready = await ensureVoiceRecordingReady(onBlocked)

    expect(ready).toBe(true)
    expect(onBlocked).not.toHaveBeenCalled()
  })

  it('redirects when the selected provider is not ready', async () => {
    const readiness = {
      ready: false,
      provider: 'local',
      reason: 'missing-model',
      message: 'Download Whisper Small in Settings to record voice memos.'
    } as const
    ;(window.api.settings.getVoiceRecordingReadiness as ReturnType<typeof vi.fn>).mockResolvedValue(
      readiness
    )

    const onBlocked = vi.fn()
    const ready = await ensureVoiceRecordingReady(onBlocked)

    expect(ready).toBe(false)
    expect(onBlocked).toHaveBeenCalledWith(readiness)
  })

  it('only focuses the local model target for missing local models', () => {
    expect(
      getVoiceRecordingSettingsTarget({
        ready: false,
        provider: 'local',
        reason: 'missing-model'
      })
    ).toBe('ai:voice-local-model')
    expect(
      getVoiceRecordingSettingsTarget({
        ready: false,
        provider: 'openai',
        reason: 'missing-api-key'
      })
    ).toBe('ai')
  })
})

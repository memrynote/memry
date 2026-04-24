import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ensureVoiceRecordingReady } from './voice-recording-readiness'

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
    ;(window.api.settings.getVoiceRecordingReadiness as ReturnType<typeof vi.fn>).mockResolvedValue(
      {
        ready: false,
        provider: 'local',
        reason: 'missing-model',
        message: 'Download Whisper Small in Settings to record voice memos.'
      }
    )

    const onBlocked = vi.fn()
    const ready = await ensureVoiceRecordingReady(onBlocked)

    expect(ready).toBe(false)
    expect(onBlocked).toHaveBeenCalledOnce()
  })
})

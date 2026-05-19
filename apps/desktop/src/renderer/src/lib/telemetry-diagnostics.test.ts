import { beforeEach, describe, expect, it, vi } from 'vitest'

const { trackTelemetryMock } = vi.hoisted(() => ({
  trackTelemetryMock: vi.fn()
}))

vi.mock('./telemetry', () => ({
  trackTelemetry: trackTelemetryMock
}))

import { trackRendererError, trackRendererLog, trackRendererReady } from './telemetry-diagnostics'

describe('renderer telemetry diagnostics', () => {
  beforeEach(() => {
    trackTelemetryMock.mockReset()
  })

  it('emits sanitized renderer errors without raw messages', () => {
    // #given an error with private-looking message text
    const error = new TypeError('failed at /Users/kaan/private-note.md')

    // #when tracking it
    trackRendererError('unhandled_rejection', error)

    // #then only stable metadata leaves the renderer
    expect(trackTelemetryMock).toHaveBeenCalledWith(
      'app_error_seen',
      expect.objectContaining({
        surface: 'app',
        action: 'unhandled_rejection',
        objectType: 'exception',
        source: 'renderer',
        result: 'failed',
        errorCode: 'TypeError'
      })
    )
    expect(JSON.stringify(trackTelemetryMock.mock.calls[0])).not.toContain('private-note')
  })

  it('emits structured renderer logs', () => {
    // #given a warning breadcrumb
    trackRendererLog('warn', 'boot_failed', 'RendererBoot')

    // #then it is a typed telemetry log event
    expect(trackTelemetryMock).toHaveBeenCalledWith('app_log_recorded', {
      surface: 'app',
      action: 'warn',
      objectType: 'log',
      source: 'RendererBoot',
      result: 'failed',
      dimensions: { log_action: 'boot_failed' }
    })
  })

  it('emits renderer-ready launch timing', () => {
    // #given renderer boot completed
    trackRendererReady(64)

    // #then the duration is captured as a launch phase
    expect(trackTelemetryMock).toHaveBeenCalledWith('app_launch_phase_completed', {
      surface: 'app',
      action: 'renderer_ready',
      source: 'renderer',
      result: 'success',
      metrics: { durationMs: 64 }
    })
  })
})

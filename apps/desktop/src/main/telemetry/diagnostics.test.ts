import { beforeEach, describe, expect, it, vi } from 'vitest'

const { trackMainEventMock } = vi.hoisted(() => ({
  trackMainEventMock: vi.fn()
}))

vi.mock('./track', () => ({
  trackMainEvent: trackMainEventMock
}))

import { trackLaunchPhase, trackMainError, trackMainLog } from './diagnostics'

describe('telemetry diagnostics', () => {
  beforeEach(() => {
    trackMainEventMock.mockReset()
  })

  it('emits sanitized main-process errors without raw messages', () => {
    // #given an error containing private-looking text in the message
    const error = new TypeError('failed at /Users/kaan/private-note.md')

    // #when tracking the error
    trackMainError('main_process', 'unhandled_exception', error)

    // #then only stable diagnostic metadata is sent
    expect(trackMainEventMock).toHaveBeenCalledWith(
      'app_error_seen',
      expect.objectContaining({
        surface: 'app',
        action: 'unhandled_exception',
        objectType: 'exception',
        source: 'main_process',
        result: 'failed',
        errorCode: 'TypeError'
      })
    )
    expect(JSON.stringify(trackMainEventMock.mock.calls[0])).not.toContain('private-note')
  })

  it('emits structured remote log breadcrumbs', () => {
    // #given a warning from a known app scope
    trackMainLog('warn', {
      scope: 'TelemetryRuntime',
      action: 'flush_failed',
      errorCode: 'NetworkError'
    })

    // #then it becomes a typed log event
    expect(trackMainEventMock).toHaveBeenCalledWith('app_log_recorded', {
      surface: 'app',
      action: 'warn',
      objectType: 'log',
      source: 'TelemetryRuntime',
      result: 'failed',
      errorCode: 'NetworkError',
      dimensions: { log_action: 'flush_failed' }
    })
  })

  it('emits launch phase timings', () => {
    // #given a completed launch phase
    trackLaunchPhase('renderer_ready', 128)

    // #then phase and duration are recorded without free-form text
    expect(trackMainEventMock).toHaveBeenCalledWith('app_launch_phase_completed', {
      surface: 'app',
      action: 'renderer_ready',
      source: 'main_process',
      result: 'success',
      metrics: { durationMs: 128 }
    })
  })
})

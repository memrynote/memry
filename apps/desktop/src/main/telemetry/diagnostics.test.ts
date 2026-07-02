import { beforeEach, describe, expect, it, vi } from 'vitest'

const { trackMainEventMock } = vi.hoisted(() => ({
  trackMainEventMock: vi.fn()
}))

vi.mock('./track', () => ({
  trackMainEvent: trackMainEventMock
}))

import {
  trackLaunchPhase,
  trackMainError,
  trackMainLog,
  startActiveHeartbeat,
  stopActiveHeartbeat
} from './diagnostics'

describe('telemetry diagnostics', () => {
  beforeEach(() => {
    trackMainEventMock.mockReset()
  })

  it('emits a stack for main-process errors but never the raw message', () => {
    // #given an error whose message embeds a private note path
    const error = new TypeError('failed at /Users/kaan/private-note.md')

    // #when tracking the error
    trackMainError('main_process', 'unhandled_exception', error)

    // #then stable metadata + a stack (code locations) are sent, never the message
    expect(trackMainEventMock).toHaveBeenCalledWith(
      'app_error_seen',
      expect.objectContaining({
        surface: 'app',
        action: 'unhandled_exception',
        objectType: 'exception',
        source: 'main_process',
        result: 'failed',
        errorCode: 'TypeError',
        error: expect.objectContaining({ stack: expect.stringContaining('at ') })
      })
    )
    const serialized = JSON.stringify(trackMainEventMock.mock.calls[0])
    // message header is stripped; home paths in stack frames are scrubbed
    expect(serialized).not.toContain('private-note')
    expect(serialized).not.toContain('/Users/')
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

  describe('active heartbeat', () => {
    it('emits app_active_heartbeat every 5 minutes while focused', () => {
      vi.useFakeTimers()
      startActiveHeartbeat(() => true)
      vi.advanceTimersByTime(5 * 60 * 1000)
      expect(trackMainEventMock).toHaveBeenCalledWith(
        'app_active_heartbeat',
        expect.objectContaining({ surface: 'app', action: 'heartbeat' })
      )
      stopActiveHeartbeat()
      vi.useRealTimers()
    })

    it('skips heartbeat when no window focused', () => {
      vi.useFakeTimers()
      startActiveHeartbeat(() => false)
      vi.advanceTimersByTime(5 * 60 * 1000)
      expect(trackMainEventMock).not.toHaveBeenCalled()
      stopActiveHeartbeat()
      vi.useRealTimers()
    })

    it('second startActiveHeartbeat call is a no-op (single timer)', () => {
      vi.useFakeTimers()
      startActiveHeartbeat(() => true)
      startActiveHeartbeat(() => true)
      vi.advanceTimersByTime(5 * 60 * 1000)
      expect(trackMainEventMock).toHaveBeenCalledTimes(1)
      stopActiveHeartbeat()
      vi.useRealTimers()
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

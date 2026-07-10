import { beforeEach, describe, expect, it, vi } from 'vitest'

const { trackMainEventMock } = vi.hoisted(() => ({
  trackMainEventMock: vi.fn()
}))

vi.mock('./track', () => ({
  trackMainEvent: trackMainEventMock
}))

import {
  childProcessGoneErrorCode,
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

  describe('childProcessGoneErrorCode', () => {
    it('returns null for clean exits so idle worker shutdowns emit no error event', () => {
      // #given a utility worker (embeddings/image/voice) idle-shutting-down after 30s
      const code = childProcessGoneErrorCode({
        type: 'Utility',
        reason: 'clean-exit',
        serviceName: 'Embeddings'
      })

      // #then no error code — the caller skips telemetry entirely
      expect(code).toBeNull()
    })

    it('builds a composite type:reason:serviceName code for real faults', () => {
      // #given a utility worker that actually crashed
      const code = childProcessGoneErrorCode({
        type: 'Utility',
        reason: 'crashed',
        serviceName: 'Embeddings'
      })

      // #then the code is diagnosable and passes the safe-token rules
      expect(code).toBe('Utility:crashed:Embeddings')
    })

    it('handles processes without a serviceName', () => {
      const code = childProcessGoneErrorCode({ type: 'GPU', reason: 'abnormal-exit' })
      expect(code).toBe('GPU:abnormal-exit:')
    })

    it('sanitizes unsafe serviceName characters', () => {
      const code = childProcessGoneErrorCode({
        type: 'Utility',
        reason: 'crashed',
        serviceName: 'node service (v2)'
      })
      expect(code).toBe('Utility:crashed:node_service__v2_')
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

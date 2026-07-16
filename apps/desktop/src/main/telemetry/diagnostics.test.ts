import { beforeEach, describe, expect, it, vi } from 'vitest'

const { trackMainEventMock } = vi.hoisted(() => ({
  trackMainEventMock: vi.fn()
}))

vi.mock('./track', () => ({
  trackMainEvent: trackMainEventMock
}))

import {
  childProcessGoneErrorCode,
  trackChildProcessGone,
  trackLaunchPhase,
  trackMainError,
  trackMainLog,
  startActiveHeartbeat,
  stopActiveHeartbeat
} from './diagnostics'
import { NoteError, NoteErrorCode } from '../lib/errors'

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

  it('reports a wrapped fs failure with its errno, never the file path', () => {
    // #given a failed note save wrapping the real fs errno (the production
    // case: errorCode was only ever "NoteError", so EBUSY vs ENOSPC was lost)
    const cause = Object.assign(
      new Error("EBUSY: resource busy, rename '/Users/kaan/private-note.md'"),
      { code: 'EBUSY' }
    )
    const error = new NoteError(
      'Failed to write file: /Users/kaan/private-note.md',
      NoteErrorCode.WRITE_FAILED,
      undefined,
      { cause }
    )

    // #when the IPC layer reports it
    trackMainError('ipc', 'note_update', error)

    // #then the errno reaches telemetry
    expect(trackMainEventMock).toHaveBeenCalledWith(
      'app_error_seen',
      expect.objectContaining({ errorCode: 'NOTE_WRITE_FAILED:EBUSY' })
    )
    // #and no path leaves the process
    const serialized = JSON.stringify(trackMainEventMock.mock.calls[0])
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

  describe('trackChildProcessGone', () => {
    it('emits no telemetry for a clean idle-worker exit', () => {
      trackChildProcessGone({ type: 'Utility', reason: 'clean-exit', serviceName: 'Embeddings' })
      expect(trackMainEventMock).not.toHaveBeenCalled()
    })

    it('emits an error log event with a composite code for a real fault', () => {
      trackChildProcessGone({ type: 'Utility', reason: 'crashed', serviceName: 'Embeddings' })
      expect(trackMainEventMock).toHaveBeenCalledWith('app_log_recorded', {
        surface: 'app',
        action: 'error',
        objectType: 'log',
        source: 'Electron',
        result: 'failed',
        errorCode: 'Utility:crashed:Embeddings',
        dimensions: { log_action: 'child_process_gone' }
      })
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

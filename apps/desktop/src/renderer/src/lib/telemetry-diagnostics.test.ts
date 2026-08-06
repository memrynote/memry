import { beforeEach, describe, expect, it, vi } from 'vitest'

const { trackTelemetryMock } = vi.hoisted(() => ({
  trackTelemetryMock: vi.fn()
}))

vi.mock('./telemetry', () => ({
  trackTelemetry: trackTelemetryMock
}))

import {
  registerRendererDiagnostics,
  trackRendererError,
  trackRendererLog,
  trackRendererReady
} from './telemetry-diagnostics'

describe('renderer telemetry diagnostics', () => {
  beforeEach(() => {
    trackTelemetryMock.mockReset()
  })

  it('emits a stack and a redacted message for renderer errors, never the raw one', () => {
    // #given an error whose message embeds a private note path
    const error = new TypeError('failed at /Users/kaan/private-note.md')

    // #when tracking it
    trackRendererError('unhandled_rejection', error)

    // #then stable metadata, a stack (code locations) and the message all leave
    //   the renderer — the message only after redactText ran on it here. The
    //   renderer knows no diagnostics salt, so redaction is mask mode: fixed
    //   placeholders instead of correlatable hashes, equally scrubbed.
    expect(trackTelemetryMock).toHaveBeenCalledWith(
      'app_error_seen',
      expect.objectContaining({
        surface: 'app',
        action: 'unhandled_rejection',
        objectType: 'exception',
        source: 'renderer',
        result: 'failed',
        errorCode: 'TypeError',
        error: expect.objectContaining({
          stack: expect.stringContaining('at '),
          message: 'failed at ~/[name].md'
        })
      })
    )
    const serialized = JSON.stringify(trackTelemetryMock.mock.calls[0])
    // the note filename is gone from the message; home paths in stack frames
    // and message alike are scrubbed
    expect(serialized).not.toContain('private-note')
    expect(serialized).not.toContain('/Users/')
  })

  it('reports a typed code carried by the error, not the class name', () => {
    // #given an IPC failure that arrived with a typed code
    const error = Object.assign(new Error('could not save'), {
      name: 'NoteError',
      code: 'NOTE_WRITE_FAILED'
    })

    // #when tracking it
    trackRendererError('note_save', error)

    // #then the renderer matches main-process fidelity
    expect(trackTelemetryMock).toHaveBeenCalledWith(
      'app_error_seen',
      expect.objectContaining({ errorCode: 'NOTE_WRITE_FAILED' })
    )
  })

  it('captures an actionable code and stack for a non-Error rejection reason', () => {
    // #given a rejection whose reason is a bare string — no stack at all
    registerRendererDiagnostics()

    // #when the window reports it
    window.dispatchEvent(
      Object.assign(new Event('unhandledrejection'), { reason: 'boom at /Users/kaan/secret.md' })
    )

    // #then the reason's type + a synthesized stack are captured
    expect(trackTelemetryMock).toHaveBeenCalledWith(
      'app_error_seen',
      expect.objectContaining({
        action: 'unhandled_rejection',
        errorCode: 'Rejection_string',
        error: expect.objectContaining({ stack: expect.stringContaining('at ') })
      })
    )
    // #and the reason's value never ships
    const serialized = JSON.stringify(trackTelemetryMock.mock.calls[0])
    expect(serialized).not.toContain('secret.md')
    expect(serialized).not.toContain('boom')
  })

  it('captures the error class and source location of a window error with no error object', () => {
    // #given a window error that arrived without `event.error` — previously
    // reported as StringError with an empty stack and nothing to triage
    registerRendererDiagnostics()

    // #when the window reports it
    window.dispatchEvent(
      Object.assign(new Event('error'), {
        error: null,
        message: 'Uncaught TypeError: n.focus is not a function',
        filename: 'file:///Users/kaan/Memry.app/out/renderer/assets/index-VP6Jd1Vs.js',
        lineno: 121718,
        colno: 22
      })
    )

    // #then the class name and the code location both reach telemetry
    expect(trackTelemetryMock).toHaveBeenCalledWith(
      'app_error_seen',
      expect.objectContaining({
        action: 'window_error',
        errorCode: 'TypeError',
        error: expect.objectContaining({
          stack: expect.stringContaining('index-VP6Jd1Vs.js:121718:22')
        })
      })
    )
    // #and neither the message text nor the username ships
    const serialized = JSON.stringify(trackTelemetryMock.mock.calls[0])
    expect(serialized).not.toContain('focus')
    expect(serialized).not.toContain('/Users/kaan')
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

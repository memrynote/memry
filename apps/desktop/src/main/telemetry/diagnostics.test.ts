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
  trackMainUnhandledRejection,
  startActiveHeartbeat,
  stopActiveHeartbeat
} from './diagnostics'
import { markExpectedCondition } from './expected-conditions'
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

  describe('typed error codes', () => {
    it('reports the NoteError code, not the class name', () => {
      // #given a note write failure — production collapsed all 7 NoteErrorCode
      // values to "NoteError", making every note failure un-triageable
      const error = Object.assign(new Error('failed to write /Users/kaan/note.md'), {
        name: 'NoteError',
        code: 'NOTE_WRITE_FAILED',
        noteId: 'note-123'
      })

      // #when tracking it
      trackMainError('ipc', 'Failed to update note', error)

      // #then the typed code reaches telemetry, and the message still does not
      expect(trackMainEventMock).toHaveBeenCalledWith(
        'app_error_seen',
        expect.objectContaining({ errorCode: 'NOTE_WRITE_FAILED' })
      )
      expect(JSON.stringify(trackMainEventMock.mock.calls[0])).not.toContain('note.md')
    })

    it('reports the better-sqlite3 SQLITE_* code, not "SqliteError"', () => {
      // #given a locked DB file — indistinguishable from disk-full in production
      const error = Object.assign(new Error('database is locked'), {
        name: 'SqliteError',
        code: 'SQLITE_BUSY'
      })

      // #when tracking it
      trackMainError('ipc', 'Failed to update task', error)

      // #then SQLITE_BUSY is now distinguishable from any other SqliteError
      expect(trackMainEventMock).toHaveBeenCalledWith(
        'app_error_seen',
        expect.objectContaining({ errorCode: 'SQLITE_BUSY' })
      )
    })

    it('falls back to the class name when a code would leak a path', () => {
      // #given an error whose "code" is really a path
      const error = Object.assign(new Error('boom'), {
        name: 'VaultError',
        code: '/Users/kaan/vault/secret.md'
      })

      // #when tracking it
      trackMainError('ipc', 'Failed to open vault', error)

      // #then the safe class name is used and no path fragment ships
      expect(trackMainEventMock).toHaveBeenCalledWith(
        'app_error_seen',
        expect.objectContaining({ errorCode: 'VaultError' })
      )
      expect(JSON.stringify(trackMainEventMock.mock.calls[0])).not.toContain('secret')
    })
  })

  describe('child-process-gone detail', () => {
    it('omits the exit status when the platform did not report one', () => {
      trackChildProcessGone({ type: 'Utility', reason: 'launch-failed', name: 'CrdtPreflight' })

      expect(trackMainEventMock).toHaveBeenCalledWith(
        'app_log_recorded',
        expect.objectContaining({
          error: { message: 'CrdtPreflight utility process launch-failed' }
        })
      )
    })

    // The worker's own `exit` handler never fires for a native crash, so this
    // report is the only place the lifecycle phase can reach production. Without
    // it every `Utility:crashed:*` is unreadable: 107 embedding-worker crashes
    // and no way to tell a free teardown death from lost indexing.
    it('carries the worker lifecycle phase when the caller resolved one', () => {
      trackChildProcessGone({
        type: 'Utility',
        reason: 'crashed',
        name: 'Embeddings',
        exitCode: 6,
        phase: 'idle_shutdown'
      })

      expect(trackMainEventMock).toHaveBeenCalledWith(
        'app_log_recorded',
        expect.objectContaining({
          // errorCode stays phase-free: it is the Error Tracking fingerprint, and
          // splitting it would orphan the existing issue's history.
          errorCode: 'Utility:crashed:Embeddings',
          dimensions: { log_action: 'child_process_gone_idle_shutdown' },
          error: { message: 'Embeddings utility process crashed (exit 6, idle_shutdown)' }
        })
      )
    })

    // The crash payload used to ship error_code, message, log_action and exit_code
    // and nothing else useful, so 76 events on one release were indistinguishable
    // from each other. Events carry at most ONE dimension, and log_action holds
    // the phase, so the rest rides in the message and the numeric metrics — both
    // additive, no contract change, no sync-server deploy.
    it('carries the dead worker context the crash report used to throw away', () => {
      trackChildProcessGone({
        type: 'Utility',
        reason: 'crashed',
        name: 'Embeddings',
        exitCode: 6,
        phase: 'in_flight',
        context: {
          pid: 4821,
          uptimeMs: 12_345.6,
          release: 'start_timeout',
          modelCache: 'partial',
          modelCacheBytes: 90_112,
          load: 'reload',
          crashCount: 3,
          stderrTail: 'worker stderr tail:\n| libc++abi: terminating'
        }
      })

      expect(trackMainEventMock).toHaveBeenCalledWith(
        'app_log_recorded',
        expect.objectContaining({
          errorCode: 'Utility:crashed:Embeddings',
          dimensions: { log_action: 'child_process_gone_in_flight' },
          error: {
            message:
              'Embeddings utility process crashed (exit 6, in_flight) ' +
              '[reason=crashed pid=4821 uptime=12346ms release=start_timeout ' +
              'cache=partial cache_bytes=90112 load=reload crashes=3]',
            // A dead child leaves no JS stack in this process, so its own stderr
            // is the closest thing to one this family can ever carry.
            stack: 'worker stderr tail:\n| libc++abi: terminating'
          },
          metrics: { value: 6, durationMs: 12_346, retryCount: 3, byteCount: 90_112 }
        })
      )
    })

    // The worker exited 0 on its own; `graceful_stop` is only recorded on an
    // observed clean exit. The abort Electron reports afterwards is the native
    // runtime unwinding after the process was already gone, so it must stay
    // queryable without filing an exception per idle shutdown (#1990).
    it('demotes a post-exit teardown abort to warn without losing any payload', () => {
      trackChildProcessGone({
        type: 'Utility',
        reason: 'crashed',
        name: 'Embeddings',
        exitCode: 6,
        phase: 'idle_shutdown',
        context: {
          pid: 771,
          uptimeMs: 30_540,
          release: 'graceful_stop',
          modelCache: 'present',
          modelCacheBytes: 90_387_606,
          load: 'first',
          crashCount: 1
        }
      })

      expect(trackMainEventMock).toHaveBeenCalledWith(
        'app_log_recorded',
        expect.objectContaining({
          // `warn` keeps it out of Error Tracking; everything else is unchanged,
          // including the fingerprint, so the existing issue's history stands.
          action: 'warn',
          result: 'failed',
          errorCode: 'Utility:crashed:Embeddings',
          dimensions: { log_action: 'child_process_gone_idle_shutdown' },
          error: {
            message:
              'Embeddings utility process crashed (exit 6, idle_shutdown) ' +
              '[reason=crashed pid=771 uptime=30540ms release=graceful_stop ' +
              'cache=present cache_bytes=90387606 load=first crashes=1]'
          },
          metrics: { value: 6, durationMs: 30_540, retryCount: 1, byteCount: 90_387_606 }
        })
      )
    })

    // The demotion is justified by the observed exit 0 behind `graceful_stop`
    // and nothing else. A worker abandoned while still running never produced
    // one, so its abort is a real fault and has to keep filing an exception.
    it.each(['live', 'teardown', 'start_timeout', 'fatal_error', 'exit'])(
      'still reports an exception when the worker was released as %s',
      (release) => {
        trackChildProcessGone({
          type: 'Utility',
          reason: 'crashed',
          name: 'Embeddings',
          exitCode: 6,
          phase: 'idle_shutdown',
          context: { release, uptimeMs: 30_540, modelCache: 'present', load: 'first' }
        })

        expect(trackMainEventMock).toHaveBeenCalledWith(
          'app_log_recorded',
          expect.objectContaining({ action: 'error' })
        )
      }
    )

    // The `graceful_stop` release only exists on the embeddings bridge, but the
    // guard must not widen by accident: another worker's crash with no context
    // resolved is still an exception.
    it('keeps a crash from another worker family at error', () => {
      trackChildProcessGone({
        type: 'Utility',
        reason: 'crashed',
        name: 'VoiceTranscription',
        exitCode: 6
      })

      expect(trackMainEventMock).toHaveBeenCalledWith(
        'app_log_recorded',
        expect.objectContaining({
          action: 'error',
          errorCode: 'Utility:crashed:VoiceTranscription'
        })
      )
    })

    it('reports exactly as before when no phase is available', () => {
      trackChildProcessGone({
        type: 'Utility',
        reason: 'crashed',
        name: 'CrdtPreflight',
        exitCode: 11
      })

      expect(trackMainEventMock).toHaveBeenCalledWith(
        'app_log_recorded',
        expect.objectContaining({
          errorCode: 'Utility:crashed:CrdtPreflight',
          dimensions: { log_action: 'child_process_gone' },
          error: { message: 'CrdtPreflight utility process crashed (exit 11)' }
        })
      )
    })
  })

  describe('expected conditions', () => {
    it('emits nothing for an error marked as an expected condition', () => {
      // #given Ollama not running / an abandoned OAuth flow — normal states
      const error = markExpectedCondition(new Error('Google Calendar OAuth timed out'))

      // #when the IPC envelope reports it
      trackMainError('ipc', 'Failed to connect calendar provider', error)

      // #then it never becomes an error event
      expect(trackMainEventMock).not.toHaveBeenCalled()
    })

    it('still emits for an unmarked error from the same handler', () => {
      // #given a real fault from the same code path
      trackMainError('ipc', 'Failed to connect calendar provider', new Error('token exchange 500'))

      // #then it is reported — the suppression is not blanket
      expect(trackMainEventMock).toHaveBeenCalledTimes(1)
    })
  })

  describe('trackMainUnhandledRejection', () => {
    it('captures an actionable code and a stack for a non-Error reason', () => {
      // #given a rejection whose reason is not an Error: production saw 4x
      // `Error` / unhandled_rejection with a COMPLETELY EMPTY stack
      trackMainUnhandledRejection('vault sync for kaan@memrynote.com blew up')

      // #then the reason's type is recorded and a stack is synthesized
      expect(trackMainEventMock).toHaveBeenCalledWith(
        'app_error_seen',
        expect.objectContaining({
          action: 'unhandled_rejection',
          source: 'main_process',
          errorCode: 'Rejection_string',
          error: expect.objectContaining({ stack: expect.stringContaining('at ') })
        })
      )
      // #and the reason's value never ships
      const serialized = JSON.stringify(trackMainEventMock.mock.calls[0])
      expect(serialized).not.toContain('blew up')
      expect(serialized).not.toContain('@memrynote.com')
    })

    it('adopts the frames of a cross-realm error that fails instanceof Error', () => {
      // #given an error-shaped reason from another realm (worker/preload):
      // instanceof fails, so buildErrorDetail used to drop its stack entirely
      trackMainUnhandledRejection({
        name: 'Error',
        message: 'opening /Users/kaan/private.md failed',
        stack:
          'Error: opening /Users/kaan/private.md failed\n    at loadVault (/app/out/main.js:9:1)'
      })

      // #then the real frames survive, without the message header
      expect(trackMainEventMock).toHaveBeenCalledWith(
        'app_error_seen',
        expect.objectContaining({
          errorCode: 'Error',
          error: expect.objectContaining({ stack: expect.stringContaining('at loadVault') })
        })
      )
      expect(JSON.stringify(trackMainEventMock.mock.calls[0])).not.toContain('private.md')
    })

    it('passes a real Error through unchanged', () => {
      trackMainUnhandledRejection(new TypeError('boom'))
      expect(trackMainEventMock).toHaveBeenCalledWith(
        'app_error_seen',
        expect.objectContaining({ errorCode: 'TypeError' })
      )
    })
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

    it('returns null for memory-eviction so an OS memory-pressure kill emits no error event', () => {
      // #given the GPU (or any) process reclaimed by the OS under memory pressure —
      // a lifecycle event since Electron 40, not an actionable fault
      const code = childProcessGoneErrorCode({ type: 'GPU', reason: 'memory-eviction' })

      // #then no error code — the caller skips telemetry entirely
      expect(code).toBeNull()
    })

    it('names the crashed worker from details.name, not the constant mojo serviceName', () => {
      // #given exactly what Electron sends in production: the fork's `serviceName`
      // option lands in details.name, while details.serviceName is the mojo
      // interface name — a constant, identical for all four of our forks.
      const code = childProcessGoneErrorCode({
        type: 'Utility',
        reason: 'crashed',
        serviceName: 'node.mojom.NodeService',
        name: 'Embeddings',
        exitCode: 11
      })

      // #then the code names the worker we can act on
      expect(code).toBe('Utility:crashed:Embeddings')
    })

    it('falls back to serviceName when name is absent', () => {
      // #given a process Electron reports without a `name`
      const code = childProcessGoneErrorCode({
        type: 'Utility',
        reason: 'crashed',
        serviceName: 'Network Service'
      })

      // #then serviceName still identifies it rather than leaving the code empty
      expect(code).toBe('Utility:crashed:Network_Service')
    })

    it('handles processes without a name or serviceName', () => {
      const code = childProcessGoneErrorCode({ type: 'GPU', reason: 'abnormal-exit' })
      expect(code).toBe('GPU:abnormal-exit:')
    })

    it('sanitizes unsafe name characters', () => {
      const code = childProcessGoneErrorCode({
        type: 'Utility',
        reason: 'crashed',
        name: 'node service (v2)'
      })
      expect(code).toBe('Utility:crashed:node_service__v2_')
    })
  })

  describe('trackChildProcessGone', () => {
    it('emits no telemetry for a clean idle-worker exit', () => {
      trackChildProcessGone({
        type: 'Utility',
        reason: 'clean-exit',
        serviceName: 'node.mojom.NodeService',
        name: 'Embeddings',
        exitCode: 0
      })
      expect(trackMainEventMock).not.toHaveBeenCalled()
    })

    it('emits no telemetry for a memory-eviction (OS memory-pressure kill)', () => {
      trackChildProcessGone({
        type: 'GPU',
        reason: 'memory-eviction',
        serviceName: 'node.mojom.NodeService'
      })
      expect(trackMainEventMock).not.toHaveBeenCalled()
    })

    it('names the worker and carries the exit signal for a real production crash', () => {
      // #given the exact production payload behind `Utility:crashed:node.mojom.NodeService`
      trackChildProcessGone({
        type: 'Utility',
        reason: 'crashed',
        serviceName: 'node.mojom.NodeService',
        name: 'Embeddings',
        exitCode: 11
      })

      // #then Grafana can group by worker, and exitCode carries the signal (11 = SIGSEGV)
      expect(trackMainEventMock).toHaveBeenCalledWith('app_log_recorded', {
        surface: 'app',
        action: 'error',
        objectType: 'log',
        source: 'Electron',
        result: 'failed',
        errorCode: 'Utility:crashed:Embeddings',
        // A dead child leaves no JS stack in this process, so this message is the
        // only thing PostHog's Error Tracking issue page can show for this family.
        error: { message: 'Embeddings utility process crashed (exit 11)' },
        dimensions: { log_action: 'child_process_gone' },
        metrics: { value: 11 }
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

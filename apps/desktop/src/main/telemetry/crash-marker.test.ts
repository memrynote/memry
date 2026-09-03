import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { mockApp } from '@tests/utils/mock-electron'

vi.mock('electron', () => ({
  app: mockApp
}))

vi.mock('./track', () => ({
  trackMainEvent: vi.fn()
}))

import {
  CRASH_MARKER_FILENAME,
  clearCrashMarker,
  detectUncleanShutdown,
  installCrashMarker,
  markShutdownFailure
} from './crash-marker'
import { trackMainEvent } from './track'

describe('crash marker', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-crash-marker-'))
    mockApp.getPath.mockImplementation((name: string) =>
      name === 'userData' ? tempDir : `/mock/${name}`
    )
    vi.mocked(trackMainEvent).mockClear()
  })

  afterEach(() => {
    clearCrashMarker()
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  const markerFile = (): string => path.join(tempDir, CRASH_MARKER_FILENAME)

  it('emits nothing when no prior marker exists (clean quit or first launch)', () => {
    // #given no marker on disk
    // #when detecting
    detectUncleanShutdown()

    // #then no crash event is emitted
    expect(trackMainEvent).not.toHaveBeenCalled()
  })

  it('emits app_crashed with the observed prior uptime when a marker survives', () => {
    // #given a marker left behind by a session that lived 90 seconds
    const startedAt = new Date('2026-08-06T10:00:00.000Z').toISOString()
    const lastAliveAt = new Date('2026-08-06T10:01:30.000Z').toISOString()
    fs.writeFileSync(
      markerFile(),
      JSON.stringify({ sessionId: 'prior', startedAt, lastAliveAt, appVersion: '1.2.3' })
    )

    // #when detecting
    detectUncleanShutdown()

    // #then app_crashed carries the duration and the prior version
    expect(trackMainEvent).toHaveBeenCalledWith(
      'app_crashed',
      expect.objectContaining({
        surface: 'app',
        action: 'unclean_shutdown',
        result: 'failed',
        errorCode: 'UNCLEAN_SHUTDOWN',
        metrics: { durationMs: 90_000 },
        dimensions: { prior_app_version: '1.2.3' }
      })
    )
  })

  // #1989: UNCLEAN_SHUTDOWN was an Error Tracking issue titled after its own
  // error code, with nothing in it. The message is what #1993 has to read.
  it('names the shutdown phase, prior version and uptime in the message', () => {
    const startedAt = new Date('2026-08-06T10:00:00.000Z').toISOString()
    const lastAliveAt = new Date('2026-08-06T10:01:30.000Z').toISOString()
    fs.writeFileSync(
      markerFile(),
      JSON.stringify({
        sessionId: 'prior',
        startedAt,
        lastAliveAt,
        appVersion: '1.2.3',
        shutdownFailure: 'timeout',
        shutdownStep: 'crdt-flush'
      })
    )

    detectUncleanShutdown()

    expect(trackMainEvent).toHaveBeenCalledWith(
      'app_crashed',
      expect.objectContaining({
        error: {
          message:
            'Unclean shutdown [failure=timeout] [step=crdt-flush] [prior_version=1.2.3] [uptime_ms=90000] [marker=parsed]'
        }
      })
    )
  })

  // The marker is a file on disk. An over-512 message fails the schema at the
  // sync-server, which 400s the whole batch and the client then drops it for
  // good — so a torn write must not cost 100 unrelated events.
  it('bounds a corrupt marker field instead of shipping it', () => {
    fs.writeFileSync(
      markerFile(),
      JSON.stringify({
        sessionId: 'prior',
        startedAt: new Date('2026-08-06T10:00:00.000Z').toISOString(),
        lastAliveAt: new Date('2026-08-06T10:00:01.000Z').toISOString(),
        shutdownFailure: `/Users/kaan/${'x'.repeat(600)}.md`
      })
    )

    detectUncleanShutdown()

    const [, options] = vi.mocked(trackMainEvent).mock.calls[0]
    expect(options.error?.message).toBe(
      'Unclean shutdown [failure=none] [step=unknown] [prior_version=unknown] [uptime_ms=1000] [marker=parsed]'
    )
  })

  it('still emits app_crashed when the marker is unparseable — presence IS the signal', () => {
    // #given a corrupt marker
    fs.writeFileSync(markerFile(), 'not json at all')

    // #when detecting
    detectUncleanShutdown()

    // #then the crash is reported without metrics/dimensions
    expect(trackMainEvent).toHaveBeenCalledWith(
      'app_crashed',
      expect.objectContaining({ errorCode: 'UNCLEAN_SHUTDOWN', metrics: undefined })
    )
  })

  it('install writes the marker; clear removes it so the next launch sees nothing', () => {
    // #given an installed marker for this session
    installCrashMarker('session-1', '1.2.3')
    expect(fs.existsSync(markerFile())).toBe(true)
    const written = JSON.parse(fs.readFileSync(markerFile(), 'utf-8')) as {
      sessionId: string
      appVersion: string
    }
    expect(written.sessionId).toBe('session-1')
    expect(written.appVersion).toBe('1.2.3')

    // #when quitting cleanly
    clearCrashMarker()

    // #then the marker is gone and a fresh detect emits nothing
    expect(fs.existsSync(markerFile())).toBe(false)
    detectUncleanShutdown()
    expect(trackMainEvent).not.toHaveBeenCalled()
  })

  it('reports a stamped shutdown failure with its own errorCode on the next launch', () => {
    // #given a session whose shutdown hit the forced-exit timeout
    installCrashMarker('session-1', '1.2.3')
    markShutdownFailure('timeout')

    // #when the "next launch" detects the leftover marker
    detectUncleanShutdown()

    // #then the crash event distinguishes the hung shutdown from a hard crash
    expect(trackMainEvent).toHaveBeenCalledWith(
      'app_crashed',
      expect.objectContaining({ errorCode: 'SHUTDOWN_TIMEOUT' })
    )
  })

  it('names the overrunning step in the errorCode so a timeout is diagnosable', () => {
    // #given a shutdown whose budget ran out while the sync runtime was stopping
    installCrashMarker('session-1', '1.2.3')
    markShutdownFailure('timeout', 'stop-sync-runtime')

    // #when the next launch detects the leftover marker
    detectUncleanShutdown()

    // #then the code still starts with SHUTDOWN_TIMEOUT (dashboards keep
    // matching) but says which step overran
    expect(trackMainEvent).toHaveBeenCalledWith(
      'app_crashed',
      expect.objectContaining({ errorCode: 'SHUTDOWN_TIMEOUT_STOP_SYNC_RUNTIME' })
    )
  })

  it('falls back to the plain code when the stamped step is not a known token', () => {
    // #given a marker whose step field did not survive intact
    const startedAt = new Date('2026-08-06T10:00:00.000Z').toISOString()
    fs.writeFileSync(
      markerFile(),
      JSON.stringify({
        sessionId: 'prior',
        startedAt,
        lastAliveAt: startedAt,
        shutdownFailure: 'timeout',
        shutdownStep: '/Users/someone/Notes/secret plan.md'
      })
    )

    // #when the next launch detects it
    detectUncleanShutdown()

    // #then nothing unbounded reaches the errorCode
    expect(trackMainEvent).toHaveBeenCalledWith(
      'app_crashed',
      expect.objectContaining({ errorCode: 'SHUTDOWN_TIMEOUT' })
    )
  })

  it('reads a marker written before shutdown steps were recorded', () => {
    // #given a marker from an older build: timeout stamped, no step field
    const startedAt = new Date('2026-08-06T10:00:00.000Z').toISOString()
    fs.writeFileSync(
      markerFile(),
      JSON.stringify({
        sessionId: 'prior',
        startedAt,
        lastAliveAt: startedAt,
        shutdownFailure: 'timeout'
      })
    )

    // #when the next launch detects it
    detectUncleanShutdown()

    // #then it still reports the timeout it always did
    expect(trackMainEvent).toHaveBeenCalledWith(
      'app_crashed',
      expect.objectContaining({ errorCode: 'SHUTDOWN_TIMEOUT' })
    )
  })

  it('survives an unwritable userData without throwing', () => {
    // #given a userData path that cannot be written
    mockApp.getPath.mockImplementation(() => path.join(tempDir, 'missing', 'nested'))

    // #when installing and clearing
    // #then neither throws
    expect(() => installCrashMarker('session-1')).not.toThrow()
    expect(() => clearCrashMarker()).not.toThrow()
  })
})

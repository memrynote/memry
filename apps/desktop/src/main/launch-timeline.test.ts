import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const scopedLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn()
}
const trackLaunchPhaseMock = vi.fn()

vi.mock('./lib/logger', () => ({
  createLogger: vi.fn(() => scopedLogger)
}))

vi.mock('./telemetry/diagnostics', () => ({
  trackLaunchPhase: trackLaunchPhaseMock
}))

const LAUNCH_AT = new Date('2026-07-22T10:00:00.000Z').getTime()

// The module stamps process start at import time, so every test gets a fresh
// copy with the clock parked at LAUNCH_AT.
async function importTimeline(): Promise<typeof import('./launch-timeline')> {
  vi.resetModules()
  vi.setSystemTime(LAUNCH_AT)
  return import('./launch-timeline')
}

describe('launch timeline', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    scopedLogger.info.mockClear()
    scopedLogger.warn.mockClear()
    trackLaunchPhaseMock.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('reports every phase offset in a single line on a healthy launch', async () => {
    const { recordLaunchPhase, reportLaunchTimeline } = await importTimeline()

    vi.setSystemTime(LAUNCH_AT + 300)
    recordLaunchPhase('app_ready')
    vi.setSystemTime(LAUNCH_AT + 420)
    recordLaunchPhase('window_created')
    vi.setSystemTime(LAUNCH_AT + 430)
    recordLaunchPhase('vault_open_start')
    vi.setSystemTime(LAUNCH_AT + 900)
    recordLaunchPhase('vault_open_ready')
    vi.setSystemTime(LAUNCH_AT + 1100)
    recordLaunchPhase('window_did_finish_load')
    vi.setSystemTime(LAUNCH_AT + 1200)
    recordLaunchPhase('window_ready_to_show')
    recordLaunchPhase('window_shown')

    reportLaunchTimeline('ready-to-show')

    expect(scopedLogger.warn).not.toHaveBeenCalled()
    expect(scopedLogger.info).toHaveBeenCalledTimes(1)
    expect(scopedLogger.info).toHaveBeenCalledWith('launch timeline', {
      reason: 'ready-to-show',
      appReadyMs: 300,
      windowCreatedMs: 420,
      vaultOpenStartMs: 430,
      vaultOpenReadyMs: 900,
      rendererLoadedMs: 1100,
      readyToShowMs: 1200,
      shownMs: 1200,
      fallback: false,
      vaultOpenPending: false
    })
  })

  it('warns with the fallback flag and the unfinished vault open when the deadline is missed', async () => {
    const { recordLaunchPhase, reportLaunchTimeline } = await importTimeline()

    vi.setSystemTime(LAUNCH_AT + 250)
    recordLaunchPhase('app_ready')
    recordLaunchPhase('window_created')
    recordLaunchPhase('vault_open_start')
    vi.setSystemTime(LAUNCH_AT + 10_250)
    recordLaunchPhase('window_shown')

    reportLaunchTimeline('fallback-timeout')

    expect(scopedLogger.info).not.toHaveBeenCalled()
    expect(scopedLogger.warn).toHaveBeenCalledWith('launch timeline', {
      reason: 'fallback-timeout',
      appReadyMs: 250,
      windowCreatedMs: 250,
      vaultOpenStartMs: 250,
      shownMs: 10_250,
      fallback: true,
      vaultOpenPending: true
    })
  })

  it('warns on a slow launch even when ready-to-show did fire', async () => {
    const { recordLaunchPhase, reportLaunchTimeline } = await importTimeline()

    vi.setSystemTime(LAUNCH_AT + 6_000)
    recordLaunchPhase('window_ready_to_show')
    recordLaunchPhase('window_shown')

    reportLaunchTimeline('ready-to-show')

    expect(scopedLogger.info).not.toHaveBeenCalled()
    expect(scopedLogger.warn).toHaveBeenCalledTimes(1)
    expect(scopedLogger.warn.mock.calls[0][1]).toMatchObject({
      reason: 'ready-to-show',
      fallback: false,
      shownMs: 6_000
    })
  })

  it('emits the timeline only once per launch', async () => {
    const { recordLaunchPhase, reportLaunchTimeline } = await importTimeline()

    recordLaunchPhase('window_shown')
    reportLaunchTimeline('ready-to-show')
    reportLaunchTimeline('did-fail-load')

    expect(scopedLogger.info).toHaveBeenCalledTimes(1)
    expect(scopedLogger.warn).not.toHaveBeenCalled()
  })

  it('keeps the first stamp for a repeated phase but still tracks every occurrence', async () => {
    const { recordLaunchPhase, reportLaunchTimeline } = await importTimeline()

    vi.setSystemTime(LAUNCH_AT + 500)
    recordLaunchPhase('window_created')
    vi.setSystemTime(LAUNCH_AT + 9_000)
    recordLaunchPhase('window_created')
    recordLaunchPhase('window_shown')

    reportLaunchTimeline('ready-to-show')

    expect(scopedLogger.warn.mock.calls[0][1]).toMatchObject({ windowCreatedMs: 500 })
    expect(trackLaunchPhaseMock).toHaveBeenCalledWith('window_created', 500)
    expect(trackLaunchPhaseMock).toHaveBeenCalledWith('window_created', 9_000)
  })
})

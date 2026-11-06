import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { test, expect } from '../../harness/test'
import { invokeTest, sendTest } from '../../harness/invoke-test'
import { isAlive } from '../../harness/app-process'
import { sendQuitEvent } from '../../harness/mac-quit-event'
import { appInfo, restart } from '../../harness/tauri-lifecycle'
import { pollUntil, readMainLog, waitForMainLog } from '../../harness/wait'

const markerPath = (dataDir: string): string => join(dataDir, 'session-marker.json')

interface SessionMarker {
  shutdownFailure?: string
  shutdownStep?: string
}

// What the quit logs when one of its bounded waits runs out: a window's flush, the write-back
// flush, a close hook, a projection or background task, the telemetry flush, the budget.
const EXPIRED_WAIT =
  /timed out|ran out of|overran|cut short|did not stop before the deadline|backstop reached/

async function quitAndMeasure(app: { executor: never; pid: number }): Promise<number> {
  await sendTest(app, 'e2e_request_quit')
  const startedAt = Date.now()
  const exited = await pollUntil(() => !isAlive(app.pid), { timeoutMs: 15_000, intervalMs: 50 })
  expect(exited).toBe(true)
  return Date.now() - startedAt
}

test('the renderer answers a flush request for its own window', async ({ app }) => {
  expect(await invokeTest<boolean>(app, 'e2e_request_flush', { label: 'main' })).toBe(true)
})

test('a flush request to a window that does not listen returns instead of hanging', async ({
  app
}) => {
  expect(await invokeTest<boolean>(app, 'e2e_request_flush', { label: 'no-such-window' })).toBe(
    false
  )
  // Logged only when the request returns without waiting for a reply.
  expect(
    await waitForMainLog(
      app,
      'the page of window no-such-window does not listen for flushes; its flush is skipped'
    )
  ).toBe(true)
})

// A page that is still loading (at a launch, after a reload) holds no edits and cannot answer
// yet: the flush request it missed held the quit for the whole flush timeout (#3967).
test('a quit while the page loads does not wait for its flush', async ({ app }) => {
  await invokeTest(app, 'e2e_quit_on_page_start')
  // An async script: its result reaches the driver before the reload, which a sync script's
  // polled result does not (#3967).
  await app.executor.executeAsync(
    'const done = arguments[arguments.length - 1]; done(null); setTimeout(() => location.reload())'
  )
  expect(await pollUntil(() => !isAlive(app.pid), { timeoutMs: 15_000, intervalMs: 50 })).toBe(true)
  const log = readMainLog(app.dirs.logDir)
  expect(log).toContain('quitting as the main page starts')
  expect(log).toContain('cleanup complete')
  expect(log).not.toContain('flush of window main timed out')
  expect(log).toContain('the page of window main does not listen for flushes; its flush is skipped')
})

// The quit's own logs say whether it waited on a timer; a wall-clock bound measures the runner's
// load instead (5.6 s on a loaded Windows runner with every wait answered in time, #3967).
test('a clean quit waits on no timeout and leaves no crash marker', async ({ app }) => {
  const { appDataDir, logDir } = await appInfo(app)
  expect(existsSync(markerPath(appDataDir))).toBe(true)
  await quitAndMeasure(app as never)
  expect(existsSync(markerPath(appDataDir))).toBe(false)
  const log = readMainLog(logDir)
  const quit = log.slice(log.indexOf('starting graceful shutdown'))
  expect(quit).toContain('cleanup complete')
  expect(quit).not.toMatch(EXPIRED_WAIT)
})

test('a hung step is forced out within 10.5 s and named for the next launch', async ({ app }) => {
  const { appDataDir } = await appInfo(app)
  await invokeTest(app, 'e2e_trigger_shutdown_overrun', { step: 'stop-sync-runtime' })
  const elapsed = await quitAndMeasure(app as never)
  expect(elapsed).toBeLessThan(10_500)

  const marker = JSON.parse(readFileSync(markerPath(appDataDir), 'utf8')) as SessionMarker
  expect(marker.shutdownFailure).toBe('timeout')
  expect(marker.shutdownStep).toBe('stop-sync-runtime')

  // The next launch starts normally on the same profile and replaces the marker.
  await restart(app)
  const next = JSON.parse(readFileSync(markerPath(appDataDir), 'utf8')) as SessionMarker
  expect(next.shutdownStep).toBeUndefined()
})

test('a Log Out quit event is accepted, and the app quits through the sequence', async ({
  app
}) => {
  test.skip(process.platform !== 'darwin', 'Apple events are macOS-only')
  const { appDataDir, logDir } = await appInfo(app)
  expect(sendQuitEvent(app.pid, 'rlgo')).toBe('errn 0')
  expect(await pollUntil(() => !isAlive(app.pid), { timeoutMs: 15_000, intervalMs: 50 })).toBe(true)
  expect(existsSync(markerPath(appDataDir))).toBe(false)
  const log = readMainLog(logDir)
  expect(log).toContain('macOS asked the app to terminate (quit reason rlgo)')
  expect(log).toContain('accepting the quit macOS asked for')
})

// A Log Out that a hung step holds up still goes through: the quit is never refused, and the
// forced exit ends the process within the budget.
test('a Log Out quit event with a hung step is forced out within 10.5 s, never refused', async ({
  app
}) => {
  test.skip(process.platform !== 'darwin', 'Apple events are macOS-only')
  const { appDataDir, logDir } = await appInfo(app)
  await invokeTest(app, 'e2e_trigger_shutdown_overrun', { step: 'stop-sync-runtime' })
  const startedAt = Date.now()
  expect(sendQuitEvent(app.pid, 'rlgo')).toBe('errn 0')
  expect(await pollUntil(() => !isAlive(app.pid), { timeoutMs: 15_000, intervalMs: 50 })).toBe(true)
  expect(Date.now() - startedAt).toBeLessThan(10_500)
  // The event reached `applicationShouldTerminate:`, which started the sequence that overran.
  expect(readMainLog(logDir)).toContain('macOS asked the app to terminate (quit reason rlgo)')

  const marker = JSON.parse(readFileSync(markerPath(appDataDir), 'utf8')) as SessionMarker
  expect(marker.shutdownFailure).toBe('timeout')
  expect(marker.shutdownStep).toBe('stop-sync-runtime')
})

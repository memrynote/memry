import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { test, expect } from '../../harness/test'
import { invokeTest } from '../../harness/invoke-test'
import { isAlive } from '../../harness/app-process'
import { appInfo, restart } from '../../harness/tauri-lifecycle'
import { pollUntil, readMainLog } from '../../harness/wait'

const markerPath = (dataDir: string): string => join(dataDir, 'session-marker.json')

interface SessionMarker {
  shutdownFailure?: string
  shutdownStep?: string
}

async function quitAndMeasure(app: { executor: never; pid: number }): Promise<number> {
  await invokeTest(app, 'e2e_request_quit')
  const startedAt = Date.now()
  const exited = await pollUntil(() => !isAlive(app.pid), { timeoutMs: 15_000, intervalMs: 50 })
  expect(exited).toBe(true)
  return Date.now() - startedAt
}

test('the renderer answers a flush request for its own window', async ({ app }) => {
  expect(await invokeTest<boolean>(app, 'e2e_request_flush', { label: 'main' })).toBe(true)
})

test('a flush request nobody answers times out instead of hanging', async ({ app }) => {
  const startedAt = Date.now()
  expect(await invokeTest<boolean>(app, 'e2e_request_flush', { label: 'no-such-window' })).toBe(
    false
  )
  expect(Date.now() - startedAt).toBeLessThan(4_000)
})

test('a clean quit exits promptly and leaves no crash marker', async ({ app }) => {
  const { appDataDir } = await appInfo(app)
  expect(existsSync(markerPath(appDataDir))).toBe(true)
  const elapsed = await quitAndMeasure(app as never)
  expect(elapsed).toBeLessThan(3_000)
  expect(existsSync(markerPath(appDataDir))).toBe(false)
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

// What loginwindow sends at Log Out: `aevt`/`quit` with the quit reason `rlgo` (kAEReallyLogOut),
// sent to the pid through the Apple Event Manager, as a JXA script (the e2e build is no bundle, so
// `quit app` cannot name it). Dock Quit and `quit app` send the same event without a reason. A
// refused quit answers userCanceledErr (-128), which loginwindow reads as a cancelled logout.
const SEND_QUIT_EVENT = `function run([pid, reason]) {
  ObjC.import('Foundation')
  const code = (s) => s.split('').reduce((n, c) => n * 256 + c.charCodeAt(0), 0)
  const target = $.NSAppleEventDescriptor.descriptorWithProcessIdentifier(Number(pid))
  const event = $.NSAppleEventDescriptor.appleEventWithEventClassEventIDTargetDescriptorReturnIDTransactionID(code('aevt'), code('quit'), target, -1, 0)
  event.setAttributeDescriptorForKeyword($.NSAppleEventDescriptor.descriptorWithTypeCode(code(reason)), code('why?'))
  const error = Ref()
  const reply = event.sendEventWithOptionsTimeoutError(3, 30, error)
  if (reply.isNil()) return 'error ' + error[0].code
  const errn = reply.paramDescriptorForKeyword(code('errn'))
  return 'errn ' + (errn.isNil() ? 0 : errn.int32Value)
}`

test('a Log Out quit event is accepted, and the app quits through the sequence', async ({
  app
}) => {
  test.skip(process.platform !== 'darwin', 'Apple events are macOS-only')
  const { appDataDir, logDir } = await appInfo(app)
  const reply = spawnSync(
    'osascript',
    ['-l', 'JavaScript', '-e', SEND_QUIT_EVENT, String(app.pid), 'rlgo'],
    { encoding: 'utf8', timeout: 15_000 }
  )
  expect(reply.stdout.trim()).toBe('errn 0')
  expect(await pollUntil(() => !isAlive(app.pid), { timeoutMs: 15_000, intervalMs: 50 })).toBe(true)
  expect(existsSync(markerPath(appDataDir))).toBe(false)
  const log = readMainLog(logDir)
  expect(log).toContain('macOS asked the app to terminate (quit reason rlgo)')
  expect(log).toContain('accepting the quit macOS asked for')
})

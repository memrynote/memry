// The in-app updater over the scripted backend (`MEMRY_TEST_UPDATER=scripted`): what the user
// sees for each state, what the preferences write, and how the quit hands a downloaded update
// to the installer. Every apply the backend saw is a line of `e2e-updater-applies.jsonl` in the
// data dir, so a spec reads it after the process exited.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import * as http from 'node:http'
import { join } from 'node:path'

import { test, expect } from '../../harness/test'
import { invokeTest, sendTest } from '../../harness/invoke-test'
import { isAlive } from '../../harness/app-process'
import { SELECTORS } from '../../harness/app-helpers'
import { sendQuitEvent } from '../../harness/mac-quit-event'
import {
  startFakeSessionManager,
  type Desktop,
  type FakeSessionManager
} from '../../harness/session-manager'
import { appInfo, restart } from '../../harness/tauri-lifecycle'
import { invoke } from '../../harness/vault-commands'
import { pollUntil, readMainLog, waitForMainLog } from '../../harness/wait'
import type { Page } from '../../harness/pw-compat/page'

interface ShippedEvent {
  name: string
  action: string
  source?: string
  errorCode?: string
}

/** What the app's telemetry shipped, as the sync server's `/telemetry/batch` receives it. */
const shipped: ShippedEvent[] = []
const telemetryServer = http.createServer((request, response) => {
  let body = ''
  request.on('data', (chunk) => {
    body += chunk
  })
  request.on('end', () => {
    const batch = JSON.parse(body || '{}') as { events?: ShippedEvent[] }
    shipped.push(...(batch.events ?? []))
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ accepted: batch.events?.length ?? 0 }))
  })
})
await new Promise<void>((resolve) => telemetryServer.listen(0, '127.0.0.1', resolve))
telemetryServer.unref()
const telemetryAddress = telemetryServer.address()
const telemetryPort =
  typeof telemetryAddress === 'object' && telemetryAddress ? telemetryAddress.port : 0

// Telemetry stays off (the e2e build is not a production one) until a test turns it on.
test.use({
  extraEnv: {
    MEMRY_TEST_UPDATER: 'scripted',
    TELEMETRY_ENDPOINT: `http://127.0.0.1:${telemetryPort}/telemetry/batch`
  }
})

const VERSION = 'v2026-11-01'
const NOTES = '<h2>New</h2><ul><li>Faster sync on large vaults</li></ul>'

interface UpdateState {
  currentVersion: string
  status: string
  lastCheckedAt: number | null
  availableVersion: string | null
  error: string | null
  autoDownloadEnabled: boolean
  autoCheckEnabled: boolean
}

interface ApplyCall {
  silent: boolean
  restart: boolean
}

type App = Parameters<typeof appInfo>[0] & { pid: number }

const available = { kind: 'available', version: '2026.1101.1', notesHtml: NOTES }

const state = (page: Page): Promise<UpdateState> => invoke<UpdateState>(page, 'updater_get_state')

/**
 * Queues what the next checks find. The startup check runs as the window shows; scripting before
 * it ended would hand it the first step.
 */
async function script(app: App, page: Page, steps: unknown[]): Promise<void> {
  await expect
    .poll(async () => {
      const current = await state(page)
      return current.lastCheckedAt !== null && current.status !== 'checking'
    })
    .toBe(true)
  await invokeTest(app, 'e2e_updater_script', { steps })
}

/** A manual check, as the Settings button and the menu run it. */
const check = (page: Page): Promise<UpdateState> =>
  invoke<UpdateState>(page, 'updater_check_for_updates')

function applies(dataDir: string): ApplyCall[] {
  const file = join(dataDir, 'e2e-updater-applies.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ApplyCall)
}

function updaterPrefs(dataDir: string): Record<string, unknown> | undefined {
  const config = JSON.parse(readFileSync(join(dataDir, 'memry-config.json'), 'utf8')) as {
    updater?: Record<string, unknown>
  }
  return config.updater
}

async function download(app: App, page: Page): Promise<void> {
  await script(app, page, [available])
  await check(page)
  await invoke(page, 'updater_download_update')
  await expect.poll(async () => (await state(page)).status).toBe('downloaded')
}

async function waitForExit(app: App): Promise<void> {
  expect(await pollUntil(() => !isAlive(app.pid), { timeoutMs: 15_000, intervalMs: 50 })).toBe(true)
}

test('a manual check surfaces the release, and its notes open in a background tab after the install', async ({
  app,
  page
}) => {
  await script(app, page, [available])
  expect((await check(page)).status).toBe('available')

  await page.getByRole('button', { name: /Update available/ }).click()
  await expect(page.getByText(`MemryNote ${VERSION} is available`)).toBeVisible()
  await expect(page.getByText('Faster sync on large vaults')).toBeVisible()

  // The launch after the install runs the release the popover offered.
  // A new object: the file's launch options share the old one with every later test.
  app.control.extraEnv = { ...app.control.extraEnv, MEMRY_TEST_UPDATER_VERSION: available.version }
  await restart(app)
  await expect.poll(async () => (await state(page)).currentVersion).toBe(VERSION)

  const notesTab = page.locator(`${SELECTORS.tab}[aria-label="MemryNote 2026-11-01"]`)
  await expect(notesTab).toHaveCount(1)
  // Opened in the background: the tab the user was on keeps the focus.
  await expect(notesTab).toHaveAttribute('aria-selected', 'false')
  await notesTab.click()
  await expect(page.getByRole('heading', { name: 'New', exact: true })).toBeVisible()
  await expect(page.getByText('Faster sync on large vaults')).toBeVisible()
})

test('a skipped version stays hidden until a manual check', async ({ app, page }) => {
  const { appDataDir } = await appInfo(app)
  await script(app, page, [available])
  await check(page)

  await page.getByRole('button', { name: /Update available/ }).click()
  await page.getByRole('button', { name: 'More update options' }).click()
  await page.getByText(`Skip ${VERSION}`).click()

  await expect.poll(async () => (await state(page)).status).toBe('up-to-date')
  await expect(page.getByRole('button', { name: /Update available/ })).toHaveCount(0)
  expect(updaterPrefs(appDataDir)?.skippedVersion).toBe(VERSION)

  // A manual check clears the skip, so the same release surfaces again.
  await script(app, page, [available])
  expect((await check(page)).status).toBe('available')
  expect(updaterPrefs(appDataDir)?.skippedVersion).toBeUndefined()
})

test('turning auto download on downloads a waiting update', async ({ app, page }) => {
  const { appDataDir } = await appInfo(app)
  await script(app, page, [available])
  await check(page)

  await invoke(page, 'updater_set_auto_download', { enabled: true })
  await expect.poll(async () => (await state(page)).status).toBe('downloaded')
  await expect(page.getByRole('button', { name: /Update ready/ })).toBeVisible()
  expect(updaterPrefs(appDataDir)?.autoDownload).toBe(true)
})

test('an offline check rejects with its network code and leaves the error in the state', async ({
  app,
  page
}) => {
  await script(app, page, [{ kind: 'fail', error: 'offline' }])
  // Caught in the page: a rejection that reaches the driver makes it retry the script.
  const rejected = await page.evaluate(() =>
    window.__TAURI__.core.invoke('updater_check_for_updates').then(
      () => null,
      (error: unknown) => JSON.stringify(error)
    )
  )
  expect(rejected).toContain('"code":"HOST_NOT_FOUND"')
  const after = await state(page)
  expect(after.status).toBe('error')
  expect(after.error).toContain('could not be resolved')
})

/** Every updater failure telemetry shipped, after a flush of what is queued. */
async function shippedUpdaterFailures(page: Page): Promise<ShippedEvent[]> {
  await invoke(page, 'telemetry_flush')
  return shipped.filter(
    (event) =>
      event.source === 'updater' &&
      (event.name === 'app_error_seen' || event.name === 'app_log_recorded')
  )
}

test('an offline check is a warning and shows one error, with no failed-update row', async ({
  app,
  page
}) => {
  await invoke(page, 'telemetry_set_enabled', { enabled: true })
  await script(app, page, [
    { kind: 'fail', error: 'offline' },
    { kind: 'fail', error: 'offline' }
  ])
  // Counts every error toast that appears, since a toast leaves on its own after a few seconds.
  await page.evaluate(() => {
    const body = document.body
    body.dataset.errorToasts = '0'
    new MutationObserver((records) => {
      const selector = '[data-sonner-toast][data-type="error"]'
      for (const record of records)
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue
          const added = (node.matches(selector) ? 1 : 0) + node.querySelectorAll(selector).length
          body.dataset.errorToasts = String(Number(body.dataset.errorToasts) + added)
        }
    }).observe(body, { childList: true, subtree: true })
  })
  const errorToasts = () => page.evaluate(() => Number(document.body.dataset.errorToasts))

  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'General', exact: true }).click()
  await page.getByRole('button', { name: 'Check now' }).click()
  await expect.poll(async () => (await state(page)).status).toBe('error')
  await expect.poll(errorToasts).toBe(1)
  await expect(page.getByText(/could not be resolved/).first()).toBeVisible()
  // Red is for an install that failed; being offline is not one.
  await expect(page.getByText('Update failed')).toHaveCount(0)
  await expect(page.getByRole('dialog')).toHaveCount(0)

  // Turning auto check back on runs a check in the background, which fails offline again.
  const autoCheck = page.getByRole('switch', { name: 'Automatically check for updates' })
  await autoCheck.click()
  await expect.poll(async () => (await state(page)).autoCheckEnabled).toBe(false)
  await autoCheck.click()
  await expect.poll(async () => (await shippedUpdaterFailures(page)).length).toBe(2)

  const failures = await shippedUpdaterFailures(page)
  // A warning (`app_log_recorded` at `warn`), never an exception in Error Tracking.
  expect(failures.map(({ name, action, errorCode }) => ({ name, action, errorCode }))).toEqual([
    { name: 'app_log_recorded', action: 'warn', errorCode: 'HOST_NOT_FOUND' },
    { name: 'app_log_recorded', action: 'warn', errorCode: 'HOST_NOT_FOUND' }
  ])
  expect(await errorToasts()).toBe(1)
  // Back in the workspace, the sidebar footer has no failed-update row either.
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('settings-view')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Update failed' })).toHaveCount(0)
})

test('Restart to install shows the Installing screen and hands off once with a relaunch', async ({
  app,
  page
}) => {
  const { appDataDir } = await appInfo(app)
  await download(app, page)
  // A step that never ends holds the quit until the backstop, so the screen stays up.
  await invokeTest(app, 'e2e_trigger_shutdown_overrun', { step: 'stop-sync-runtime' })

  await page.getByRole('button', { name: /Update ready/ }).click()
  await page.getByRole('button', { name: 'Restart now' }).click()
  await expect(page.getByText(`Installing ${VERSION}`)).toBeVisible()

  await waitForExit(app)
  expect(applies(appDataDir)).toEqual([{ silent: true, restart: true }])
  const marker = JSON.parse(
    readFileSync(join(appDataDir, 'update-install-attempt.json'), 'utf8')
  ) as { toVersion?: string; installer?: string }
  expect(marker).toMatchObject({ toVersion: VERSION, installer: 'velopack' })
})

test('Restart to install on a quick quit hands off once with a relaunch', async ({ app, page }) => {
  const { appDataDir } = await appInfo(app)
  await download(app, page)

  await page.getByRole('button', { name: /Update ready/ }).click()
  const restartNow = page.getByRole('button', { name: 'Restart now' })
  await expect(restartNow).toBeVisible()
  // Nothing holds this quit, so the app can exit before the click's reply comes back
  // (ECONNREFUSED on linux-x64, run 41154998415). The exit and the apply below are the proof.
  await restartNow.click().catch(() => undefined)

  await waitForExit(app)
  expect(applies(appDataDir)).toEqual([{ silent: true, restart: true }])
  const marker = JSON.parse(
    readFileSync(join(appDataDir, 'update-install-attempt.json'), 'utf8')
  ) as { toVersion?: string; installer?: string }
  expect(marker).toMatchObject({ toVersion: VERSION, installer: 'velopack' })
})

test('a normal quit installs a downloaded update without a relaunch', async ({ app, page }) => {
  const { appDataDir } = await appInfo(app)
  await download(app, page)

  await sendTest(app, 'e2e_request_quit')
  await waitForExit(app)
  expect(applies(appDataDir)).toEqual([{ silent: true, restart: false }])
})

test('a third failed install of the same release offers the manual installer', async ({
  app,
  page
}) => {
  const { appDataDir } = await appInfo(app)
  // The streak `updater-install-health.ts` writes after three failed installs of one release.
  writeFileSync(
    join(appDataDir, 'update-install-health.json'),
    JSON.stringify({
      fromVersion: (await state(page)).currentVersion,
      targetVersion: VERSION,
      consecutiveFailures: 3,
      escalated: true
    })
  )
  await restart(app)

  await expect(page.getByText(`MemryNote couldn't finish installing ${VERSION}`)).toBeVisible()
  await expect(page.getByRole('button', { name: `Download ${VERSION} manually` })).toBeVisible()
})

test('a build still running after its own install offers the manual installer', async ({
  app,
  page
}) => {
  const { appDataDir, version } = await appInfo(app)
  const marker = join(appDataDir, 'update-install-attempt.json')
  // What this build writes before it hands off to the installer (`marker.rs`). Launching as the
  // same build again means the install never applied.
  writeFileSync(
    marker,
    JSON.stringify({
      fromVersion: version,
      toVersion: VERSION,
      startedAt: new Date().toISOString(),
      installer: 'velopack'
    })
  )
  await restart(app)

  await expect(page.getByText(`MemryNote couldn't finish installing ${VERSION}`)).toBeVisible()
  await expect(page.getByRole('button', { name: `Download ${VERSION} manually` })).toBeVisible()
  expect(existsSync(marker)).toBe(false)
})

// An installer started while the OS session ends is killed after it removed the old install
// (#1851), so a session end never installs on quit; the update stays on disk for the next quit.
// Windows: WM_QUERYENDSESSION, then WM_ENDSESSION. The real sign-out is a VM row.
test('a sign-out leaves a downloaded update to the next normal quit', async ({ app, page }) => {
  test.skip(process.platform !== 'win32', 'WM_ENDSESSION is Windows-only')
  const { appDataDir } = await appInfo(app)
  await download(app, page)

  await invokeTest(app, 'e2e_send_session_end', { target: 'main' })
  await waitForExit(app)
  expect(applies(appDataDir)).toEqual([])

  await restart(app)
  await download(app, page)
  await sendTest(app, 'e2e_request_quit')
  await waitForExit(app)
  expect(applies(appDataDir)).toEqual([{ silent: true, restart: false }])
})

// macOS: loginwindow quits the app with an Apple event that names the reason (`rlgo` at Log Out),
// and the app accepts it. Cmd+Q is the same `terminate:` with no reason. The real Log Out is a
// manual row of the release rehearsal.
test('a macOS Log Out leaves a downloaded update to the next normal quit', async ({
  app,
  page
}) => {
  test.skip(process.platform !== 'darwin', 'Apple events are macOS-only')
  const { appDataDir } = await appInfo(app)
  await download(app, page)

  expect(sendQuitEvent(app.pid, 'rlgo')).toBe('errn 0')
  await waitForExit(app)
  expect(applies(appDataDir)).toEqual([])

  await restart(app)
  await download(app, page)
  await invokeTest(app, 'e2e_app_terminate')
  await waitForExit(app)
  expect(applies(appDataDir)).toEqual([{ silent: true, restart: false }])
})

// A Log Out while a Cmd+Q still runs: AppKit answers loginwindow's quit event itself, without
// asking the app again, so only its NSWorkspaceWillPowerOffNotification says the session ends.
test('a macOS Log Out during a running quit leaves the update on disk', async ({ app, page }) => {
  test.skip(process.platform !== 'darwin', 'Apple events are macOS-only')
  const { appDataDir, logDir } = await appInfo(app)
  await download(app, page)
  await invokeTest(app, 'e2e_slow_shutdown_step', { step: 'stop-sync-runtime', ms: 3_000 })

  await invokeTest(app, 'e2e_app_terminate')
  expect(await waitForMainLog(app, 'starting graceful shutdown', 5_000)).toBe(true)
  expect(sendQuitEvent(app.pid, 'rlgo')).toBe('errn 0')
  await waitForExit(app)
  expect(applies(appDataDir)).toEqual([])

  // A forced exit installs nothing either: the quit must have ended cleanly, with the install
  // turned off by the session end, and AppKit must not have asked the app a second time.
  const log = readMainLog(logDir)
  expect(log).toContain('cleanup complete')
  expect(log).toContain('accepting the quit macOS asked for')
  expect(log).toContain('OS session ending - skipping install-on-quit')
  expect(log.split('macOS asked the app to terminate').length - 1).toBe(1)
})

/** A fake session manager on the session bus, up before the app registers with it. */
function withSessionManager(desktop: Desktop) {
  const logoutTest = test.extend<{ sessionManager: FakeSessionManager }>({
    sessionManager: async (_deps, use) => {
      const manager = await startFakeSessionManager(desktop)
      try {
        await use(manager)
      } finally {
        manager.close()
      }
    }
  })
  return process.platform === 'linux' ? logoutTest : logoutTest.skip
}

withSessionManager('xfce')(
  'a Linux logout leaves a downloaded update to the next normal quit',
  async ({ sessionManager, app, page }) => {
    await sessionManager.waitFor('registered', (e) => e.pid === app.pid)
    const { appDataDir } = await appInfo(app)
    await download(app, page)

    sessionManager.logout(app.pid)
    await sessionManager.waitFor('over')
    await waitForExit(app)
    expect(applies(appDataDir)).toEqual([])
  }
)

withSessionManager('gnome')(
  'a logout that is called off keeps install on quit',
  async ({ sessionManager, app, page }) => {
    await sessionManager.waitFor('registered', (e) => e.pid === app.pid)
    const { appDataDir } = await appInfo(app)
    await download(app, page)

    sessionManager.cancelLogout(app.pid)
    expect(await waitForMainLog(app, 'the logout was called off', 5_000)).toBe(true)
    await sendTest(app, 'e2e_request_quit')
    await waitForExit(app)
    expect(applies(appDataDir)).toEqual([{ silent: true, restart: false }])
  }
)

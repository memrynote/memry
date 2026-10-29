// The in-app updater over the scripted backend (`MEMRY_TEST_UPDATER=scripted`): what the user
// sees for each state, what the preferences write, and how the quit hands a downloaded update
// to the installer. Every apply the backend saw is a line of `e2e-updater-applies.jsonl` in the
// data dir, so a spec reads it after the process exited.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { test, expect } from '../../harness/test'
import { invokeTest } from '../../harness/invoke-test'
import { isAlive } from '../../harness/app-process'
import { sendQuitEvent } from '../../harness/mac-quit-event'
import {
  startFakeSessionManager,
  type Desktop,
  type FakeSessionManager
} from '../../harness/session-manager'
import { appInfo, restart } from '../../harness/tauri-lifecycle'
import { invoke } from '../../harness/vault-commands'
import { pollUntil, waitForMainLog } from '../../harness/wait'
import type { Page } from '../../harness/pw-compat/page'

test.use({ extraEnv: { MEMRY_TEST_UPDATER: 'scripted' } })

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

test('a manual check surfaces the release in the settings popover', async ({ app, page }) => {
  await script(app, page, [available])
  expect((await check(page)).status).toBe('available')

  await page.getByRole('button', { name: /Update available/ }).click()
  await expect(page.getByText(`MemryNote ${VERSION} is available`)).toBeVisible()
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
  await page.getByRole('button', { name: 'Restart now' }).click()

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

  await invokeTest(app, 'e2e_request_quit')
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
  await invokeTest(app, 'e2e_request_quit')
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
  const { appDataDir } = await appInfo(app)
  await download(app, page)
  await invokeTest(app, 'e2e_slow_shutdown_step', { step: 'stop-sync-runtime', ms: 3_000 })

  await invokeTest(app, 'e2e_app_terminate')
  expect(await waitForMainLog(app, 'starting graceful shutdown', 5_000)).toBe(true)
  expect(sendQuitEvent(app.pid, 'rlgo')).toBe('errn 0')
  await waitForExit(app)
  expect(applies(appDataDir)).toEqual([])
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
    await invokeTest(app, 'e2e_request_quit')
    await waitForExit(app)
    expect(applies(appDataDir)).toEqual([{ silent: true, restart: false }])
  }
)

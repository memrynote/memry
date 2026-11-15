/* oxlint-disable no-unused-vars, max-lines */
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

/** Every updater failure telemetry shipped, after a flush of what is queued. */
async function shippedUpdaterFailures(page: Page): Promise<ShippedEvent[]> {
  await invoke(page, 'telemetry_flush')
  return shipped.filter(
    (event) =>
      event.source === 'updater' &&
      (event.name === 'app_error_seen' || event.name === 'app_log_recorded')
  )
}

for (let round = 0; round < 8; round++)
  test(`diag offline round ${round}`, async ({ app, page }) => {
    shipped.length = 0
    const { logDir } = await appInfo(app)
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

    await page.evaluate(() => {
      const w = window as unknown as { __ev: string[] }
      w.__ev = []
      const t0 = performance.now()
      for (const type of ['mousedown', 'mouseup', 'click'])
        window.addEventListener(
          type,
          (e) => {
            const el = e.target as Element
            w.__ev.push(
              `${Math.round(performance.now() - t0)} ${type} ${el.tagName}[${(el.textContent || '').trim().slice(0, 24)}] y=${(e as MouseEvent).clientY} trusted=${e.isTrusted}`
            )
          },
          true
        )
    })
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('button', { name: 'General', exact: true }).click()
    const probe = () =>
      page.evaluate(() => {
        const b = [...document.querySelectorAll('button')].find(
          (x) => x.textContent?.trim() === 'Check now'
        ) as HTMLButtonElement | undefined
        const r = b?.getBoundingClientRect()
        const top = r ? document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) : null
        return JSON.stringify({
          rect: r && [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
          top: top?.outerHTML.slice(0, 100),
          disabled: b?.disabled,
          inner: [innerWidth, innerHeight],
          outer: [outerWidth, outerHeight],
          screen: [screen.width, screen.height, devicePixelRatio],
          focus: document.hasFocus(),
          visibility: document.visibilityState,
          scrolled: [...document.querySelectorAll('*')]
            .filter((e) => e.scrollTop > 0)
            .map((e) => `${e.tagName}:${Math.round(e.scrollTop)}`)
        })
      })
    const events = () =>
      page.evaluate(() => JSON.stringify((window as unknown as { __ev: string[] }).__ev))
    const before = await probe()
    await page.getByRole('button', { name: 'Check now' }).click()
    const afterClick = await probe()
    try {
      await expect.poll(async () => (await state(page)).status, { timeout: 8_000 }).toBe('error')
    } catch (error) {
      const updaterLines = readMainLog(logDir)
        .split('\n')
        .filter((line) => /Updater|updater/.test(line))
        .slice(-12)
      console.log(
        `DIAG-MISS round ${round}\n before ${before}\n afterClick ${afterClick}\n now ${await probe()}\n events ${await events()}\n state ${JSON.stringify(await state(page))}\n log ${updaterLines.join(' | ')}`
      )
      throw error
    }
    console.log(`DIAG-OK round ${round} ${before}`)
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

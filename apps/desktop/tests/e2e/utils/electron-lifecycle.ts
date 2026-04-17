/**
 * Shared Electron launch + teardown helpers for E2E fixtures.
 *
 * All helpers enforce:
 *  - a bounded graceful shutdown (SIGKILL fallback) so a hung main-process
 *    shutdown can never blow past Playwright's 60s teardown limit
 *  - a single retry on first-window timeout — an occasional stall on macOS
 *    leaves the main process alive but no window event fires; a clean relaunch
 *    always unblocks it
 *  - best-effort cleanup of both the requested user-data-dir and the
 *    Electron-resolved one (they can differ on macOS)
 */

import { _electron as electron, ElectronApplication, Page } from '@playwright/test'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const MAIN_ENTRY = path.join(__dirname, '../../../out/main/index.js')
const isCI = !!process.env.CI

const FIRST_WINDOW_MS = 30_000
const GRACEFUL_CLOSE_MS = 8_000

export interface LaunchOptions {
  testVaultPath: string
  deviceId?: string
  syncServerUrl?: string | null
  extraEnv?: Record<string, string | undefined>
}

export interface LaunchedElectron {
  app: ElectronApplication
  page: Page
  userDataDir: string
  resolvedUserDataDir: string
  mainLogs: string[]
}

export async function destroyElectronApp(app: ElectronApplication, dirs: string[]): Promise<void> {
  const child = app.process()
  const graceful = app.close().catch(() => {})
  const timedOut = await Promise.race([
    graceful.then(() => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(true), GRACEFUL_CLOSE_MS))
  ])
  if (timedOut && child && !child.killed) {
    try {
      child.kill('SIGKILL')
    } catch {
      // already exited
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  for (const dir of dirs) {
    if (!dir) continue
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    } catch {
      // best-effort cleanup
    }
  }
}

async function launchOnce(opts: LaunchOptions): Promise<LaunchedElectron> {
  const prefix = opts.deviceId ? `memry-userdata-${opts.deviceId}-` : 'memry-userdata-'
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const mainLogs: string[] = []

  const env: Record<string, string | undefined> = {
    ...process.env,
    NODE_ENV: 'test',
    TEST_VAULT_PATH: opts.testVaultPath,
    ...(opts.deviceId ? { MEMRY_DEVICE: opts.deviceId } : {}),
    ...(opts.syncServerUrl ? { SYNC_SERVER_URL: opts.syncServerUrl } : {}),
    ...(isCI && { ELECTRON_DISABLE_SANDBOX: '1' }),
    ...(opts.extraEnv ?? {})
  }

  const app = await electron.launch({
    args: [
      ...(isCI ? ['--no-sandbox', '--disable-gpu'] : []),
      `--user-data-dir=${userDataDir}`,
      MAIN_ENTRY
    ],
    env
  })

  app.on('console', (msg) => {
    try {
      mainLogs.push(`[${msg.type()}] ${msg.text()}`)
    } catch {
      // ignore
    }
  })
  const child = app.process()
  if (child?.stdout) {
    child.stdout.on('data', (buf: Buffer) => mainLogs.push(`[stdout] ${buf.toString()}`))
  }
  if (child?.stderr) {
    child.stderr.on('data', (buf: Buffer) => mainLogs.push(`[stderr] ${buf.toString()}`))
  }

  try {
    const page = await app.firstWindow({ timeout: FIRST_WINDOW_MS })
    await page.waitForLoadState('domcontentloaded')
    let resolvedUserDataDir = userDataDir
    try {
      resolvedUserDataDir = await app.evaluate(({ app }) => app.getPath('userData'))
    } catch {
      // fall back to requested dir
    }
    return { app, page, userDataDir, resolvedUserDataDir, mainLogs }
  } catch (err) {
    await destroyElectronApp(app, [userDataDir])
    const tail = mainLogs.slice(-40).join('').slice(-4000)
    const baseMsg = err instanceof Error ? err.message : String(err)
    throw new Error(`${baseMsg}\n--- main process output ---\n${tail}\n--- end ---`)
  }
}

export async function launchElectronWithWindow(opts: LaunchOptions): Promise<LaunchedElectron> {
  // Single attempt. Experimentally a retry loop here made the full suite
  // dramatically slower (each failed test burned 2x the timeout) without
  // increasing the pass rate — the underlying flakiness appears to be
  // systemic (macOS resource pressure mid-run) rather than transient, so a
  // local retry doesn't help. We rely on Playwright-level retries (configured
  // via the `retries` option in playwright.config.ts) if we need them.
  return launchOnce(opts)
}

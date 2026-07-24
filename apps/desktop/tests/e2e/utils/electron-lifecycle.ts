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
 *  - best-effort purge of the OS keychain items the run's `MEMRY_DEVICE`
 *    minted, which outlive the userData dir (see keychain-cleanup.ts)
 */

import { _electron as electron, ElectronApplication, Page } from '@playwright/test'
import { spawnSync } from 'child_process'
import { createRequire } from 'node:module'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { purgeKeychainForDevice } from './keychain-cleanup'

const MAIN_ENTRY = path.join(__dirname, '../../../out/main/index.js')
const ELECTRON_INSTALLER = path.join(__dirname, '../../../scripts/install-electron-binary.cjs')
const require = createRequire(__filename)
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
  logDir: string
  deviceId?: string
}

function getElectronExecutablePath(): string {
  const electronPackageDir = path.dirname(require.resolve('electron/package.json'))
  const installedPath = readElectronExecutablePath(electronPackageDir)
  if (installedPath) {
    return installedPath
  }

  return installElectronBinary(electronPackageDir)
}

function readElectronExecutablePath(electronPackageDir: string): string | null {
  try {
    const relativePath = fs.readFileSync(path.join(electronPackageDir, 'path.txt'), 'utf8').trim()
    if (!relativePath) {
      return null
    }

    const executablePath = path.join(electronPackageDir, 'dist', relativePath)
    return fs.existsSync(executablePath) ? executablePath : null
  } catch {
    return null
  }
}

function installElectronBinary(electronPackageDir: string): string {
  const result = spawnSync(process.execPath, [ELECTRON_INSTALLER, electronPackageDir], {
    cwd: path.join(__dirname, '../../..'),
    env: process.env,
    stdio: 'inherit'
  })

  if (result.error) {
    throw result.error
  }

  if (result.status !== 0) {
    throw new Error(`Electron binary install failed with exit code ${result.status ?? 'unknown'}`)
  }

  return path.join(electronPackageDir, 'dist', getElectronPlatformPath())
}

function getElectronPlatformPath(): string {
  switch (process.platform) {
    case 'darwin':
      return 'Electron.app/Contents/MacOS/Electron'
    case 'freebsd':
    case 'openbsd':
    case 'linux':
      return 'electron'
    case 'win32':
      return 'electron.exe'
    default:
      throw new Error(`Electron builds are not available on platform: ${process.platform}`)
  }
}

/**
 * Tear down a launch: stop the app, remove both user-data dirs, and purge the
 * keychain items its `MEMRY_DEVICE` minted. Prefer this over `destroyElectronApp`
 * — it derives everything from `launched`, so a new fixture cannot forget the
 * keychain purge and silently start leaking again.
 */
export async function destroyLaunchedElectron(launched: LaunchedElectron): Promise<void> {
  const dirs = [launched.userDataDir]
  if (launched.resolvedUserDataDir !== launched.userDataDir) {
    dirs.push(launched.resolvedUserDataDir)
  }
  await destroyElectronApp(launched.app, dirs, launched.deviceId)
}

export async function destroyElectronApp(
  app: ElectronApplication,
  dirs: string[],
  deviceId?: string
): Promise<void> {
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
  purgeKeychainForDevice(deviceId)
}

/**
 * Wait for a substring to appear in the main process's log output.
 *
 * `mainLogs` only captures stdout/stderr from AFTER the first window is ready —
 * anything logged during early startup (e.g. the CRDT preflight, which runs
 * before the window paints) can be consumed by the Playwright launcher before
 * our stream handlers attach, so it never lands in `mainLogs`. electron-log's
 * on-disk file is the reliable source for those early lines, so poll it too.
 * `launched.logDir` is this run's isolated log dir (MEMRY_TEST_LOG_DIR), so a
 * match can only come from the current launch, never a stale prior-run line.
 */
export async function waitForMainLog(
  launched: LaunchedElectron,
  substring: string,
  timeoutMs = 15_000
): Promise<boolean> {
  const logFile = path.join(launched.logDir, 'main.log')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (launched.mainLogs.join('\n').includes(substring)) return true
    try {
      if (fs.readFileSync(logFile, 'utf8').includes(substring)) return true
    } catch {
      // log file may not exist yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return false
}

async function launchOnce(opts: LaunchOptions): Promise<LaunchedElectron> {
  const prefix = opts.deviceId ? `memry-userdata-${opts.deviceId}-` : 'memry-userdata-'
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  // Isolate electron-log's file output to this run's fresh dir (see logger.ts) so
  // waitForMainLog reads only lines from this launch, never a prior run's leftovers.
  const logDir = path.join(userDataDir, 'logs')
  const mainLogs: string[] = []

  const env: Record<string, string | undefined> = {
    ...process.env,
    NODE_ENV: 'test',
    TEST_VAULT_PATH: opts.testVaultPath,
    MEMRY_TEST_LOG_DIR: logDir,
    ...(opts.deviceId ? { MEMRY_DEVICE: opts.deviceId } : {}),
    ...(opts.syncServerUrl ? { SYNC_SERVER_URL: opts.syncServerUrl } : {}),
    ...(isCI && { ELECTRON_DISABLE_SANDBOX: '1' }),
    ...(opts.extraEnv ?? {})
  }
  delete env.ELECTRON_RUN_AS_NODE

  const app = await electron.launch({
    executablePath: getElectronExecutablePath(),
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
    // Normalize the window size across runners. macOS CI displays are
    // 1024x768 while ubuntu xvfb runs 1280x1024+, and at 1024 wide the app's
    // responsive layout squeezes flex titles (e.g. the file-viewer heading)
    // to zero width, failing toBeVisible assertions that pass everywhere
    // else. A window larger than the display is fine: layout, hit-testing
    // and Playwright visibility work on the window's logical size.
    try {
      await app.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0]
        if (win) win.setBounds({ x: 0, y: 0, width: 1440, height: 900 })
      })
    } catch {
      // best-effort — a failed resize should never fail the launch
    }
    let resolvedUserDataDir = userDataDir
    try {
      resolvedUserDataDir = await app.evaluate(({ app }) => app.getPath('userData'))
    } catch {
      // fall back to requested dir
    }
    return {
      app,
      page,
      userDataDir,
      resolvedUserDataDir,
      mainLogs,
      logDir,
      deviceId: opts.deviceId
    }
  } catch (err) {
    await destroyElectronApp(app, [userDataDir], opts.deviceId)
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

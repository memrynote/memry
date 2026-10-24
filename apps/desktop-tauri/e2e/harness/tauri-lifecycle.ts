import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { release, tmpdir } from 'node:os'
import { join } from 'node:path'

import { driverReady, forceKill, isAlive, spawnApp } from './app-process'
import { GRACEFUL_CLOSE_MS } from './budgets'
import { HarnessError } from './errors'
import { removeDir } from './remove-dir'
import { type Executor, invokeTest } from './invoke-test'
import { purgeKeychainForDevice } from './keychain-cleanup.mjs'
import { recordDevice } from './registry'
import { pollUntil, sleep } from './wait'

/** The WebdriverIO browser (or one multiremote instance) the harness drives. */
export interface AppBrowser extends Executor {
  reloadSession(): Promise<string>
  setTimeout(timeouts: { script?: number; implicit?: number; pageLoad?: number }): Promise<void>
}

export interface E2eAppInfo {
  pid: number
  appDataDir: string
  logDir: string
  device: string
  version: string
  buildKind: string
  webdriverPort: number
}

export interface AppDirs {
  appDataDir: string
  logDir: string
  /** The temp directory that holds both; removed on dispose. */
  root: string
}

/** The control file, as `memry_desktop::e2e::control::ControlFile` reads it. */
export interface ControlFile {
  appDataDir: string
  logDir: string
  device: string
  testVaultPath: string | null
  syncServerUrl: string | null
  extraEnv: Record<string, string>
}

export interface FreshOptions {
  /** `A` or `B` for multiremote; the device id gets the suffix. */
  label?: 'A' | 'B'
  testVaultPath?: string | null
  syncServerUrl?: string | null
  extraEnv?: Record<string, string>
  deviceId?: string
}

export interface TauriApp {
  /** The WebdriverIO browser or multiremote instance. */
  executor: AppBrowser
  port: number
  device: string
  dirs: AppDirs
  control: ControlFile
  /** Pid of the app instance running now. */
  pid: number
  label?: 'A' | 'B'
}

const WINDOW_WIDTH = 1440
const WINDOW_HEIGHT = 900
const READY_MS = 60_000

export function controlFilePath(port: number): string {
  return join(tmpdir(), 'memry-e2e', `control-${port}.json`)
}

function writeControl(port: number, control: ControlFile): void {
  const path = controlFilePath(port)
  mkdirSync(join(tmpdir(), 'memry-e2e'), { recursive: true })
  writeFileSync(path, JSON.stringify(control))
}

export async function appInfo(app: { executor: Executor }): Promise<E2eAppInfo> {
  return invokeTest<E2eAppInfo>(app, 'e2e_app_info')
}

/** Waits until the renderer answers `e2e_app_info`; the page may still be loading. */
async function waitForApp(executor: AppBrowser): Promise<E2eAppInfo> {
  let lastError: unknown
  const info = await pollUntil(
    async () => {
      try {
        return await appInfo({ executor })
      } catch (error) {
        lastError = error
        return undefined
      }
    },
    { timeoutMs: READY_MS, intervalMs: 250 }
  )
  if (!info) throw new HarnessError(`app did not answer e2e_app_info: ${String(lastError)}`)
  return info
}

function assertControlApplied(info: E2eAppInfo, control: ControlFile): void {
  const mismatches = (['appDataDir', 'logDir', 'device'] as const).filter(
    (key) => info[key] !== control[key]
  )
  if (mismatches.length > 0) {
    const detail = mismatches.map((key) => `${key}: wrote ${control[key]}, app has ${info[key]}`)
    throw new HarnessError(`control file not applied (${detail.join('; ')})`)
  }
}

function assertCanRunTwo(): void {
  if (process.platform !== 'darwin') return
  // `release()` is the Darwin kernel version: 23 is macOS 14. macOS 13 has no per-instance
  // WKWebView store, so two instances would share one localStorage.
  if (Number.parseInt(release(), 10) < 23) {
    throw new HarnessError(
      'two e2e instances need macOS 14 or later: macOS 13 shares one webview store'
    )
  }
}

async function setWindowSize(app: { executor: Executor }): Promise<void> {
  await invokeTest(app, 'e2e_set_window_rect', {
    label: 'main',
    x: 0,
    y: 0,
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT
  })
}

/** The WebDriver port of a browser or multiremote instance, from its connection options. */
function portOf(executor: AppBrowser): number {
  const port = (executor as unknown as { options?: { port?: number } }).options?.port
  if (!port)
    throw new HarnessError('the browser has no WebDriver port; is the app launcher configured?')
  return port
}

/**
 * Starts a fresh app: new dirs, a new device id, a new control file, then a new process and a
 * new WebDriver session. The profile in effect is compared with what was written, and a
 * mismatch throws `HarnessError("control file not applied")`.
 */
export async function fresh(executor: AppBrowser, options: FreshOptions = {}): Promise<TauriApp> {
  if (options.label === 'B') assertCanRunTwo()
  const port = portOf(executor)
  await stopRunningApp(executor, port)

  const device =
    options.deviceId ?? `e2e-${randomUUID()}${options.label ? `-${options.label}` : ''}`
  const root = mkdtempSync(join(tmpdir(), `memry-e2e-${options.label ?? 'app'}-`))
  const dirs: AppDirs = { root, appDataDir: join(root, 'data'), logDir: join(root, 'logs') }
  const control: ControlFile = {
    appDataDir: dirs.appDataDir,
    logDir: dirs.logDir,
    device,
    testVaultPath: options.testVaultPath ?? null,
    syncServerUrl: options.syncServerUrl ?? null,
    extraEnv: options.extraEnv ?? {}
  }
  recordDevice(device)
  writeControl(port, control)

  return start(executor, { port, device, dirs, control, label: options.label })
}

/**
 * Ends the app a previous test or the launcher left on `port`, whose session is still open. A
 * launcher-started app runs in the default profile; its dirs go with it.
 */
async function stopRunningApp(executor: AppBrowser, port: number): Promise<void> {
  if (!(await driverReady(port))) return
  let info: E2eAppInfo | undefined
  try {
    info = await appInfo({ executor })
  } catch {
    // The page is not ready or the session is gone; the port answers, so someone still owns it.
  }
  if (!info)
    throw new HarnessError(`an app is running on port ${port} but does not answer e2e_app_info`)
  await gracefulClose({ executor, pid: info.pid })
  if (info.device.startsWith('e2e-default-')) {
    removeDir(join(tmpdir(), 'memry-e2e', `default-${port}`))
  }
}

async function start(
  executor: AppBrowser,
  base: Omit<TauriApp, 'executor' | 'pid'>
): Promise<TauriApp> {
  await spawnApp(base.port)
  await executor.reloadSession()
  await executor.setTimeout({ script: 60_000 })
  const info = await waitForApp(executor)
  assertControlApplied(info, base.control)
  const app: TauriApp = { ...base, executor, pid: info.pid }
  await setWindowSize(app)
  return app
}

/**
 * Asks the app to quit and waits up to 8 s for its process to exit, then kills it. The session
 * deletion error that follows is ignored: the app is gone.
 */
export async function gracefulClose(app: { executor: Executor; pid: number }): Promise<void> {
  try {
    await invokeTest(app, 'e2e_request_quit')
  } catch {
    // The app may already be gone.
  }
  const exited = await pollUntil(() => !isAlive(app.pid), {
    timeoutMs: GRACEFUL_CLOSE_MS,
    intervalMs: 100
  })
  if (!exited) {
    forceKill(app.pid)
    await sleep(500)
  }
}

/** Closes the app and starts it again against the same control file, so dirs and device stay. */
export async function restart(app: TauriApp): Promise<void> {
  await gracefulClose(app)
  writeControl(app.port, app.control)
  const next = await start(app.executor, app)
  app.pid = next.pid
}

/** Closes the app, removes its temp dirs and purges the keychain items its device minted. */
export async function dispose(app: TauriApp): Promise<void> {
  await gracefulClose(app)
  removeDir(app.dirs.root)
  rmSync(controlFilePath(app.port), { force: true })
  purgeKeychainForDevice(app.device)
}

import { existsSync } from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import { createConnection } from 'node:net'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { resolve } from 'node:path'
import { remote } from 'webdriverio'
import { runtimeConfig } from '../runtime.config'

export type RuntimeBrowser = WebdriverIO.Browser

export interface RuntimeScenarioContext extends RuntimeDriverSession {
  vault: {
    root: string
    seed: SeededVault
  }
}

export interface RuntimeScenario {
  name: string
  device?: string
  originTag?: string
  run: (context: RuntimeScenarioContext) => Promise<void>
}

export interface SeededVault {
  folder: string
  notes: Array<{
    id: string
    path: string
    title: string
  }>
}

interface RuntimeDriverOptions {
  appPath: string
  device: string
  originTag: string
}

export interface RuntimeDriverSession {
  browser: RuntimeBrowser
  appPath: string
  device: string
  originTag: string
  stop: () => Promise<void>
}

export function assertRuntimeDriverSupported(): void {
  const unsupported = runtimeDriverUnsupportedMessage()
  if (unsupported) {
    throw new Error(unsupported)
  }
}

export function runtimeDriverUnsupportedMessage(): string | null {
  if (process.platform === 'darwin') {
    return 'Tauri WebDriver runtime e2e is not supported on macOS because WKWebView has no desktop WebDriver backend; run this lane on Linux or Windows.'
  }
  return null
}

export async function buildRuntimeApp(): Promise<string> {
  assertRuntimeDriverSupported()

  await runCommand('pnpm', ['exec', 'tauri', 'build', '--debug'], {
    cwd: runtimeConfig.packageRoot,
    env: {
      ...process.env,
      MEMRY_RUNTIME_E2E: '1',
      VITE_MOCK_IPC: 'false'
    }
  })

  const appPath = resolveDebugBinaryPath()
  if (!existsSync(appPath)) {
    throw new Error(`Runtime app binary was not created at ${appPath}`)
  }
  return appPath
}

export async function withRuntimeDriver<T>(
  options: RuntimeDriverOptions,
  run: (session: RuntimeDriverSession) => Promise<T>
): Promise<T> {
  const session = await startRuntimeDriver(options)
  try {
    return await run(session)
  } finally {
    await session.stop()
  }
}

async function startRuntimeDriver(options: RuntimeDriverOptions): Promise<RuntimeDriverSession> {
  assertRuntimeDriverSupported()

  const driver = spawn('tauri-driver', ['--port', String(runtimeConfig.driverPort)], {
    cwd: runtimeConfig.packageRoot,
    env: {
      ...process.env,
      MEMRY_DEVICE: options.device,
      MEMRY_ORIGIN_TAG: options.originTag,
      MEMRY_RUNTIME_E2E: '1',
      VITE_MOCK_IPC: 'false'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })

  pipeProcessOutput(driver, 'tauri-driver')
  let browser: RuntimeBrowser | null = null

  try {
    await waitForPort(runtimeConfig.driverHost, runtimeConfig.driverPort, 15_000)

    browser = await remote({
      hostname: runtimeConfig.driverHost,
      port: runtimeConfig.driverPort,
      path: '/',
      logLevel: 'error',
      capabilities: {
        browserName: 'wry',
        'tauri:options': {
          application: options.appPath
        }
      }
    })

    await browser.waitUntil(async () => (await browser!.$('body')).isExisting(), {
      timeout: 15_000,
      timeoutMsg: 'Tauri main window did not expose a body element'
    })

    return {
      browser,
      appPath: options.appPath,
      device: options.device,
      originTag: options.originTag,
      stop: async () => {
        await browser?.deleteSession().catch(() => undefined)
        await stopProcess(driver)
      }
    }
  } catch (err) {
    await browser?.deleteSession().catch(() => undefined)
    await stopProcess(driver)
    throw err
  }
}

function resolveDebugBinaryPath(): string {
  const exe = process.platform === 'win32' ? '.exe' : ''
  return resolve(
    runtimeConfig.srcTauriRoot,
    'target',
    'debug',
    `memry-desktop-tauri${exe}`
  )
}

async function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv }
): Promise<void> {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'inherit', 'inherit']
  })
  const [code, signal] = (await once(child, 'exit')) as [number | null, NodeJS.Signals | null]
  if (code !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with ${signal ?? `exit code ${code}`}`)
  }
}

function pipeProcessOutput(child: ChildProcess, label: string): void {
  child.stdout?.on('data', (chunk) => process.stdout.write(`[${label}] ${chunk}`))
  child.stderr?.on('data', (chunk) => process.stderr.write(`[${label}] ${chunk}`))
}

async function waitForPort(host: string, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown

  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolvePromise, reject) => {
        const socket = createConnection({ host, port })
        socket.once('connect', () => {
          socket.end()
          resolvePromise()
        })
        socket.once('error', reject)
      })
      return
    } catch (err) {
      lastError = err
      await delay(250)
    }
  }

  throw new Error(`Timed out waiting for tauri-driver on ${host}:${port}: ${String(lastError)}`)
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill()
  await Promise.race([once(child, 'exit'), delay(5_000).then(() => child.kill('SIGKILL'))])
}

import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { HarnessError } from './errors'
import { pollUntil } from './wait'

const crateTarget = fileURLToPath(new URL('../../../../crates/target/debug', import.meta.url))

/** The e2e build: `MEMRY_E2E_BINARY`, else the debug build of `pnpm build:e2e`. */
export function binaryPath(): string {
  return (
    process.env.MEMRY_E2E_BINARY ??
    join(crateTarget, process.platform === 'win32' ? 'memry-tauri.exe' : 'memry-tauri')
  )
}

/** A port nothing listens on, from the OS. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => resolve(typeof address === 'object' && address ? address.port : 0))
    })
  })
}

export async function driverReady(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/status`, {
      signal: AbortSignal.timeout(2_000)
    })
    return ((await response.json()) as { value?: { ready?: boolean } }).value?.ready === true
  } catch {
    return false
  }
}

export async function waitForDriver(port: number, child: ChildProcess | undefined): Promise<void> {
  let exited: string | undefined
  child?.once('exit', (code, signal) => {
    exited = `code=${code} signal=${signal}`
  })
  const ready = await pollUntil(() => exited !== undefined || driverReady(port), {
    timeoutMs: 120_000,
    intervalMs: 250
  })
  if (exited !== undefined) throw new HarnessError(`the app exited during startup (${exited})`)
  if (!ready) throw new HarnessError(`no WebDriver on port ${port} after 120 s`)
}

const spawned = new Set<ChildProcess>()

process.once('exit', () => {
  for (const child of spawned) child.kill('SIGKILL')
})

/**
 * Starts the e2e app with its WebDriver on `port`. The gate variable opens the run-time guard;
 * everything else a test overrides travels through the control file of that port.
 */
export async function spawnApp(port: number): Promise<ChildProcess> {
  const child = spawn(binaryPath(), [], {
    env: { ...process.env, MEMRY_E2E: '1', TAURI_WEBDRIVER_PORT: String(port) },
    stdio: 'ignore'
  })
  spawned.add(child)
  child.once('exit', () => spawned.delete(child))
  child.once('error', () => spawned.delete(child))
  await waitForDriver(port, child)
  return child
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function forceKill(pid: number): void {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/F', '/PID', String(pid)], { stdio: 'ignore' })
    return
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // already gone
  }
}

import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { HarnessError } from './errors.ts'
import { pollUntil } from './wait.ts'

const crateTarget = fileURLToPath(new URL('../../../../crates/target/debug', import.meta.url))

/**
 * Each launch's stderr, uploaded with the e2e results. The app logs there too, and it is the only
 * place a panic before logging starts (GTK that cannot open its display) leaves its text. No run
 * clears it: CI uploads the single-app and the two-device runs from it together, and each file
 * name carries its port and launch time.
 */
export const APP_OUTPUT_DIR = fileURLToPath(
  new URL('../../test-results/e2e/app-output', import.meta.url)
)

const OUTPUT_TAIL_BYTES = 4_000

/** The executable names the `tauri.<os>.conf.json` overlays set as `mainBinaryName`. */
const BINARY_NAMES: Partial<Record<NodeJS.Platform, string>> = {
  win32: 'Memrynote.exe',
  darwin: 'MemryNote'
}

/** The e2e build: `MEMRY_E2E_BINARY`, else the debug build of `pnpm build:e2e`. */
export function binaryPath(): string {
  return (
    process.env.MEMRY_E2E_BINARY ?? join(crateTarget, BINARY_NAMES[process.platform] ?? 'memrynote')
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
const freshEnchantDirs = new Set<string>()

process.once('exit', () => {
  for (const child of spawned) child.kill('SIGKILL')
})

/**
 * Starts the e2e app with its WebDriver on `port`. The gate variable opens the run-time guard;
 * everything else a test overrides travels through the control file of that port.
 */
export async function spawnApp(port: number): Promise<ChildProcess> {
  // Enchant keeps the personal dictionary under the user's config dir, so a spec that adds a word
  // would leave it in the machine's dictionary. A throwaway dir per launch keeps it out.
  const enchantDir = join(tmpdir(), 'memry-e2e', `enchant-${port}`)
  // Wiped on the first launch of this harness process only: a spec that restarts the app on the
  // same port keeps the word it added.
  if (!freshEnchantDirs.has(enchantDir)) {
    rmSync(enchantDir, { recursive: true, force: true })
    freshEnchantDirs.add(enchantDir)
  }
  mkdirSync(enchantDir, { recursive: true })
  mkdirSync(APP_OUTPUT_DIR, { recursive: true })
  const output = join(APP_OUTPUT_DIR, `app-${port}-${Date.now()}.log`)
  // A file, not a pipe: it keeps what the app wrote after this process stopped reading.
  const fd = openSync(output, 'a')
  const child = spawn(binaryPath(), [], {
    env: {
      ...process.env,
      MEMRY_E2E: '1',
      TAURI_WEBDRIVER_PORT: String(port),
      ENCHANT_CONFIG_DIR: enchantDir
    },
    stdio: ['ignore', fd, fd]
  })
  closeSync(fd)
  spawned.add(child)
  child.once('exit', () => spawned.delete(child))
  child.once('error', () => spawned.delete(child))
  try {
    await waitForDriver(port, child)
  } catch (error) {
    const text = readFileSync(output, 'utf8').slice(-OUTPUT_TAIL_BYTES).trimEnd()
    throw new HarnessError(`${(error as Error).message}; its output (${output}):\n${text}`)
  }
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

/**
 * Ends a process this one spawned, with its process tree on Windows, unless it already exited:
 * Windows gives an exited process's pid to the next process at once, and `taskkill` would end
 * that one. Until Node reports the exit it holds the child's handle (Windows) or has not reaped
 * it (Unix), so the pid is still the child's.
 */
export function stopChild(child: ChildProcess): void {
  if (child.pid && child.exitCode === null && child.signalCode === null) forceKill(child.pid)
}

export function forceKill(pid: number): void {
  if (process.platform === 'win32') {
    // /T ends the WebView2 helper processes too; they hold the profile files open.
    spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' })
    return
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // already gone
  }
}

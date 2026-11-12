import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

import { pollUntil } from './wait.ts'

/** How the app process ended, as Node's `exit` event reports it. */
export interface AppExit {
  code: number | null
  signal: NodeJS.Signals | null
}

/** The NTSTATUS codes a Windows process that crashed exits with. */
const NTSTATUS: Record<number, string> = {
  0xc0000005: 'STATUS_ACCESS_VIOLATION',
  0xc000001d: 'STATUS_ILLEGAL_INSTRUCTION',
  0xc00000fd: 'STATUS_STACK_OVERFLOW',
  0xc0000139: 'STATUS_ENTRYPOINT_NOT_FOUND',
  0xc0000142: 'STATUS_DLL_INIT_FAILED',
  0xc0000374: 'STATUS_HEAP_CORRUPTION',
  // `__fastfail`, which Rust's `abort` raises too; no in-process handler sees it, only WER.
  0xc0000409: 'STATUS_STACK_BUFFER_OVERRUN (fail-fast)',
  0xc000041d: 'STATUS_FATAL_USER_CALLBACK_EXCEPTION',
  0x40010004: 'DBG_TERMINATE_PROCESS'
}

/** `code 0xC0000409 (STATUS_STACK_BUFFER_OVERRUN (fail-fast))`, `code 1`, `signal SIGKILL`. */
export function describeExit({ code, signal }: AppExit): string {
  if (signal) return `signal ${signal}`
  if (code === null) return 'no exit code'
  // Windows exit codes are a DWORD; Node reports them unsigned, but a signed one reads the same.
  const unsigned = code >>> 0
  if (unsigned < 0x40000000) return `code ${code}`
  const hex = `0x${unsigned.toString(16).toUpperCase().padStart(8, '0')}`
  const name = NTSTATUS[unsigned]
  return name ? `code ${hex} (${name})` : `code ${hex}`
}

/** The app's own minidumps: `<appDataDir>/crash-dumps`, written by its crash monitor. */
function ownDumps(appDataDir: string): string[] {
  const dir = join(appDataDir, 'crash-dumps')
  if (!existsSync(dir)) return []
  return readdirSync(dir).map((name) => join(dir, name))
}

/**
 * The WER local dump of `pid`, when the runner turned WER local dumps on and named their folder in
 * `MEMRY_E2E_WER_DUMPS`. WER also catches what the app's handler cannot: a fail-fast, a stack
 * overflow it had no stack left for.
 */
function werDumps(pid: number): string[] {
  const dir = process.env.MEMRY_E2E_WER_DUMPS
  if (!dir || !existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith(`.${pid}.dmp`))
    .map((name) => join(dir, name))
}

/** The Application Error and Application Hang events of the last ten minutes for `pid`. */
function windowsEvents(pid: number): string[] {
  if (process.platform !== 'win32') return []
  const query =
    '*[System[(EventID=1000 or EventID=1002) and TimeCreated[timediff(@SystemTime) <= 600000]]]'
  const result = spawnSync(
    'wevtutil',
    ['qe', 'Application', `/q:${query}`, '/c:20', '/rd:true', '/f:text'],
    { encoding: 'utf8', timeout: 10_000 }
  )
  if (result.status !== 0) return [`wevtutil failed: ${result.error ?? result.stderr.trim()}`]
  // 1000 writes `Faulting process id: 0x1a2b`, 1002 `Process ID: 1a2b`.
  const named = new RegExp(`process id: (0x)?${pid.toString(16)}\\b`)
  return result.stdout
    .split(/^Event\[\d+\]:/m)
    .filter((event) => named.test(event.toLowerCase()))
    .map((event) => event.trim().replace(/\r?\n\s*/g, ' | '))
}

/**
 * What the machine kept of an app that died: its minidumps (copied into `keepDir` under `tag`,
 * since the app's temp dirs are not uploaded), the WER dump of its pid, and on Windows the
 * Application Error events that name the pid with the faulting module and exception code. A
 * crashed app's dump is written by another process, so a crash exit waits a few seconds for one.
 */
export async function crashEvidence(
  app: { appDataDir: string; pid: number; exit: AppExit },
  keepDir: string,
  tag: string
): Promise<string> {
  const crashed = app.exit.signal !== null || (app.exit.code ?? 0) >>> 0 >= 0x40000000
  const found = (): string[] => [...ownDumps(app.appDataDir), ...werDumps(app.pid)]
  if (crashed) {
    await pollUntil(() => found().some((path) => path.endsWith('.dmp')) || undefined, {
      timeoutMs: 10_000,
      intervalMs: 250
    })
  }
  const lines: string[] = []
  const dumps = found()
  if (dumps.length === 0) lines.push('no minidump in crash-dumps or WER')
  for (const path of dumps) {
    const size = statSync(path).size
    if (!path.endsWith('.dmp')) {
      lines.push(`unfinished dump ${path} (${size} bytes)`)
      continue
    }
    mkdirSync(keepDir, { recursive: true })
    const kept = join(keepDir, `${tag}-${basename(path)}`)
    copyFileSync(path, kept)
    lines.push(`minidump ${kept} (${size} bytes)`)
  }
  const events = windowsEvents(app.pid)
  if (process.platform === 'win32' && events.length === 0)
    lines.push(`no Application Error event for pid ${app.pid}`)
  lines.push(...events)
  return lines.join('\n')
}

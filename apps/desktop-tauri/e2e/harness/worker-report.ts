import type { ChildProcess } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readMainLog } from './wait.ts'

const LOG_LINES = 20

export interface WorkerEnd {
  cid: string
  exitCode: number
  signal: NodeJS.Signals | null
  specs: string[]
  /** What wdio passes `onWorkerEnd`: -1 when the worker never reported back. */
  retries: number
}

/**
 * What the launcher knows about a failed worker. For a worker that exits before mocha loads its
 * spec, wdio 9.32 prints only `[0-33] FAILED (3 retries)`: no spec, no error, and retries it never
 * made (it retries a worker only once the worker reported its spec loaded).
 */
export function failedWorkerReport(
  end: WorkerEnd,
  apps: { port: number; child: ChildProcess }[]
): string {
  const prefix = `[${end.cid}]`
  const how = end.signal ? `signal ${end.signal}` : `code ${end.exitCode}`
  const when = end.retries < 0 ? ' before it loaded its spec, and wdio did not retry it' : ''
  const lines = [`${prefix} worker exited with ${how}${when}: ${end.specs.join(', ')}`]
  for (const { port, child } of apps) {
    const exited = child.exitCode !== null || child.signalCode !== null
    const state = exited ? `exited with ${child.signalCode ?? `code ${child.exitCode}`}` : 'running'
    lines.push(
      `${prefix} the app the launcher started on port ${port} (pid ${child.pid}): ${state}`
    )
    // A test's first launch removes this profile, so it is left only when no test started.
    const log = readMainLog(join(tmpdir(), 'memry-e2e', `default-${port}`, 'logs')).trimEnd()
    if (log) {
      lines.push(`${prefix} its main.log, last ${LOG_LINES} lines:`)
      lines.push(
        ...log
          .split('\n')
          .slice(-LOG_LINES)
          .map((line) => `${prefix}   ${line}`)
      )
    }
  }
  return lines.join('\n')
}

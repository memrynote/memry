import type { ChildProcess } from 'node:child_process'
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
export interface WorkerApp {
  port: number
  /** Absent when the app did not bring up its driver. */
  child?: ChildProcess
  /** The app's log dir; the profile is removed when a test first launches its own app. */
  logDir: string
}

export function failedWorkerReport(end: WorkerEnd, apps: WorkerApp[]): string {
  const prefix = `[${end.cid}]`
  const how = end.signal ? `signal ${end.signal}` : `code ${end.exitCode}`
  const when = end.retries < 0 ? ' before it loaded its spec, and wdio did not retry it' : ''
  const lines = [`${prefix} worker exited with ${how}${when}: ${end.specs.join(', ')}`]
  for (const { port, child, logDir } of apps) {
    let state = 'did not start'
    if (child && (child.exitCode !== null || child.signalCode !== null))
      state = `exited with ${child.signalCode ?? `code ${child.exitCode}`}`
    else if (child) state = 'running'
    const pid = child ? ` (pid ${child.pid})` : ''
    lines.push(`${prefix} the app the launcher started on port ${port}${pid}: ${state}`)
    const log = readMainLog(logDir).trimEnd()
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

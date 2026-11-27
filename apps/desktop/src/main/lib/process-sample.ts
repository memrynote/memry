import { execFile } from 'child_process'

export interface ProcessSample {
  /** CPU time the process has used since it started. */
  cpuSeconds: number
  /** Running or waiting for a core, as opposed to sleeping on I/O, a lock or a message. */
  runnable: boolean
}

/**
 * CPU time and run state of another process, read from `ps`: Electron's
 * `app.getAppMetrics()` leaves `cumulativeCPUUsage` out for node utility
 * processes. Undefined on Windows, for a process that is gone, or when `ps`
 * fails.
 */
export function sampleProcess(pid: number | undefined): Promise<ProcessSample | undefined> {
  if (!pid || process.platform === 'win32') return Promise.resolve(undefined)
  return new Promise((resolve) => {
    execFile('/bin/ps', ['-o', 'stat=,time=', '-p', String(pid)], (error, stdout) => {
      const [stat, time] = error ? [] : stdout.trim().split(/\s+/)
      const cpuSeconds = time ? parseCpuTime(time) : Number.NaN
      resolve(
        stat && Number.isFinite(cpuSeconds)
          ? { cpuSeconds, runnable: stat.startsWith('R') }
          : undefined
      )
    })
  })
}

/** `ps` time: `[[dd-]hh:]mm:ss[.cc]`. */
function parseCpuTime(time: string): number {
  const [days, clock] = time.includes('-') ? time.split('-') : ['0', time]
  return (
    Number(days) * 86_400 + clock.split(':').reduce((total, part) => total * 60 + Number(part), 0)
  )
}

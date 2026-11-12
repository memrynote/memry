import { execFileSync } from 'node:child_process'
import { basename } from 'node:path'

/**
 * argv of a launch that lost the single-instance lock, safe to write to a log:
 * paths shrink to their file name, flag values and deep-link queries (which can
 * carry codes and tokens) are dropped.
 */
export function redactLaunchArgv(argv: readonly string[]): string[] {
  return argv.map((arg) => {
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=')
      return eq === -1 ? arg : `${arg.slice(0, eq)}=<redacted>`
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(arg)) return arg.split(/[?#]/, 1)[0]
    return basename(arg)
  })
}

/** Executable name of the process that started this one, or undefined when it cannot be read. */
export function parentProcessName(ppid: number, platform = process.platform): string | undefined {
  if (platform === 'win32') return undefined
  try {
    const comm = execFileSync('ps', ['-o', 'comm=', '-p', String(ppid)], {
      encoding: 'utf8',
      timeout: 1000
    }).trim()
    return comm ? basename(comm) : undefined
  } catch {
    return undefined
  }
}

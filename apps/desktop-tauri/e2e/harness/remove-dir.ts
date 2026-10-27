import { rmSync } from 'node:fs'

const ATTEMPTS = 40
const DELAY_MS = 250
const RETRYABLE = new Set(['EPERM', 'EBUSY', 'ENOTEMPTY', 'EACCES'])

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Runs a file operation on a path the app used. On Windows a process that has exited keeps its
 * file handles for a moment while the kernel tears them down (`process.kill(pid, 0)` already
 * reports it gone), and WebView2 helper processes outlive the app too, so the first attempts fail
 * with EPERM or EBUSY. Node 24 reports those without honoring `rmSync`'s retry options, so retry
 * here for up to 10 seconds before the error counts. Any other error throws at once.
 */
export function retryWhileHeld<T>(operation: () => T): T {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return operation()
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? ''
      const text = error instanceof Error ? error.message : ''
      const retryable = RETRYABLE.has(code) || /^(EPERM|EBUSY|ENOTEMPTY|EACCES)\b/.test(text)
      if (!retryable || attempt >= ATTEMPTS) throw error
      pause(DELAY_MS)
    }
  }
}

/** Removes a directory (or file) the app used, waiting out handles that are still closing. */
export function removeDir(path: string): void {
  retryWhileHeld(() => rmSync(path, { recursive: true, force: true }))
}

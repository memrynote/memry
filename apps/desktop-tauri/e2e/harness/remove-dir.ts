import { rmSync } from 'node:fs'

const ATTEMPTS = 40
const DELAY_MS = 250
const RETRYABLE = new Set(['EPERM', 'EBUSY', 'ENOTEMPTY', 'EACCES'])

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Removes a directory the app used. On Windows the WebView2 helper processes outlive the app by a
 * moment and keep the profile files open, so the first attempts fail with EPERM or EBUSY. Node 24
 * reports those without honoring `rmSync`'s retry options, so retry here for up to 10 seconds
 * before the error counts. Any other error throws at once.
 */
export function removeDir(path: string): void {
  for (let attempt = 1; ; attempt += 1) {
    try {
      rmSync(path, { recursive: true, force: true })
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? ''
      const text = error instanceof Error ? error.message : ''
      const retryable = RETRYABLE.has(code) || /^(EPERM|EBUSY|ENOTEMPTY|EACCES)\b/.test(text)
      if (!retryable || attempt >= ATTEMPTS) throw error
      pause(DELAY_MS)
    }
  }
}

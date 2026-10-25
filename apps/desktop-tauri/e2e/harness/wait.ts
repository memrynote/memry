import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/** Polls `probe` until it returns a value other than `undefined`/`false`, or the timeout ends. */
export async function pollUntil<T>(
  probe: () => T | undefined | false | Promise<T | undefined | false>,
  { timeoutMs = 15_000, intervalMs = 100 }: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value !== undefined && value !== false) return value
    if (Date.now() >= deadline) return undefined
    await sleep(intervalMs)
  }
}

export function readMainLog(logDir: string): string {
  try {
    return readFileSync(join(logDir, 'main.log'), 'utf8')
  } catch {
    return ''
  }
}

/** Waits for `substring` in `<logDir>/main.log`; `logDir` is this launch's isolated dir. */
export async function waitForMainLog(
  launched: { dirs: { logDir: string } },
  substring: string,
  timeoutMs = 15_000
): Promise<boolean> {
  const found = await pollUntil(() => readMainLog(launched.dirs.logDir).includes(substring), {
    timeoutMs,
    intervalMs: 200
  })
  return found === true
}

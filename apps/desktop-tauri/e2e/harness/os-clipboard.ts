import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { isAlive } from './app-process.ts'
import { HarnessError } from './errors.ts'
import { pollUntil } from './wait.ts'

export const OS_CLIPBOARD_LOCK = join(tmpdir(), 'memry-e2e', 'os-clipboard.lock')

function holderOf(path: string): number | null {
  try {
    return Number(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function take(path: string): boolean {
  try {
    writeFileSync(path, String(process.pid), { flag: 'wx' })
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const holder = holderOf(path)
  // A worker that died holding the lock leaves it behind; read again so a lock just taken over
  // by another waiter is not removed.
  if (holder !== null && !isAlive(holder) && holderOf(path) === holder)
    rmSync(path, { force: true })
  return false
}

/**
 * Runs `steps` while no other e2e worker uses the OS clipboard. There is one clipboard per
 * machine and the workers share it, so a write from one spec's app replaced what another spec's
 * app had just copied (#3967). Hold it from the first write to the last read.
 */
export async function withOsClipboard<T>(
  steps: () => Promise<T>,
  { lock = OS_CLIPBOARD_LOCK, timeoutMs = 120_000 } = {}
): Promise<T> {
  mkdirSync(dirname(lock), { recursive: true })
  const taken = await pollUntil(() => take(lock), { timeoutMs, intervalMs: 50 })
  if (!taken) {
    throw new HarnessError(
      `the OS clipboard is still held by worker ${holderOf(lock)} after ${timeoutMs} ms`
    )
  }
  try {
    return await steps()
  } finally {
    if (holderOf(lock) === process.pid) rmSync(lock, { force: true })
  }
}

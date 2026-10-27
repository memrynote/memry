import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { retryWhileHeld } from './remove-dir'

/** `<vault>/.memry/core/data.db`, where the core keeps the vault's database. */
export const dataDbPath = (vault: string): string => join(vault, '.memry', 'core', 'data.db')

/**
 * Replaces the database with bytes that are not SQLite, so `quick_check` reports damage. The
 * WAL and shared-memory files go too: a hot WAL holds page 1 of a database the app never
 * checkpointed (it exited without closing), and SQLite reads page 1 from it before the file.
 * The app has just exited, and on Windows its handles on these files outlive it briefly, so each
 * step waits them out.
 */
export function damageDatabase(path: string): void {
  for (const sidecar of ['-wal', '-shm', '-journal']) {
    retryWhileHeld(() => rmSync(`${path}${sidecar}`, { force: true }))
  }
  retryWhileHeld(() => writeFileSync(path, Buffer.alloc(8192, 0xab)))
}

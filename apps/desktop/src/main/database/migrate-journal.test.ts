import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Drizzle's better-sqlite3 migrator applies a migration only when its journal
 * `when` (folderMillis) is GREATER than the last-applied migration's created_at
 * (see drizzle-orm sqlite-core dialect: `lastDbMigration.created_at < migration.folderMillis`).
 * A journal entry whose `when` is <= a previous entry's `when` is therefore
 * silently skipped on any database that already applied the earlier migration —
 * even though it applies fine on a fresh DB. This guards that invariant.
 */
interface JournalEntry {
  idx: number
  when: number
  tag: string
}

function loadJournal(folder: string): JournalEntry[] {
  const p = join(__dirname, folder, 'meta', '_journal.json')
  return (JSON.parse(readFileSync(p, 'utf8')).entries ?? []) as JournalEntry[]
}

describe.each(['drizzle-data', 'drizzle-index'])('%s migration journal', (folder) => {
  // drizzle reads `lastDbMigration` (max created_at) ONCE before applying, so a
  // newly-appended migration only runs on an existing DB when its `when` exceeds
  // the max of every prior migration. (Disorder among already-applied earlier
  // migrations is harmless — they were recorded with their original created_at.)
  it('newest migration `when` exceeds the max of all prior migrations', () => {
    const entries = loadJournal(folder)
    if (entries.length < 2) return
    const last = entries[entries.length - 1]
    const priorMax = Math.max(...entries.slice(0, -1).map((e) => e.when))
    expect(
      last.when,
      `newest migration ${last.tag} (when=${last.when}) must be > the max prior when (${priorMax}); ` +
        `otherwise drizzle skips it on every existing database`
    ).toBeGreaterThan(priorMax)
  })
})

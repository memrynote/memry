/**
 * A journal's last synced `tags`, `properties` and unit clocks (chapter 06
 * §6.12, #5508). Desktop reads tags and properties from the day file, so the
 * unit clocks a push carries are diffed against this base: the fields this
 * device last applied or pushed.
 *
 * The base lives in `sync_state`, so no migration is needed and an older build
 * ignores the keys.
 */
import { eq } from 'drizzle-orm'
import { syncState } from '@memry/db-schema/schema/sync-state'
import type { VectorClock } from '@memry/contracts/sync-api'
import type { DrizzleDb } from '@memry/sync-client/drizzle-db'
import { journalFieldClocksForEdit, type JournalFields } from '@memry/sync-client/journal-merge'
import { createLogger } from '../lib/logger'
import { extractJournalProperties, parseJournalEntry, readJournalTextSync } from '../vault/journal'

const log = createLogger('JournalFields')
const KEY_PREFIX = 'journal.fields:'

export function readJournalFieldsBase(db: DrizzleDb, itemId: string): JournalFields | null {
  const row = db
    .select({ value: syncState.value })
    .from(syncState)
    .where(eq(syncState.key, KEY_PREFIX + itemId))
    .get()
  if (!row) return null
  try {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- JSON.parse returns any; the value is written only by writeJournalFieldsBase
    return JSON.parse(row.value) as JournalFields
  } catch (error) {
    log.warn('Unreadable journal fields base; the day syncs whole until its next pull', {
      itemId,
      error
    })
    return null
  }
}

export function writeJournalFieldsBase(db: DrizzleDb, itemId: string, fields: JournalFields): void {
  const value = JSON.stringify(fields)
  db.insert(syncState)
    .values({ key: KEY_PREFIX + itemId, value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: syncState.key, set: { value, updatedAt: new Date() } })
    .run()
}

export function forgetJournalFieldsBase(db: DrizzleDb, itemId: string): void {
  db.delete(syncState)
    .where(eq(syncState.key, KEY_PREFIX + itemId))
    .run()
}

/** The day file's tags and properties, or `null` when the file cannot be read. */
export function readDayFields(
  date: string
): { tags: string[]; properties: Record<string, unknown> } | null {
  const raw = readJournalTextSync(date)
  if (raw === null) return null
  const parsed = parseJournalEntry(raw, date)
  return {
    tags: parsed.frontmatter.tags ?? [],
    properties: extractJournalProperties(parsed.frontmatter) ?? {}
  }
}

/**
 * This device's journal fields at `clock`: the file's values, each unit that
 * differs from the base clocked at `clock` (§6.12.2). With no base they carry
 * no unit clocks: the day was last synced by an older build, or not yet.
 */
export function localJournalFields(
  db: DrizzleDb,
  itemId: string,
  day: { tags: string[]; properties: Record<string, unknown> },
  clock: VectorClock
): JournalFields & { tags: string[]; properties: Record<string, unknown> } {
  const next = { ...day, clock }
  return { ...next, ...journalFieldClocksForEdit(readJournalFieldsBase(db, itemId), next) }
}

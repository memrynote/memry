import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

/**
 * Guard for the #1159 bug class.
 *
 * Filing wrote `filedAt`/`filedTo`/`filedAction` and never enqueued a sync
 * push, so filed items stayed filed on one device only — and a stale peer's
 * next push (buildPushPayload ships the whole row, still carrying
 * `filedAt: null`) read as a deliberate unfile and resurrected them.
 *
 * The columns below are the Inbox's triage state: they decide whether an item
 * shows up in another device's Inbox at all, so a local-only write to any of
 * them is a silent divergence. Enrichment columns (title, content, metadata,
 * processingStatus, transcription*) are deliberately out of scope here — they
 * ride along on the next push of the whole row.
 */
const TRIAGE_COLUMNS = [
  'filedAt',
  'filedTo',
  'filedAction',
  'archivedAt',
  'snoozedUntil',
  'snoozeReason'
] as const

/** Any of the runtime-effects enqueues, including the injected `deps.` form used by crud.ts. */
const SYNC_ENQUEUE_PATTERN = /\bsyncInbox(?:Create|Update|Delete)\b/

const INBOX_DIR = path.dirname(fileURLToPath(import.meta.url))

function inboxSourceFiles(): string[] {
  return readdirSync(INBOX_DIR)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .sort()
}

/**
 * Slice each `update(inboxItems)` / `insert(inboxItems)` statement out of the
 * source so a column name only counts when it is being written — `filedAt` in
 * a select filter or a type annotation must not satisfy the guard.
 */
function writeStatements(source: string): string[] {
  const statements: string[] = []
  const writeStart = /\b(?:update|insert)\(inboxItems\)/g

  let match: RegExpExecArray | null
  while ((match = writeStart.exec(source)) !== null) {
    const end = source.indexOf('.run()', match.index)
    statements.push(source.slice(match.index, end === -1 ? source.length : end))
  }

  return statements
}

describe('inbox triage writes enqueue a sync push', () => {
  const offenders: string[] = []

  for (const file of inboxSourceFiles()) {
    const source = readFileSync(path.join(INBOX_DIR, file), 'utf8')
    const writesTriageState = writeStatements(source).some((statement) =>
      TRIAGE_COLUMNS.some((column) => statement.includes(column))
    )

    if (writesTriageState && !SYNC_ENQUEUE_PATTERN.test(source)) {
      offenders.push(file)
    }
  }

  it('no inbox module writes filed/archived/snoozed state without enqueueing a push', () => {
    expect(offenders).toEqual([])
  })

  it('actually inspects the modules that own triage state', () => {
    // Cheap tripwire: if the scan silently stops matching (a refactor renames
    // the columns, or the write shape changes), the guard above would pass
    // vacuously. These three are the triage writers today.
    const scanned = inboxSourceFiles()
    expect(scanned).toEqual(expect.arrayContaining(['crud.ts', 'filing.ts', 'snooze.ts']))

    for (const file of ['crud.ts', 'filing.ts', 'snooze.ts']) {
      const source = readFileSync(path.join(INBOX_DIR, file), 'utf8')
      const statements = writeStatements(source)
      expect(
        statements.some((statement) => TRIAGE_COLUMNS.some((column) => statement.includes(column))),
        `${file} should contain a triage-state write`
      ).toBe(true)
    }
  })
})

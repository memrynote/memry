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

/**
 * Any of the runtime-effects enqueues, including the injected `deps.` form used
 * by crud.ts, plus the calendar writeback's own publisher — it reaches the same
 * queue through `tryEnqueueProjectionSyncUpdate('inbox', …)` rather than
 * through inbox/runtime-effects.
 */
const SYNC_ENQUEUE_PATTERN =
  /\b(?:syncInbox(?:Create|Update|Delete)|publishInboxCalendarMutation)\b/

const INBOX_DIR = path.dirname(fileURLToPath(import.meta.url))
/**
 * The fence is the whole main process, not `inbox/`. `readdirSync(INBOX_DIR)`
 * was both non-recursive and directory-scoped, so the Google Calendar
 * writeback (`calendar/providers/google/sync-service.ts`) — which clears `snoozedUntil`
 * on `inbox_items` — sat outside it entirely. Any module that can write triage
 * state is in scope; the `inboxItems` prefilter keeps the scan to the handful
 * of files that touch the table.
 */
const MAIN_DIR = path.resolve(INBOX_DIR, '..')

/**
 * Modules whose triage writes must NOT enqueue, with the reason. Keyed by path
 * relative to `src/main`. Kept deliberately tiny: an entry here is a promise
 * that the file only ever applies triage state that already came from
 * somewhere else.
 */
const LOCAL_ONLY_WRITERS: Record<string, string> = {
  'sync/item-handlers/inbox-handler.ts':
    'Remote-apply path. These writes ARE the incoming peer push; enqueueing here would echo every pulled change straight back to the server.'
}

function mainSourceFiles(dir: string = MAIN_DIR): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name)
  )) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...mainSourceFiles(full))
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      files.push(full)
    }
  }
  return files
}

function relativeToMain(file: string): string {
  return path.relative(MAIN_DIR, file).split(path.sep).join('/')
}

/**
 * The innermost `{ … }` block containing `index`, brace-matched outwards. This
 * is what makes the guard statement-level: the old version tested the enqueue
 * pattern against the whole file, so once `filing.ts` gained one
 * `syncInboxUpdate` every *other* triage write anyone added to it passed for
 * free, and only a brand-new file with zero enqueues could ever be caught.
 *
 * Scanning starts at the `update(inboxItems)` token, so the `.set({ … })`
 * braces of the statement itself are never in the way.
 */
function enclosingBlock(source: string, index: number): string {
  let depth = 0
  let open = -1
  for (let i = index; i >= 0; i--) {
    const ch = source[i]
    if (ch === '}') depth++
    else if (ch === '{') {
      if (depth === 0) {
        open = i
        break
      }
      depth--
    }
  }
  if (open === -1) return source

  depth = 0
  for (let i = open; i < source.length; i++) {
    const ch = source[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return source.slice(open, i + 1)
    }
  }
  return source.slice(open)
}

/**
 * Blank out string literals and comments before looking for an enqueue.
 * `markItemAsFiled` logs `'syncInboxUpdate failed; filing persisted locally'`
 * in its catch, and that string alone would satisfy the guard for every write
 * in the block — a mention is not a call.
 */
function codeOnly(block: string): string {
  return block
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/`(?:\\.|[^`\\])*`/g, '``')
}

export interface TriageWrite {
  /** 1-based line of the `update(inboxItems)` / `insert(inboxItems)` token. */
  line: number
  columns: string[]
  guarded: boolean
}

/**
 * Every `update(inboxItems)` / `insert(inboxItems)` statement that assigns a
 * triage column, paired with whether an enqueue lives in the same block.
 *
 * A column name only counts when it is being written — `filedAt` in a select
 * filter or a type annotation must not satisfy the guard — so the statement is
 * sliced from the write token to its `.run()`.
 */
export function findTriageWrites(source: string): TriageWrite[] {
  const writes: TriageWrite[] = []
  const writeStart = /\b(?:update|insert)\(inboxItems\)/g

  let match: RegExpExecArray | null
  while ((match = writeStart.exec(source)) !== null) {
    const end = source.indexOf('.run()', match.index)
    const statement = source.slice(match.index, end === -1 ? source.length : end)
    const columns = TRIAGE_COLUMNS.filter((column) => statement.includes(column))
    if (columns.length === 0) continue

    writes.push({
      line: source.slice(0, match.index).split('\n').length,
      columns,
      guarded: SYNC_ENQUEUE_PATTERN.test(codeOnly(enclosingBlock(source, match.index)))
    })
  }

  return writes
}

interface ScannedFile {
  relative: string
  writes: TriageWrite[]
}

function scanTriageWriters(): ScannedFile[] {
  const scanned: ScannedFile[] = []
  for (const file of mainSourceFiles()) {
    const source = readFileSync(file, 'utf8')
    // Cheap prefilter: only a module that names the table can write to it.
    if (!source.includes('inboxItems')) continue

    const writes = findTriageWrites(source)
    if (writes.length > 0) scanned.push({ relative: relativeToMain(file), writes })
  }
  return scanned
}

describe('inbox triage writes enqueue a sync push', () => {
  const scanned = scanTriageWriters()

  it('no triage write in the main process lands without an enqueue beside it', () => {
    const offenders = scanned
      .filter((file) => !(file.relative in LOCAL_ONLY_WRITERS))
      .flatMap((file) =>
        file.writes
          .filter((write) => !write.guarded)
          .map((write) => `${file.relative}:${write.line} [${write.columns.join(', ')}]`)
      )

    expect(offenders).toEqual([])
  })

  it('actually inspects every module that owns triage state', () => {
    // Tripwire: if the scan silently stops matching (a refactor renames the
    // columns, moves a module, or changes the write shape), the guard above
    // would pass vacuously. These are the triage writers today.
    const writers = scanned.map((file) => file.relative)
    expect(writers).toEqual(
      expect.arrayContaining([
        'inbox/crud.ts',
        'inbox/filing.ts',
        'inbox/snooze.ts',
        // The calendar → inbox_snooze writeback; provider-neutral since #1393.
        'calendar/sync/writeback.ts',
        'sync/item-handlers/inbox-handler.ts'
      ])
    )
  })

  it('keeps the local-only allowlist honest', () => {
    // A stale entry is worse than no entry: it silently exempts a file that no
    // longer writes triage state — and would exempt whatever is added to it
    // later. Every allowlisted path must still be a real, scanned writer.
    for (const [relative, reason] of Object.entries(LOCAL_ONLY_WRITERS)) {
      expect(scanned.map((file) => file.relative)).toContain(relative)
      expect(reason.length).toBeGreaterThan(0)
    }
  })
})

describe('findTriageWrites', () => {
  // The guard is only worth its runtime if it fails on the shape it exists to
  // catch. These run the analyzer against synthetic sources so a regression in
  // the analyzer itself cannot make the scan above pass vacuously.

  it('flags a triage write with no enqueue in its block', () => {
    const source = `
      function unfile(id: string): void {
        db.update(inboxItems).set({ filedAt: null }).where(eq(inboxItems.id, id)).run()
      }
    `
    expect(findTriageWrites(source)).toEqual([
      expect.objectContaining({ columns: ['filedAt'], guarded: false })
    ])
  })

  it('flags a second unguarded write in a file that already enqueues elsewhere', () => {
    // The exact hole in the file-level guard this replaced.
    const source = `
      function file(id: string): void {
        db.update(inboxItems).set({ filedAt: now }).where(eq(inboxItems.id, id)).run()
        syncInboxUpdate(id)
      }

      function archive(id: string): void {
        db.update(inboxItems).set({ archivedAt: now }).where(eq(inboxItems.id, id)).run()
      }
    `
    expect(findTriageWrites(source).map((write) => write.guarded)).toEqual([true, false])
  })

  it('accepts an enqueue that sits in a nested block of the same function', () => {
    const source = `
      function file(id: string): void {
        db.update(inboxItems).set({ filedAt: now }).where(eq(inboxItems.id, id)).run()
        try {
          syncInboxUpdate(id)
        } catch (error) {
          log.warn('failed', error)
        }
      }
    `
    expect(findTriageWrites(source).map((write) => write.guarded)).toEqual([true])
  })

  it('does not accept a log message that merely names the enqueue', () => {
    const source = `
      function file(id: string): void {
        db.update(inboxItems).set({ filedAt: now }).where(eq(inboxItems.id, id)).run()
        log.warn('syncInboxUpdate failed; filing persisted locally')
      }
    `
    expect(findTriageWrites(source).map((write) => write.guarded)).toEqual([false])
  })

  it('does not count a triage column that is only read', () => {
    const source = `
      function markViewed(id: string): void {
        const existing = db.select().from(inboxItems).where(eq(inboxItems.filedAt, null)).get()
        db.update(inboxItems).set({ viewedAt: now }).where(eq(inboxItems.id, id)).run()
      }
    `
    expect(findTriageWrites(source)).toEqual([])
  })
})

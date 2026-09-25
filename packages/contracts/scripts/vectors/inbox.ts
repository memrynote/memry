/**
 * Class: inbox (`inbox.json`, spec 006 IB014).
 *
 * Two sections.
 *
 * - `apply`: payload sequences in the shapes desktop has pushed (its current
 *   full-row push, an older build's payload, explicit-null clears, a stale
 *   remote, a tombstone) and the row desktop ends up holding. Each payload goes
 *   through the real `InboxSyncPayloadSchema`, then through the rules of
 *   `apps/desktop/src/main/sync/item-handlers/inbox-handler.ts` `applyUpsert`
 *   and `applyDelete`, restated below line for line (the handler needs
 *   desktop's Electron database and cannot be imported here).
 * - `views`: one set of rows at a fixed `now`, and what desktop's reads answer
 *   for them: `handleList` (`queries.ts`), `getSnoozedItems` (`snooze.ts`),
 *   `countReviewableInboxItems` and the stats of `stats.ts` over the
 *   `inbox_stats` rows `rebuildInboxStatsTable` derives, restated the same way.
 *
 * Chapter: docs/protocol/13-payload-schemas.md §13.7.15.
 */
import { InboxSyncPayloadSchema } from '../../src/sync-payloads'
import { APPLY_FIXTURES, VIEW_ROWS, VIEWS_NOW } from './inbox-cases'
import { meta } from './shared'

type Clock = Record<string, number>
type Row = Record<string, unknown>

const NULLABLE = [
  'content',
  'metadata',
  'filedAt',
  'filedTo',
  'filedAction',
  'snoozedUntil',
  'snoozeReason',
  'archivedAt',
  'sourceUrl',
  'sourceTitle',
  'captureSource'
] as const
const ROW_KEYS = ['type', 'title', ...NULLABLE, 'createdAt'] as const
const DAY = 86_400_000

function compare(a: Clock, b: Clock): 'after' | 'before' | 'equal' | 'concurrent' {
  let aAhead = false
  let bAhead = false
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[key] ?? 0
    const y = b[key] ?? 0
    if (x > y) aAhead = true
    if (y > x) bAhead = true
  }
  if (aAhead && bAhead) return 'concurrent'
  if (aAhead) return 'after'
  if (bAhead) return 'before'
  return 'equal'
}

const iso = (value: unknown): unknown =>
  typeof value === 'string' && !Number.isNaN(Date.parse(value))
    ? new Date(value).toISOString()
    : value

/** `applyUpsert` / `applyDelete` on one parsed payload. */
function applyDesktop(existing: Row | null, raw: Row, deleted: boolean): Row | null {
  const data = InboxSyncPayloadSchema.parse(raw) as Row
  const clock = (data.clock ?? {}) as Clock
  if (deleted) {
    if (!existing) return null
    return compare((existing.clock ?? {}) as Clock, clock) === 'after' ? existing : null
  }
  if (!existing) {
    const row: Row = { type: data.type ?? 'note', title: data.title ?? 'Untitled', clock }
    for (const key of NULLABLE) row[key] = data[key] ?? null
    row.createdAt = data.createdAt ?? null
    return row
  }
  const cmp = compare((existing.clock ?? {}) as Clock, clock)
  if (cmp === 'after') return existing
  const hasKey = (k: string): boolean => Object.prototype.hasOwnProperty.call(data, k)
  const next: Row = {
    ...existing,
    title: data.title ?? existing.title,
    type: data.type ?? existing.type
  }
  for (const key of NULLABLE) next[key] = hasKey(key) ? (data[key] ?? null) : existing[key]
  return next
}

function projected(row: Row | null): Row | null {
  if (!row) return null
  const out: Row = {}
  for (const key of ROW_KEYS) {
    const value = row[key] ?? null
    out[key] = key.endsWith('At') || key === 'snoozedUntil' ? iso(value) : value
  }
  return out
}

function buildApply(): Row[] {
  return APPLY_FIXTURES.map((fixture) => {
    let row: Row | null = null
    for (const step of fixture.steps) row = applyDesktop(row, step.payload, step.deleted === true)
    return { name: fixture.name, steps: fixture.steps, expected: projected(row) }
  })
}

const dayOf = (ms: number): number => Math.floor(ms / DAY)
const COUNTED = ['link', 'note', 'image', 'voice', 'clip', 'pdf', 'social', 'reminder']

function buildViews(): Row {
  const rows = VIEW_ROWS.map(({ id, payload }) => {
    const p = InboxSyncPayloadSchema.parse(payload) as Row
    const ms = (k: string): number | null =>
      typeof p[k] === 'string' ? Date.parse(p[k] as string) : null
    return {
      id,
      type: p.type as string,
      createdAt: ms('createdAt') ?? 0,
      filedAt: ms('filedAt'),
      snoozedUntil: ms('snoozedUntil'),
      archivedAt: ms('archivedAt'),
      processing: (payload.processingStatus as string | undefined) ?? null
    }
  })
  const pending = rows.filter(
    (r) => r.filedAt === null && r.snoozedUntil === null && r.archivedAt === null
  )
  const newestFirst = (
    a: { createdAt: number; id: string },
    b: { createdAt: number; id: string }
  ): number => b.createdAt - a.createdAt || a.id.localeCompare(b.id)
  const staleCutoff = VIEWS_NOW - 7 * DAY
  const captured = new Map<number, number>()
  const processed = new Map<number, number>()
  for (const r of rows) {
    if (COUNTED.includes(r.type))
      captured.set(dayOf(r.createdAt), (captured.get(dayOf(r.createdAt)) ?? 0) + 1)
    if (r.filedAt !== null)
      processed.set(dayOf(r.filedAt), (processed.get(dayOf(r.filedAt)) ?? 0) + 1)
  }
  const today = dayOf(VIEWS_NOW)
  const weekStart = dayOf(VIEWS_NOW - 7 * DAY)
  const sum = (m: Map<number, number>): number =>
    [...m].filter(([d]) => d >= weekStart).reduce((n, [, c]) => n + c, 0)
  const capturedThisWeek = sum(captured)
  const processedThisWeek = sum(processed)
  const filedRecent = rows.filter((r) => r.filedAt !== null && r.filedAt > VIEWS_NOW - 30 * DAY)
  const minutes = filedRecent.map((r) => ((r.filedAt as number) - r.createdAt) / 60_000)
  // getProcessingStreak
  let streak = 0
  let check = today
  for (let i = 0; i < 90; i++) {
    if ((processed.get(check) ?? 0) > 0) streak++
    else if (i > 0) break
    else if ((processed.get(check - 1) ?? 0) > 0) {
      check -= 2
      streak++
      continue
    } else break
    check -= 1
  }
  const typeCounts: Record<string, number> = {}
  for (const t of [
    'link',
    'note',
    'image',
    'voice',
    'video',
    'clip',
    'pdf',
    'social',
    'reminder'
  ]) {
    typeCounts[t] = pending.filter((r) => r.type === t).length
  }
  return {
    now: new Date(VIEWS_NOW).toISOString(),
    staleDays: 7,
    rows: VIEW_ROWS,
    expected: {
      listIds: [...pending].sort(newestFirst).map((r) => r.id),
      snoozedIds: rows
        .filter((r) => r.snoozedUntil !== null && r.filedAt === null)
        .map((r) => r.id),
      typeCounts,
      reviewable: pending.length,
      fetching: rows.filter(
        (r) =>
          r.filedAt === null &&
          r.archivedAt === null &&
          (r.processing === 'pending' || r.processing === 'processing')
      ).length,
      stats: {
        totalItems: pending.length,
        staleCount: pending.filter((r) => r.createdAt < staleCutoff).length,
        snoozedCount: rows.filter((r) => r.snoozedUntil !== null && r.archivedAt === null).length,
        capturedToday: captured.get(today) ?? 0,
        processedToday: processed.get(today) ?? 0,
        capturedThisWeek,
        processedThisWeek,
        avgTimeToProcess: minutes.length
          ? Math.round(minutes.reduce((a, b) => a + b, 0) / minutes.length)
          : 0,
        currentStreak: streak,
        processRate:
          capturedThisWeek > 0 ? Math.round((processedThisWeek / capturedThisWeek) * 100) : 0
      }
    }
  }
}

export function buildInbox(): Record<string, unknown> {
  const apply = buildApply()
  return {
    meta: meta({
      class: 'inbox',
      spec: '006-ios-inbox',
      chapter: 'docs/protocol/13-payload-schemas.md §13.7.15',
      reference:
        'apps/desktop/src/main/sync/item-handlers/inbox-handler.ts, apps/desktop/src/main/inbox/{queries,snooze,stats}.ts',
      caseCount: apply.length + 1
    }),
    apply,
    views: buildViews()
  }
}

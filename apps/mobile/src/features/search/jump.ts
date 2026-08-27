import { InboxSyncPayloadSchema, TaskSyncPayloadSchema } from '@memry/contracts/sync-payloads'
import type { VaultDb } from '@/db/index'
import type { JumpTarget } from './repo'
import { formatJournalDate } from './subtitle'

export async function loadJumpTargets(db: VaultDb, todayIso: string): Promise<JumpTarget[]> {
  const toTriage = await countToTriage(db, todayIso)
  const overdue = await countOverdue(db, todayIso)

  return [
    {
      kind: 'todays-journal',
      title: "Today's journal",
      subtitle: formatJournalDate(todayIso),
      count: 0
    },
    {
      kind: 'inbox',
      title: 'Inbox',
      subtitle: toTriage === 0 ? 'Nothing to triage' : `${toTriage} to triage`,
      count: toTriage
    },
    {
      kind: 'overdue-tasks',
      title: 'Overdue tasks',
      subtitle: String(overdue),
      count: overdue
    }
  ]
}

async function countToTriage(db: VaultDb, todayIso: string): Promise<number> {
  let count = 0
  for (const raw of await payloadsOfType(db, 'inbox')) {
    const parsed = InboxSyncPayloadSchema.safeParse(parseJson(raw))
    if (!parsed.success) continue
    const { filedAt, archivedAt, snoozedUntil } = parsed.data
    if (filedAt || archivedAt) continue
    // `snoozedUntil` is a full timestamp, so it sorts after the bare
    // `YYYY-MM-DD` of the same day. An item snoozed to today therefore stays
    // hidden until tomorrow, which is what "snoozed until today" means.
    if (snoozedUntil && snoozedUntil >= todayIso) continue
    count += 1
  }
  return count
}

async function countOverdue(db: VaultDb, todayIso: string): Promise<number> {
  let count = 0
  for (const raw of await payloadsOfType(db, 'task')) {
    const parsed = TaskSyncPayloadSchema.safeParse(parseJson(raw))
    if (!parsed.success) continue
    const { completedAt, archivedAt, dueDate } = parsed.data
    if (completedAt != null || archivedAt != null) continue
    if (!dueDate || dueDate >= todayIso) continue
    count += 1
  }
  return count
}

async function payloadsOfType(db: VaultDb, type: string): Promise<string[]> {
  const rows = await db.getAllAsync<{ payload: string | null }>(
    `SELECT payload FROM sync_items
     WHERE type = ? AND deleted_at IS NULL AND payload_state = 'full'`,
    [type]
  )
  return rows
    .map((row) => row.payload)
    .filter((payload): payload is string => payload !== null && payload.length > 0)
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

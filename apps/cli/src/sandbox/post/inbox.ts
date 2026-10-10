import { createId } from '@memry/app-core/ids'

import { inboxSpecs } from '../content/inbox.ts'
import type { PostContext } from './index.ts'

const STAT_COLUMNS: Record<string, string> = {
  link: 'capture_count_link',
  note: 'capture_count_note',
  image: 'capture_count_image',
  voice: 'capture_count_voice',
  clip: 'capture_count_clip',
  pdf: 'capture_count_pdf',
  social: 'capture_count_social',
  reminder: 'capture_count_reminder'
}

/**
 * Inbox history. Every CLI capture is stamped "now", which would make nothing
 * stale and the Insights charts a single spike. Items get their capture,
 * view, archive and filing times back-dated; desktop's filing path also logs
 * each decision in `filing_history` (apps/desktop/src/main/inbox/filing.ts
 * recordFilingHistory), which feeds filing suggestions, and keeps the derived
 * `inbox_stats` table (apps/desktop/src/main/inbox/stats.ts
 * rebuildInboxStatsTable). Both are written here the same way.
 */
export function inboxHistory({ ctx, data }: PostContext): void {
  const { clock } = ctx
  const updateItem = data.prepare(
    `UPDATE inbox_items SET created_at = ?, modified_at = ?,
       viewed_at = CASE WHEN viewed_at IS NULL THEN NULL ELSE ? END,
       archived_at = CASE WHEN archived_at IS NULL THEN NULL ELSE ? END,
       filed_at = CASE WHEN filed_at IS NULL THEN NULL ELSE ? END
     WHERE id = ?`
  )
  const history = data.prepare(
    'INSERT INTO filing_history (id, item_type, item_content, filed_to, filed_action, tags, filed_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  )
  const read = data.prepare(
    'SELECT type, content, filed_to, filed_action FROM inbox_items WHERE id = ?'
  )

  for (const [index, spec] of inboxSpecs.entries()) {
    const id = ctx.inbox.get(spec.key)!
    const hour = `${String(8 + (index % 11)).padStart(2, '0')}:${String((index * 17) % 60).padStart(2, '0')}`
    const captured = new Date(
      Math.min(new Date(clock.ago(spec.age, hour)).getTime(), clock.now.getTime() - 3_600_000)
    )
    const later = new Date(
      Math.min(captured.getTime() + 20 * 3_600_000, clock.now.getTime() - 60_000)
    ).toISOString()
    updateItem.run(captured.toISOString(), later, later, later, later, id)

    if (!spec.filed) continue
    const item = read.get(id) as {
      type: string
      content: string | null
      filed_to: string
      filed_action: string
    }
    history.run(
      createId('filing'),
      item.type,
      item.content?.slice(0, 500) ?? null,
      item.filed_to,
      item.filed_action,
      JSON.stringify(spec.tags ?? []),
      later
    )
  }

  const rows = data
    .prepare('SELECT type, created_at, filed_at, archived_at FROM inbox_items')
    .all() as Array<{
    type: string
    created_at: string
    filed_at: string | null
    archived_at: string | null
  }>
  const byDate = new Map<string, Record<string, number>>()
  const bump = (iso: string, column: string): void => {
    const date = iso.slice(0, 10)
    const counts = byDate.get(date) ?? {}
    counts[column] = (counts[column] ?? 0) + 1
    byDate.set(date, counts)
  }
  for (const row of rows) {
    if (STAT_COLUMNS[row.type]) bump(row.created_at, STAT_COLUMNS[row.type])
    if (row.filed_at) bump(row.filed_at, 'processed_count')
    if (row.archived_at) bump(row.archived_at, 'archived_count')
  }
  data.prepare('DELETE FROM inbox_stats').run()
  for (const [date, counts] of byDate) {
    const columns = Object.keys(counts)
    data
      .prepare(
        `INSERT INTO inbox_stats (id, date, ${columns.join(', ')}) VALUES (?, ?, ${columns.map(() => '?').join(', ')})`
      )
      .run(createId('istat'), date, ...columns.map((column) => counts[column]))
  }
}

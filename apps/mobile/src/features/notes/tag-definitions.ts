import type { VaultDb } from '@/db/index'
import { withVaultTransaction } from '@/db/tx'
import { createLogger } from '@/lib/logger'
import { bumpClock } from '@/sync/outbox'
import { normalizeTagKey, type NoteOpsContext } from './note-ops'

const log = createLogger('TagDefinitions')

/**
 * The colour each tag was actually given, by normalized tag name.
 *
 * A `tag_definition` row's id IS the tag name, and its payload carries the
 * `color` the user picked on whichever device picked it. `tag_definition` is a
 * LEGACY sync type, so it reaches this device even though the client sends no
 * `X-Memry-Sync-Types` header — the rows are already here, nothing was reading
 * them.
 *
 * A tag with no row is not an error: the shared hash in `tagColor` gives it the
 * same colour desktop gives it.
 */
export async function readTagColors(db: VaultDb): Promise<Map<string, string>> {
  const rows = await db.getAllAsync<{ id: string; payload: string | null }>(
    `SELECT id, payload FROM sync_items WHERE type = 'tag_definition' AND deleted_at IS NULL`
  )
  const colors = new Map<string, string>()
  for (const row of rows) {
    if (!row.payload) continue
    try {
      const color = (JSON.parse(row.payload) as { color?: unknown }).color
      if (typeof color === 'string' && color.length > 0) {
        colors.set(normalizeTagKey(row.id), color)
      }
    } catch {
      log.warn('Tag definition payload is not JSON; skipping', { tag: row.id })
    }
  }
  return colors
}

/**
 * The colour AND icon each tag was given, by normalized tag name.
 *
 * `readTagColors` above answers the one question the chip renderers ask; the
 * `#` inline menu also needs the tag's emoji, and reading the table twice for
 * one menu open is a scan this device does not need to pay twice.
 */
export async function readTagStyles(db: VaultDb): Promise<Map<string, TagStyle>> {
  const rows = await db.getAllAsync<{ id: string; payload: string | null }>(
    `SELECT id, payload FROM sync_items WHERE type = 'tag_definition' AND deleted_at IS NULL`
  )
  const styles = new Map<string, TagStyle>()
  for (const row of rows) {
    if (!row.payload) continue
    try {
      const parsed = JSON.parse(row.payload) as { color?: unknown; icon?: unknown }
      styles.set(normalizeTagKey(row.id), {
        color: typeof parsed.color === 'string' ? parsed.color : '',
        icon: typeof parsed.icon === 'string' ? parsed.icon : ''
      })
    } catch {
      log.warn('Tag definition payload is not JSON; skipping', { tag: row.id })
    }
  }
  return styles
}

export interface TagStyle {
  color: string
  icon: string
}

interface TagDefinitionPayload {
  name?: string
  color?: string
  colorAuthored?: boolean
  icon?: string | null
  categoryId?: string | null
  sortOrder?: number
  views?: unknown
  clock?: Record<string, number>
  createdAt?: string
  [unknownFieldsFromNewerClients: string]: unknown
}

/**
 * Give a tag a colour and queue the row, so the pick reaches desktop and every
 * other device instead of staying on this phone.
 */
export async function writeTagColorRow(
  ctx: NoteOpsContext,
  tag: string,
  color: string
): Promise<void> {
  const existing = await ctx.db.getFirstAsync<{ id: string; payload: string | null }>(
    `SELECT id, payload FROM sync_items
     WHERE type = 'tag_definition' AND id = ? COLLATE NOCASE AND deleted_at IS NULL`,
    [tag]
  )
  // Desktop's tag primary key is COLLATE NOCASE, `sync_items.id` here is a plain
  // TEXT primary key. Writing `roadmap` while the row is stored as `Roadmap`
  // would fork one tag into two rows that only ever disagree, so the stored
  // casing wins whenever a row already exists.
  const id = existing?.id ?? tag
  const now = Date.now()

  let stored: TagDefinitionPayload | null = null
  if (existing?.payload) {
    try {
      stored = JSON.parse(existing.payload) as TagDefinitionPayload
    } catch {
      log.warn('Tag definition payload is not JSON; rewriting it', { tag: id })
    }
  }
  const payload: TagDefinitionPayload = stored ?? {
    name: id,
    createdAt: new Date(now).toISOString()
  }

  payload.name = id
  payload.color = color
  // Desktop only records authorship when it sees `colorAuthored === true`. Without
  // it the colour imports but counts as one the palette handed out, so it is never
  // re-asserted onward and a third device keeps the hashed hue.
  payload.colorAuthored = true
  bumpClock(payload as Record<string, unknown>, ctx.deviceId)
  const serialized = JSON.stringify(payload)

  await withVaultTransaction(ctx.db, async () => {
    await ctx.db.runAsync(
      `INSERT INTO sync_items (id, type, vault_id, updated_at, deleted_at, payload_state, payload)
       VALUES (?, 'tag_definition', ?, ?, NULL, 'full', ?)
       ON CONFLICT(id) DO UPDATE SET
         updated_at = excluded.updated_at,
         deleted_at = NULL,
         payload_state = 'full',
         payload = excluded.payload`,
      [id, ctx.vaultId, now, serialized]
    )
    await ctx.outbox.enqueueRecord('tag_definition', id, 'update', serialized)
  })
}

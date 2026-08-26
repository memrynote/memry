import type { VaultDb } from '@/db/index'
import { createLogger } from '@/lib/logger'
import { createNote, type NoteOpsContext, type NotePayload } from './note-ops'

const log = createLogger('NoteFromTemplate')

/**
 * Create a note from a template (T070 / FR-017).
 *
 * Templates arrive as `template` sync items like anything else, so this reads
 * the pulled payload rather than the vault's `.memry/templates` files — which
 * mobile has no reader for. The resulting note is an ordinary create: the body
 * rides in the record payload exactly once (desktop's rule), and tags and
 * properties are seeded from the template before the first push.
 */

export interface TemplateSummary {
  id: string
  name: string
  description?: string
}

interface TemplatePayload {
  name?: string
  description?: string
  content?: string
  tags?: string[]
  properties?: { name: string; value: unknown }[]
}

export async function listTemplates(db: VaultDb): Promise<TemplateSummary[]> {
  const rows = await db.getAllAsync<{ id: string; payload: string | null }>(
    `SELECT id, payload FROM sync_items
     WHERE type = 'template' AND deleted_at IS NULL AND payload_state = 'full'
     ORDER BY updated_at DESC`
  )
  const out: TemplateSummary[] = []
  for (const row of rows) {
    if (!row.payload) continue
    try {
      const payload = JSON.parse(row.payload) as TemplatePayload
      out.push({
        id: row.id,
        name: payload.name ?? 'Untitled template',
        description: payload.description
      })
    } catch {
      log.warn('Template payload is not JSON; skipping', { templateId: row.id })
    }
  }
  return out
}

export async function createNoteFromTemplate(
  ctx: NoteOpsContext,
  templateId: string,
  options: { title?: string; folderPath?: string | null } = {}
): Promise<string | null> {
  const row = await ctx.db.getFirstAsync<{ payload: string | null }>(
    `SELECT payload FROM sync_items WHERE id = ? AND type = 'template'`,
    [templateId]
  )
  if (!row?.payload) return null

  let template: TemplatePayload
  try {
    template = JSON.parse(row.payload) as TemplatePayload
  } catch {
    log.warn('Template payload is not JSON; refusing to instantiate', { templateId })
    return null
  }

  const noteId = await createNote(ctx, {
    title: options.title?.trim() || template.name || 'Untitled',
    folderPath: options.folderPath ?? null,
    content: template.content ?? ''
  })

  const seeded = seedFromTemplate(template)
  if (Object.keys(seeded.properties).length > 0 || seeded.tags.length > 0) {
    // A second write rather than a create-time one: `createNote` owns the
    // payload shape, and threading template fields through it would give every
    // caller a template-shaped parameter it does not use.
    const current = await ctx.db.getFirstAsync<{ payload: string }>(
      'SELECT payload FROM sync_items WHERE id = ?',
      [noteId]
    )
    if (current?.payload) {
      const payload = JSON.parse(current.payload) as NotePayload
      payload.tags = seeded.tags
      payload.properties = seeded.properties
      await ctx.db.runAsync('UPDATE sync_items SET payload = ? WHERE id = ?', [
        JSON.stringify(payload),
        noteId
      ])
      await ctx.outbox.enqueueRecord('note', noteId, 'update', JSON.stringify(payload))
    }
  }

  return noteId
}

/** Template properties are a LIST of `{name, value}`; notes store a record. */
export function seedFromTemplate(template: TemplatePayload): {
  tags: string[]
  properties: Record<string, unknown>
} {
  const properties: Record<string, unknown> = {}
  for (const property of template.properties ?? []) {
    if (!property?.name) continue
    properties[property.name] = property.value ?? ''
  }
  return { tags: [...(template.tags ?? [])], properties }
}

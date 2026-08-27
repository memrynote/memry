import type { VaultDb } from '@/db/index'
import { withVaultTransaction } from '@/db/tx'
import { createLogger } from '@/lib/logger'
import { bumpClock, type OutboxStore } from '@/sync/outbox'

const log = createLogger('NoteOps')

/**
 * Local note management (T064 / FR-012): create, rename, move, delete.
 *
 * Every operation does the same two things in the same order — write the local
 * projection, then enqueue the push — so the UI is correct offline and the
 * server catches up whenever it can.
 *
 * The payload rule is the one that matters for compatibility: a note's stored
 * payload JSON is read VERBATIM, only the fields being changed are touched,
 * and the whole object is written back. A newer desktop's unknown fields
 * therefore survive a mobile edit untouched (baseline migration's rule;
 * pinned by the unknown-field round-trip in the convergence suite).
 */

export interface NotePayload {
  title?: string
  folderPath?: string | null
  content?: string | null
  tags?: string[]
  properties?: Record<string, unknown>
  clock?: Record<string, number>
  createdAt?: number
  modifiedAt?: number
  [unknownFieldsFromNewerClients: string]: unknown
}

/** Item types the note editor can open. */
export type EditableItemType = 'note' | 'journal'

interface StoredNote {
  type: EditableItemType
  payload: NotePayload
}

/**
 * Read a note (or journal) with its ACTUAL item type.
 *
 * The type has to travel with the payload: journals are editable through the
 * same screen — a wiki link reaches one — and server uniqueness is
 * `(user_id, vault_id, item_type, item_id)`. Pushing a journal edit as a
 * `note` therefore INSERTS a phantom row instead of updating the journal, and
 * the real entry never changes on any device.
 */
async function readStoredNote(db: VaultDb, noteId: string): Promise<StoredNote | null> {
  // `deleted_at IS NULL` is the point: a write that lands after a delete
  // queues an `update`, and an update is newer than the tombstone — the note
  // comes back on every other device. Editing a deleted note is not an error
  // worth surfacing, it is simply not a thing that can happen.
  const row = await db.getFirstAsync<{ type: string; payload: string | null }>(
    'SELECT type, payload FROM sync_items WHERE id = ? AND type IN (?, ?) AND deleted_at IS NULL',
    [noteId, 'note', 'journal']
  )
  if (!row?.payload) return null
  try {
    return {
      type: row.type === 'journal' ? 'journal' : 'note',
      payload: JSON.parse(row.payload) as NotePayload
    }
  } catch {
    log.warn('Note payload is not JSON; refusing to edit it', { noteId })
    return null
  }
}

export async function readNotePayload(db: VaultDb, noteId: string): Promise<NotePayload | null> {
  return (await readStoredNote(db, noteId))?.payload ?? null
}

async function writeNotePayload(
  db: VaultDb,
  noteId: string,
  payload: NotePayload,
  updatedAt: number
): Promise<void> {
  await db.runAsync(
    `UPDATE sync_items SET payload = ?, payload_state = 'full', updated_at = ? WHERE id = ?`,
    [JSON.stringify(payload), updatedAt, noteId]
  )
}

/**
 * The local write and its queue row, in ONE transaction.
 *
 * Same rule the editor's own persist path follows: a kill between the two
 * leaves a change the user can see on this device and that nothing will ever
 * push — invisible, and permanent.
 */
async function writeAndEnqueue(
  ctx: NoteOpsContext,
  write: () => Promise<void>,
  enqueue: () => Promise<void>
): Promise<void> {
  await withVaultTransaction(ctx.db, async () => {
    await write()
    await enqueue()
  })
}

export interface NoteOpsContext {
  db: VaultDb
  outbox: OutboxStore
  vaultId: string
  deviceId: string
}

/**
 * Apply a change to a note's metadata and queue it.
 *
 * `mutate` receives the payload exactly as stored — including whatever a newer
 * client wrote — and is expected to change only its own fields.
 */
export async function updateNote(
  ctx: NoteOpsContext,
  noteId: string,
  mutate: (payload: NotePayload) => void
): Promise<NotePayload | null> {
  const stored = await readStoredNote(ctx.db, noteId)
  if (!stored) return null
  const { type, payload } = stored

  mutate(payload)
  const now = Date.now()
  payload.modifiedAt = now
  bumpClock(payload as Record<string, unknown>, ctx.deviceId)
  const serialized = JSON.stringify(payload)

  await writeAndEnqueue(
    ctx,
    () => writeNotePayload(ctx.db, noteId, payload, now),
    // The item's OWN type, never a hardcoded 'note': server uniqueness is
    // (user, vault, item_type, item_id).
    () => ctx.outbox.enqueueRecord(type, noteId, 'update', serialized)
  )
  return payload
}

export async function renameNote(
  ctx: NoteOpsContext,
  noteId: string,
  title: string
): Promise<void> {
  const trimmed = title.trim()
  if (trimmed.length === 0) return
  await updateNote(ctx, noteId, (payload) => {
    payload.title = trimmed
  })
  // The derived path is informational (title collisions are real data), so it
  // is refreshed rather than enforced — see the 0002 migration.
  await refreshDerivedPath(ctx.db, noteId)
}

export async function moveNote(
  ctx: NoteOpsContext,
  noteId: string,
  folderPath: string | null
): Promise<void> {
  await updateNote(ctx, noteId, (payload) => {
    payload.folderPath = folderPath === '' ? null : folderPath
  })
  await refreshDerivedPath(ctx.db, noteId)
}

export async function createNote(
  ctx: NoteOpsContext,
  input: { title: string; folderPath?: string | null; content?: string }
): Promise<string> {
  const noteId = generateId()
  const now = Date.now()
  const payload: NotePayload = {
    title: input.title.trim() || 'Untitled',
    // Create is the ONE operation that carries the body in the record payload;
    // every later body change travels the CRDT path (desktop's rule, mirrored).
    content: input.content ?? '',
    tags: [],
    properties: {},
    folderPath: input.folderPath ?? null,
    createdAt: now,
    modifiedAt: now
  }
  bumpClock(payload as Record<string, unknown>, ctx.deviceId)

  const serialized = JSON.stringify(payload)
  await withVaultTransaction(ctx.db, async () => {
    await ctx.db.runAsync(
      `INSERT INTO sync_items (id, type, vault_id, updated_at, payload_state, payload)
       VALUES (?, 'note', ?, ?, 'full', ?)`,
      [noteId, ctx.vaultId, now, serialized]
    )
    await ctx.db.runAsync(
      `INSERT INTO note_bodies (item_id, path, markdown, fetched_at) VALUES (?, ?, ?, ?)`,
      [noteId, derivePath(payload), payload.content ?? '', now]
    )
    await ctx.outbox.enqueueRecord('note', noteId, 'create', serialized)
  })
  return noteId
}

/**
 * Delete a note. The tombstone is what replicates, so the local row is marked
 * deleted rather than removed — a hard delete here would make the next pull
 * treat the server's copy as new and resurrect it.
 */
export async function deleteNote(ctx: NoteOpsContext, noteId: string): Promise<void> {
  const stored = await readStoredNote(ctx.db, noteId)
  const now = Date.now()

  let type: EditableItemType
  let serialized: string

  if (stored) {
    type = stored.type
    bumpClock(stored.payload as Record<string, unknown>, ctx.deviceId)
    serialized = JSON.stringify(stored.payload)
  } else {
    // No parseable payload — either the row is gone, or its JSON is broken (a
    // note the list already shows as "Untitled"). Replacing it with `{}` would
    // push a tombstone whose clock is `{thisDevice: 1}`, which peers' field
    // merge treats as older than what they hold and skip: the note would come
    // back. The stored bytes are reused verbatim instead.
    const raw = await ctx.db.getFirstAsync<{ type: string; payload: string | null }>(
      'SELECT type, payload FROM sync_items WHERE id = ?',
      [noteId]
    )
    if (!raw) return
    type = raw.type === 'journal' ? 'journal' : 'note'
    serialized = raw.payload ?? '{}'
    if (!raw.payload) {
      log.warn('Deleting an item with no stored payload; the tombstone carries no clock', {
        noteId
      })
    }
  }

  await withVaultTransaction(ctx.db, async () => {
    // The bumped clock is written back with the tombstone. Without it a later
    // pull sees a clock that never advanced and can treat a remote update as
    // newer than the delete.
    await ctx.db.runAsync(
      'UPDATE sync_items SET deleted_at = ?, updated_at = ?, payload = ? WHERE id = ?',
      [now, now, serialized, noteId]
    )
    await ctx.db.runAsync('DELETE FROM note_bodies WHERE item_id = ?', [noteId])
    // Queued body updates describe a note that no longer exists; sending them
    // after the tombstone resurrects content on the other devices. This runs
    // INSIDE the transaction — done beforehand, a bridge flush landing in the
    // gap re-queues an update for the note being deleted.
    await ctx.outbox.dropForItem(noteId)
    await ctx.outbox.enqueueRecord(type, noteId, 'delete', serialized)
    // The pull applier only clears the SERVER namespace, so `local.<noteId>`
    // would otherwise outlive the note forever.
    await ctx.db.runAsync('DELETE FROM yjs_updates WHERE doc_id = ?', [`local.${noteId}`])
    await ctx.db.runAsync('DELETE FROM yjs_snapshots WHERE doc_id = ?', [`local.${noteId}`])
  })
}

// --- folders ---------------------------------------------------------------

/**
 * Folders on mobile are the projection the notes list reads; the SERVER-side
 * truth is each note's `folderPath`. So a folder rename is a batch of note
 * moves, which is also what makes it converge with desktop without a
 * folder-specific merge rule.
 */
export async function renameFolder(
  ctx: NoteOpsContext,
  fromPath: string,
  toPath: string
): Promise<number> {
  const rows = await ctx.db.getAllAsync<{ id: string; payload: string }>(
    `SELECT id, payload FROM sync_items
     WHERE type = 'note' AND deleted_at IS NULL AND payload IS NOT NULL`
  )
  let moved = 0
  for (const row of rows) {
    let payload: NotePayload
    try {
      payload = JSON.parse(row.payload) as NotePayload
    } catch {
      continue
    }
    const current = payload.folderPath ?? ''
    if (current !== fromPath && !current.startsWith(`${fromPath}/`)) continue
    const next = toPath + current.slice(fromPath.length)
    await moveNote(ctx, row.id, next === '' ? null : next)
    moved += 1
  }
  return moved
}

// --- helpers ---------------------------------------------------------------

function derivePath(payload: NotePayload): string {
  const title = payload.title ?? 'Untitled'
  const folder = payload.folderPath ?? ''
  return folder ? `${folder}/${title}.md` : `${title}.md`
}

async function refreshDerivedPath(db: VaultDb, noteId: string): Promise<void> {
  const payload = await readNotePayload(db, noteId)
  if (!payload) return
  await db.runAsync('UPDATE note_bodies SET path = ? WHERE item_id = ?', [
    derivePath(payload),
    noteId
  ])
}

/** RFC 4122 v4, matching the id shape every other Memry surface produces. */
export function generateId(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

// --- tags ------------------------------------------------------------------

/**
 * Desktop's tag semantics, mirrored: a tag is stored EXACTLY as the user typed
 * it, but two tags that differ only in case are the same tag. Storing the
 * lower-cased form instead would rewrite every existing `#Roadmap` to
 * `#roadmap` on the note's next mobile edit.
 */
export function normalizeTagKey(tag: string): string {
  return tag.trim().toLowerCase()
}

export function addTag(tags: string[], tag: string): string[] {
  const trimmed = tag.trim()
  if (trimmed.length === 0) return tags
  const key = normalizeTagKey(trimmed)
  if (tags.some((existing) => normalizeTagKey(existing) === key)) return tags
  return [...tags, trimmed]
}

export function removeTag(tags: string[], tag: string): string[] {
  const key = normalizeTagKey(tag)
  return tags.filter((existing) => normalizeTagKey(existing) !== key)
}

export async function setNoteTags(
  ctx: NoteOpsContext,
  noteId: string,
  tags: string[]
): Promise<void> {
  await updateNote(ctx, noteId, (payload) => {
    payload.tags = tags
  })
}

// --- properties ------------------------------------------------------------

/**
 * Desktop's property TYPE semantics without its definition files.
 *
 * On desktop a property's type comes from the vault's definition files
 * ([[property-defs-and-project-links-live-in-files]]); mobile has no reader for
 * those yet, so the type is inferred from the stored value using the same rules
 * the desktop inference uses when a definition is missing. Editing a value
 * never changes its inferred type — writing `"3"` where a number lived would
 * silently retype the column for every other device.
 */
export type MobilePropertyType =
  'text' | 'number' | 'checkbox' | 'date' | 'url' | 'multiselect' | 'project'

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T|$)/
const URL_LIKE = /^https?:\/\//i

export function inferPropertyType(name: string, value: unknown): MobilePropertyType {
  // Reserved: `project` carries membership and is always the project type, or a
  // note written in another app renders the wrong editor.
  if (name === 'project') return 'project'
  if (typeof value === 'boolean') return 'checkbox'
  if (typeof value === 'number') return 'number'
  if (Array.isArray(value)) return 'multiselect'
  if (typeof value === 'string') {
    if (ISO_DATE.test(value)) return 'date'
    if (URL_LIKE.test(value)) return 'url'
  }
  return 'text'
}

/** Parse editor input back into the type the property already had. */
export function coercePropertyValue(type: MobilePropertyType, raw: string): unknown {
  switch (type) {
    case 'checkbox':
      return raw === 'true'
    case 'number': {
      const parsed = Number(raw)
      // An unparseable number is kept as text rather than written as NaN,
      // which JSON serializes to `null` and would erase the value.
      return Number.isFinite(parsed) ? parsed : raw
    }
    case 'multiselect':
    case 'project':
      return raw
        .split(',')
        .map((piece) => piece.trim())
        .filter((piece) => piece.length > 0)
    default:
      return raw
  }
}

export function formatPropertyValue(value: unknown): string {
  if (Array.isArray(value)) return value.join(', ')
  if (value === null || value === undefined) return ''
  return String(value)
}

export async function setNoteProperty(
  ctx: NoteOpsContext,
  noteId: string,
  name: string,
  value: unknown
): Promise<void> {
  await updateNote(ctx, noteId, (payload) => {
    const properties = { ...(payload.properties ?? {}) }
    properties[name] = value
    payload.properties = properties
  })
}

export async function removeNoteProperty(
  ctx: NoteOpsContext,
  noteId: string,
  name: string
): Promise<void> {
  await updateNote(ctx, noteId, (payload) => {
    const properties = { ...(payload.properties ?? {}) }
    delete properties[name]
    payload.properties = properties
  })
}

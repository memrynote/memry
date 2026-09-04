import { DEFAULT_STATUS_CATEGORIES } from '@memry/contracts/property-types'
import type { VaultDb } from '@/db/index'
import { seedKey } from '@/db/keys'
import type { BodyFetchOutcome } from '@/sync/body-fetch'
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
  /**
   * Epoch ms from this app, an ISO string from desktop.
   *
   * `NoteSyncPayloadSchema` declares both of these `z.string()` and desktop's
   * `buildSnapshotPayload` pushes the ISO form, while `createNote` below writes
   * `Date.now()`. Both shapes are live in the same table on the same device, so
   * the union is the truth and narrowing it to `number` only moved the failure
   * to whoever compared one against a number and got `false` forever. Read them
   * through `toEpochMs`.
   */
  createdAt?: number | string
  modifiedAt?: number | string
  [unknownFieldsFromNewerClients: string]: unknown
}

/** A note timestamp in either stored shape, as epoch ms. */
export function toEpochMs(value: unknown, fallback: number): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : fallback
  }
  return fallback
}

/** Item types the note editor can open. */
export type EditableItemType = 'note' | 'journal'

interface StoredNote {
  type: EditableItemType
  payload: NotePayload
  updatedAt: number
}

export interface NoteRecord {
  payload: NotePayload
  /**
   * The row's own timestamp. A payload written by a client older than
   * `modifiedAt` carries no edit time of its own, and then the row is the only
   * thing that knows when the note last changed.
   */
  updatedAt: number
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
  const row = await db.getFirstAsync<{ type: string; payload: string | null; updated_at: number }>(
    'SELECT type, payload, updated_at FROM sync_items WHERE id = ? AND type IN (?, ?) AND deleted_at IS NULL',
    [noteId, 'note', 'journal']
  )
  if (!row?.payload) return null
  try {
    return {
      type: row.type === 'journal' ? 'journal' : 'note',
      payload: JSON.parse(row.payload) as NotePayload,
      updatedAt: row.updated_at
    }
  } catch {
    log.warn('Note payload is not JSON; refusing to edit it', { noteId })
    return null
  }
}

async function readNotePayload(db: VaultDb, noteId: string): Promise<NotePayload | null> {
  return (await readStoredNote(db, noteId))?.payload ?? null
}

/** The payload plus the row timestamp, in one read. */
export async function readNoteRecord(db: VaultDb, noteId: string): Promise<NoteRecord | null> {
  const stored = await readStoredNote(db, noteId)
  return stored ? { payload: stored.payload, updatedAt: stored.updatedAt } : null
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
    // The seed marker, and it is deliberately narrow — see
    // `resolveSeedMarkdown` for what makes seeding safe.
    if ((payload.content ?? '').length > 0) {
      await ctx.db.runAsync(
        `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        [seedKey(noteId), payload.content ?? '']
      )
    }
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
    // The seed marker holds the note's plaintext body; it goes with the note
    // rather than sitting in `meta` for the life of the vault.
    await ctx.db.runAsync('DELETE FROM meta WHERE key = ?', [seedKey(noteId)])
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

/**
 * Copy a note beside itself.
 *
 * The stored payload is the template — including whatever a newer desktop
 * wrote — with only identity and timing replaced, so a duplicate carries the
 * original's tags, properties and icon without this module having to know what
 * those fields are.
 *
 * The body comes from `note_bodies`, which is the only markdown mobile holds
 * for a note whose text lives in CRDT. Duplicating through `createNote` means
 * the copy travels as an ordinary create (record payload carries the body once,
 * every later edit goes the CRDT path), which is the same shape desktop's own
 * duplicate produces.
 */
export async function duplicateNote(
  ctx: NoteOpsContext,
  noteId: string,
  opts: { folderPath?: string | null; keepTitle?: boolean } = {}
): Promise<string | null> {
  const stored = await readStoredNote(ctx.db, noteId)
  if (!stored) return null

  const body = await ctx.db.getFirstAsync<{ markdown: string }>(
    'SELECT markdown FROM note_bodies WHERE item_id = ?',
    [noteId]
  )
  const source = stored.payload
  const title = source.title ?? 'Untitled'
  const now = Date.now()

  const payload: NotePayload = {
    ...source,
    title: opts.keepTitle ? title : duplicateTitle(title),
    folderPath:
      opts.folderPath === undefined ? (source.folderPath ?? null) : opts.folderPath || null,
    content: body?.markdown ?? source.content ?? '',
    createdAt: now,
    modifiedAt: now
  }
  // The copy is a NEW item: the source's vector clock describes a different
  // id's history, and carrying it over would make the first real edit look
  // older than edits no device ever made to this note.
  delete payload.clock

  const newId = generateId()
  bumpClock(payload as Record<string, unknown>, ctx.deviceId)
  const serialized = JSON.stringify(payload)

  await withVaultTransaction(ctx.db, async () => {
    await ctx.db.runAsync(
      `INSERT INTO sync_items (id, type, vault_id, updated_at, payload_state, payload)
       VALUES (?, 'note', ?, ?, 'full', ?)`,
      [newId, ctx.vaultId, now, serialized]
    )
    await ctx.db.runAsync(
      `INSERT INTO note_bodies (item_id, path, markdown, fetched_at) VALUES (?, ?, ?, ?)`,
      [newId, derivePath(payload), payload.content ?? '', now]
    )
    if ((payload.content ?? '').length > 0) {
      await ctx.db.runAsync(
        `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        [seedKey(newId), payload.content ?? '']
      )
    }
    await ctx.outbox.enqueueRecord('note', newId, 'create', serialized)
  })
  return newId
}

/**
 * `Roadmap 2026.pdf` → `Roadmap 2026 copy.pdf`, `Weeknotes` → `Weeknotes copy`.
 *
 * The suffix goes before the extension or the copy reads as a file of type
 * `copy` in every list that classifies by extension — including this app's own
 * `fileTypeFromTitle`.
 */
export function duplicateTitle(title: string): string {
  const dot = title.lastIndexOf('.')
  if (dot <= 0) return `${title} copy`
  return `${title.slice(0, dot)} copy${title.slice(dot)}`
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

// --- editor seeding --------------------------------------------------------

/**
 * Markdown to seed an empty editor with — or `undefined`, which means "leave
 * it empty".
 *
 * The naive rule ("the doc is empty, so use `note_bodies`") is wrong and
 * expensively so: the first sync pulls CRDT bodies only for recently-touched
 * notes, while the record applier fills `note_bodies` for EVERY note from its
 * create-time `content`. Seeding an older note from that markdown pushes a
 * second copy of its body, and it appears twice on every device once the
 * server's existing state merges in.
 *
 * So a seed needs positive evidence that the server has no CRDT for this note.
 * There are exactly two such pieces of evidence:
 *
 *  1. THIS device created the note (the marker below). True even offline,
 *     which is the case the second piece cannot cover.
 *  2. A CRDT pull for this note completes RIGHT NOW and the doc is still
 *     empty. That covers a note created on another device and opened here
 *     before its body ever round-tripped through CRDT — and the caller does
 *     that probe at open time rather than trusting a stored marker, because a
 *     marker written earlier says nothing about what another device pushed
 *     while this one was offline.
 *
 * Neither available (offline, or the probe fails) means no seed: a blank
 * editor that fills in when the body arrives is recoverable, a duplicated body
 * is not.
 */
export async function resolveSeedMarkdown(
  db: VaultDb,
  noteId: string
): Promise<string | undefined> {
  const marker = await db.getFirstAsync<{ value: string }>('SELECT value FROM meta WHERE key = ?', [
    seedKey(noteId)
  ])
  if (marker?.value) return marker.value

  return undefined
}

/**
 * The markdown body as the pull path materialized it.
 *
 * Reading it is safe; SEEDING from it is not, unless a CRDT pull for this note
 * has just completed and left the doc empty. See `resolveSeedMarkdown` — the
 * caller does that probe, this is only the read.
 */
export async function materializedBody(db: VaultDb, noteId: string): Promise<string | undefined> {
  const body = await db.getFirstAsync<{ markdown: string }>(
    'SELECT markdown FROM note_bodies WHERE item_id = ?',
    [noteId]
  )
  return body?.markdown && body.markdown.length > 0 ? body.markdown : undefined
}

/**
 * Whether it is safe to seed this note's editor from its markdown body.
 *
 * The one decision here whose failure is UNRECOVERABLE, and it has been got
 * wrong twice — each time by collapsing two states into a boolean. First "the
 * doc is empty" standing in for "the server has nothing"; then a boolean fetch
 * result collapsing "the server had nothing" with "we could not ask". Both
 * end the same way: a second copy of the body pushed to every device, forever.
 *
 * So the rule is written once, here, and pinned by a test.
 */
export function shouldSeedFromMarkdown(input: {
  docIsEmpty: boolean
  /** A create marker exists, so THIS device made the note. */
  createdHere: boolean
  probe: BodyFetchOutcome | 'not-run'
}): boolean {
  if (!input.docIsEmpty) return false
  // No other device can hold CRDT for a note this one just created — true even
  // offline, which is the case the probe cannot cover.
  if (input.createdHere) return true
  // Otherwise the only evidence is a probe that completed and found nothing.
  return input.probe === 'empty'
}

/**
 * Called once the seed has actually LANDED in the doc.
 *
 * Not when it is read: a back-navigation, a kill or a WebView failure between
 * reading and applying would leave the note blank forever, with the only copy
 * of its body deleted.
 */
export async function clearPendingSeed(db: VaultDb, noteId: string): Promise<void> {
  await db.runAsync('DELETE FROM meta WHERE key = ?', [seedKey(noteId)])
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

/**
 * Every tag anywhere in the vault, first-seen casing wins.
 *
 * Read when the Add tag sheet opens rather than on render: it is a full scan
 * of the note payloads, and the sheet is the only thing that needs it.
 */
export async function readVaultTags(db: VaultDb): Promise<string[]> {
  const rows = await db.getAllAsync<{ payload: string | null }>(
    `SELECT payload FROM sync_items
     WHERE type IN ('note', 'journal') AND deleted_at IS NULL`
  )
  const seen = new Map<string, string>()
  for (const row of rows) {
    if (!row.payload) continue
    try {
      const tags = (JSON.parse(row.payload) as { tags?: unknown }).tags
      if (!Array.isArray(tags)) continue
      for (const tag of tags) {
        if (typeof tag !== 'string') continue
        const key = normalizeTagKey(tag)
        if (key.length > 0 && !seen.has(key)) seen.set(key, tag)
      }
    } catch {
      // Unparseable payloads are already reported by the projection layer.
    }
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b))
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
 * Desktop's property TYPE semantics, with its definitions.
 *
 * The vault's `property_definition` rows now replicate, so a property's REAL
 * type — and its select options with their colours — reach this device. The
 * value-shape rules below are the fallback for a property no definition
 * covers, which is the same fallback the desktop uses in that case.
 *
 * Editing a value never changes the type: writing `"3"` where a number lived
 * would silently retype the column for every other device.
 */
export type MobilePropertyType =
  | 'text'
  | 'number'
  | 'checkbox'
  | 'date'
  | 'url'
  | 'status'
  | 'select'
  | 'multiselect'
  | 'relation'
  | 'project'

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T|$)/
const URL_LIKE = /^https?:\/\//i

/**
 * The default status vocabulary, in category order. Values are used verbatim —
 * contracts spells the middle one `In Progress`, capital P.
 */
export const STATUS_OPTIONS = Object.values(DEFAULT_STATUS_CATEGORIES).flatMap(
  (category) => category.options
)

const RELATION_URI = /^memry:\/\//i

/**
 * The type to render a property with.
 *
 * The definition wins whenever the vault has one — that is the whole point of
 * replicating them. Everything below it is the desktop's own no-definition
 * fallback, kept so a vault that never defined `deadline` still gets a date row.
 */
export function inferPropertyType(
  name: string,
  value: unknown,
  definedType?: MobilePropertyType
): MobilePropertyType {
  // Reserved: `project` carries membership and is always the project type, or a
  // note written in another app renders the wrong editor.
  if (name === 'project') return 'project'
  if (definedType) return definedType
  if (typeof value === 'boolean') return 'checkbox'
  if (typeof value === 'number') return 'number'
  if (Array.isArray(value)) return 'multiselect'
  if (typeof value === 'string') {
    // A relation's URIs are self-describing, which is why the desktop types one
    // from its value every time rather than persisting a definition for it.
    if (RELATION_URI.test(value)) return 'relation'
    // A text property whose value happens to read `Done` renders as a pill.
    // Cosmetic only: the stored string is untouched, and every other string
    // still falls through to the date and url rules below.
    if (STATUS_OPTIONS.some((option) => option.value === value)) return 'status'
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
    case 'status':
    case 'select':
      return raw
    case 'multiselect':
    case 'relation':
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

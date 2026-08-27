import type { AttachmentTransfer } from '@/adapters/attachments'
import type { VaultDb } from '@/db/index'
import { bytesToBase64 } from '@/lib/base64'
import { createLogger } from '@/lib/logger'

const log = createLogger('AttachmentResolve')

/**
 * Turn a note-body reference into something the WebView can render (T072).
 *
 * A reference in a note is a PATH — `attachments/<noteId>/<file>`, possibly
 * with `../` prefixes relative to the note's own location — while sync
 * addresses an attachment by blob id. Desktop bridges the two by writing the
 * downloaded file under the manifest's own filename, so the basename of a
 * reference and the manifest filename are the same string by construction.
 * Mobile has no vault tree, so it records the pairing at download time
 * (migration 0003) and matches on it here.
 *
 * The answer is a data URI, not a file URI: the editor document's CSP allows
 * `data:` and `blob:` only, and `allowFileAccess` is off — a WebView that could
 * read the sandbox would be a much bigger hole than a base64 round trip.
 */

export type ResolvedAsset =
  { status: 'ready'; b64: string; mime: string } | { status: 'pending' } | { status: 'missing' }

export interface AssetResolverDeps {
  db: VaultDb
  transfer: AttachmentTransfer
}

export function refBasename(ref: string): string {
  const cleaned = ref.split(/[?#]/)[0]
  const parts = cleaned.split('/')
  const last = parts[parts.length - 1] ?? ''
  try {
    return decodeURIComponent(last)
  } catch {
    // A malformed escape is not worth failing over; the raw name still matches
    // any attachment whose filename contains a literal `%`.
    return last
  }
}

/** The blob ids a note declares it embeds. */
export async function noteAttachmentIds(db: VaultDb, noteId: string): Promise<string[]> {
  const row = await db.getFirstAsync<{ payload: string | null }>(
    'SELECT payload FROM sync_items WHERE id = ?',
    [noteId]
  )
  if (!row?.payload) return []
  try {
    const payload = JSON.parse(row.payload) as { attachmentReferences?: unknown }
    return Array.isArray(payload.attachmentReferences)
      ? payload.attachmentReferences.filter((id): id is string => typeof id === 'string')
      : []
  } catch {
    return []
  }
}

export async function resolveAsset(
  deps: AssetResolverDeps,
  noteId: string,
  ref: string,
  options: { force?: boolean } = {}
): Promise<ResolvedAsset> {
  const wanted = refBasename(ref)
  if (wanted.length === 0) return { status: 'missing' }

  const ids = await noteAttachmentIds(deps.db, noteId)
  if (ids.length === 0) return { status: 'missing' }

  // Prefer an attachment whose filename is already known — that is a match we
  // can make without spending bytes on a metered connection.
  let candidates = await knownFilenames(deps.db, ids)
  let match = candidates.find((row) => row.filename === wanted)?.itemId

  if (!match) {
    // Nothing local names this file yet, so the blobs have to be identified.
    // By MANIFEST, not by download: the manifest is one small object and it is
    // the only thing carrying the name, while downloading a candidate to read
    // its name would pull every attachment in the note to render one picture.
    //
    // Rows with a NULL filename count as unidentified too — `setWifiOnly`
    // creates a row before anything has ever named it, and excluding those
    // would make that attachment permanently unresolvable.
    const unidentified = ids.filter(
      (id) => !candidates.some((row) => row.itemId === id && row.filename !== null)
    )
    let anyUnavailable = false
    for (const id of unidentified) {
      const peek = await deps.transfer.peekFilename(id)
      if (peek.status === 'unavailable') {
        anyUnavailable = true
        continue
      }
      if (peek.status === 'named' && peek.filename === wanted) {
        match = id
        break
      }
    }
    // `missing` is a PERMANENT verdict to the caller — it stops retrying — so
    // it is only reported when every candidate was actually looked at. A
    // transient failure (offline, a 500) reports `pending` and is re-asked.
    if (!match) return anyUnavailable ? { status: 'pending' } : { status: 'missing' }
  }

  const availability = await deps.transfer.ensureLocal(match, options)
  if (availability !== 'ready') return { status: availability }

  const bytes = await deps.transfer.readLocal(match)
  if (!bytes) {
    log.warn('Attachment reported ready but has no local bytes', { attachmentId: match })
    return { status: 'pending' }
  }

  const record = await deps.transfer.getRecord(match)
  return {
    status: 'ready',
    b64: bytesToBase64(bytes),
    mime: record?.mimeType ?? 'application/octet-stream'
  }
}

async function knownFilenames(
  db: VaultDb,
  ids: string[]
): Promise<{ itemId: string; filename: string | null }[]> {
  const out: { itemId: string; filename: string | null }[] = []
  // Chunked at 100: SQLite's bound-parameter ceiling is the same trap the D1
  // side already has a rule for, and a note with many embeds is ordinary.
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100)
    const rows = await db.getAllAsync<{ item_id: string; filename: string | null }>(
      `SELECT item_id, filename FROM attachments WHERE item_id IN (${chunk.map(() => '?').join(',')})`,
      chunk
    )
    out.push(...rows.map((row) => ({ itemId: row.item_id, filename: row.filename })))
  }
  return out
}

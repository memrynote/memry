import { eq } from 'drizzle-orm'
import type { VectorClock } from '@memry/contracts/sync-api'
import type { NoteSyncPayload } from '@memry/contracts/sync-payloads'
import type { NoteMetadata } from '@memry/db-schema/data-schema'
import { syncState } from '@memry/db-schema/schema/sync-state'
import {
  getExtension,
  getFileType,
  getMimeType,
  isBinaryNoteRow,
  type FileType
} from '@memry/shared/file-types'
import type { DrizzleDb } from '@memry/sync-client/drizzle-db'
import { createLogger } from '../../lib/logger'

const log = createLogger('BinaryNoteRecord')

/** One `sync_state` row per markdown record this device answered with its binary record (#5419). */
const HEALED_PREFIX = 'sync.binaryNoteRecordHeal:'

type BinaryFileType = Exclude<FileType, 'markdown'>

function binaryType(type: FileType | null | undefined): BinaryFileType | null {
  return type && type !== 'markdown' ? type : null
}

/**
 * The file type and MIME type of a binary note (`isBinaryNoteRow`), or `null`
 * for a markdown note. A row a shipped write-back retyped to markdown (#5412)
 * still sits at its `.png`/`.pdf`/... path, so its type and MIME type come
 * from the path. Pushing such a row as markdown drops the attachment link for
 * every device that has not seen the note yet (#5419).
 */
export function binaryRecordFields(
  row: Pick<NoteMetadata, 'path' | 'fileType' | 'mimeType'>
): { fileType: BinaryFileType; mimeType: string | null } | null {
  if (!isBinaryNoteRow(row)) return null
  const rowType = binaryType(row.fileType)
  if (rowType) return { fileType: rowType, mimeType: row.mimeType }
  const ext = getExtension(row.path)
  const pathType = binaryType(getFileType(ext))
  return pathType && { fileType: pathType, mimeType: getMimeType(ext) ?? row.mimeType }
}

/**
 * A markdown record with no attachment for a note this device holds as a
 * binary file with its attachment. Shipped builds pushed exactly this for a
 * binary note whose row their write-back had retyped (#5419). The record has
 * no path, so it cannot tell itself apart from a real change of type; the
 * device's row and path are the evidence.
 */
export function isMarkdownRecordOverBinaryNote(
  row: Pick<NoteMetadata, 'path' | 'fileType' | 'attachmentId'>,
  data: NoteSyncPayload
): boolean {
  return (
    data.fileType === 'markdown' && !data.attachmentId && !!row.attachmentId && isBinaryNoteRow(row)
  )
}

/** The marker key of one record: the note id and the record's clock, device ids sorted. */
function healedKey(itemId: string, clock: VectorClock): string {
  const entries = Object.entries(clock).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `${HEALED_PREFIX}${itemId}:${JSON.stringify(entries)}`
}

/**
 * Pushes this device's binary record over a markdown one, once per markdown
 * record. The push goes through the normal update path, which ticks the clock
 * past the record just merged, so it wins over that record and loses to any
 * later one. A later markdown record (a device that took the markdown record
 * and pushed it again on a rename) is answered once too. Receiving never
 * pushes, so two devices cannot answer each other in a loop; a real rename to
 * `.md` elsewhere is answered once per push of it, a cost accepted because
 * desktop never applies that change on receive anyway.
 */
export function healBinaryNoteRecord(
  db: DrizzleDb,
  itemId: string,
  recordClock: VectorClock,
  noteSync: { enqueueUpdate(itemId: string): void } | null
): void {
  if (!noteSync) {
    log.warn('Cannot re-push a binary note record: note sync is not running', { itemId })
    return
  }
  const key = healedKey(itemId, recordClock)
  if (db.select({ key: syncState.key }).from(syncState).where(eq(syncState.key, key)).get()) {
    log.info('Kept a binary note over a markdown record it already answered', { itemId })
    return
  }
  noteSync.enqueueUpdate(itemId)
  db.insert(syncState).values({ key, value: 'healed', updatedAt: new Date() }).run()
  log.warn('Re-pushed a binary note whose server record was markdown', { itemId })
}

/**
 * A binary record for a note this device created as markdown: a device that
 * first saw the note through a shipped build's markdown record. The row and
 * its `.md` file stay as they are; the log makes the affected installs visible.
 */
export function noteBinaryRecordForMarkdownRow(itemId: string): void {
  log.warn('Kept a markdown note that its server record now says is a binary file', { itemId })
}

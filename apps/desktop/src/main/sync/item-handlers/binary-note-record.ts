import type { NoteSyncPayload } from '@memry/contracts/sync-payloads'
import type { NoteMetadata } from '@memry/db-schema/data-schema'
import { getExtension, getFileType, getMimeType, type FileType } from '@memry/shared/file-types'
import { getDatabase } from '../../database/client'
import { getSetting, setSetting } from '../../database/queries/settings'
import { createLogger } from '../../lib/logger'

const log = createLogger('BinaryNoteRecord')

/** Ids of notes whose record this device has re-pushed as binary (#5419). */
const HEALED_KEY = 'sync.binaryNoteRecordHeals'

type BinaryFileType = Exclude<FileType, 'markdown'>

function binaryType(type: FileType | null | undefined): BinaryFileType | null {
  return type && type !== 'markdown' ? type : null
}

function binaryTypeOfPath(relPath: string): BinaryFileType | null {
  return binaryType(getFileType(getExtension(relPath)))
}

/**
 * The file type and MIME type a note's record carries when the note is a
 * binary file. A markdown note always lives at a `.md` path, so a row typed
 * markdown at a `.png`/`.pdf`/... path is a row a shipped write-back retyped
 * (#5412). Pushing it as markdown drops the attachment link for every device
 * that has not seen the note yet (#5419), so the path decides.
 */
export function binaryRecordFields(
  row: Pick<NoteMetadata, 'path' | 'fileType' | 'mimeType'>
): { fileType: BinaryFileType; mimeType: string | null } | null {
  const rowType = binaryType(row.fileType)
  if (rowType) return { fileType: rowType, mimeType: row.mimeType }
  const pathType = binaryTypeOfPath(row.path)
  if (!pathType) return null
  return { fileType: pathType, mimeType: row.mimeType ?? getMimeType(getExtension(row.path)) }
}

/**
 * A markdown record with no attachment for a note this device holds as a
 * binary file with its attachment. Shipped builds pushed exactly this for a
 * binary note whose row their write-back had retyped (#5419). The record has
 * no path, so it cannot tell itself apart from a real change of type; the
 * device's good row and path are the evidence.
 */
export function isMarkdownRecordOverBinaryNote(
  row: Pick<NoteMetadata, 'path' | 'fileType' | 'attachmentId'>,
  data: NoteSyncPayload
): boolean {
  return (
    data.fileType === 'markdown' &&
    !data.attachmentId &&
    !!row.attachmentId &&
    binaryType(row.fileType) !== null &&
    binaryTypeOfPath(row.path) !== null
  )
}

function readHealed(): string[] {
  const raw = getSetting(getDatabase(), HEALED_KEY)
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
  } catch (error) {
    log.warn('Unreadable healed binary note list; starting a new one', { error })
    return []
  }
}

/**
 * Pushes this device's binary record over the markdown one, once per note.
 * The push goes through the normal update path, which ticks the clock past
 * the record just merged, so it wins over that record and loses to any later
 * one. Once only: a later markdown record may be a real change of type (a file
 * renamed to `.md`), and this device does not override it a second time.
 */
export function healBinaryNoteRecord(
  itemId: string,
  noteSync: { enqueueUpdate(itemId: string): void } | null
): void {
  const healed = readHealed()
  if (healed.includes(itemId)) {
    log.info('Kept a binary note over a markdown record; its record was re-pushed before', {
      itemId
    })
    return
  }
  if (!noteSync) {
    log.warn('Cannot re-push a binary note record: note sync is not running', { itemId })
    return
  }
  noteSync.enqueueUpdate(itemId)
  setSetting(getDatabase(), HEALED_KEY, JSON.stringify([...healed, itemId]))
  log.warn('Re-pushed a binary note whose server record was markdown', {
    itemId,
    healedNotes: healed.length + 1
  })
}

const keptMarkdown = new Set<string>()

/**
 * A binary record for a note this device created as markdown: a device that
 * first saw the note through a shipped build's markdown record. The row and
 * its `.md` file stay as they are; the count makes the affected installs
 * visible.
 */
export function noteBinaryRecordForMarkdownRow(itemId: string): void {
  if (keptMarkdown.has(itemId)) return
  keptMarkdown.add(itemId)
  log.warn('Kept a markdown note that its server record now says is a binary file', {
    itemId,
    keptNotes: keptMarkdown.size
  })
}

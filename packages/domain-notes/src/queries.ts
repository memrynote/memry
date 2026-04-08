import type { NoteMetadata } from '@memry/db-schema/data-schema'
import {
  countLocalOnlyNoteMetadata,
  getJournalNoteMetadataByDate,
  getNoteMetadataById,
  getNoteMetadataByPath,
  listNoteMetadata,
  listPropertyDefinitions,
  type NoteMetadataDb
} from '@memry/storage-data/note-metadata-repository'

export function getCanonicalNote(db: NoteMetadataDb, noteId: string): NoteMetadata | undefined {
  return getNoteMetadataById(db, noteId)
}

export function getCanonicalNoteByPath(
  db: NoteMetadataDb,
  canonicalPath: string
): NoteMetadata | undefined {
  return getNoteMetadataByPath(db, canonicalPath)
}

export function getCanonicalJournalByDate(
  db: NoteMetadataDb,
  journalDate: string
): NoteMetadata | undefined {
  return getJournalNoteMetadataByDate(db, journalDate)
}

export function listCanonicalNotes(db: NoteMetadataDb, folder?: string): NoteMetadata[] {
  return listNoteMetadata(db, { folder })
}

export function listCanonicalJournalEntries(db: NoteMetadataDb): NoteMetadata[] {
  return listNoteMetadata(db, { journalOnly: true })
}

export function getCanonicalLocalOnlyCount(db: NoteMetadataDb): number {
  return countLocalOnlyNoteMetadata(db)
}

export function getCanonicalPropertyDefinitions(db: NoteMetadataDb) {
  return listPropertyDefinitions(db)
}

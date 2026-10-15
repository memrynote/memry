export {
  deleteNoteSnapshot,
  resolveLinkTarget,
  resolveLinkTargets,
  getNoteTags,
  getAllTagDefinitions,
  getNoteCacheById,
  getNoteProperties,
  getPropertiesForNotes,
  getJournalEntryByDate
} from '@main/database/queries/notes'
export type { PropertyValue } from '@main/database/queries/notes'
export {
  getNotesInFolder,
  reorderNotesInFolder,
  getAllNotePositions
} from '@main/database/queries/note-positions'

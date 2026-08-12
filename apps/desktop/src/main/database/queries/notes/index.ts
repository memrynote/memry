export {
  insertNoteCache,
  updateNoteCache,
  deleteNoteCache,
  getNoteCacheById,
  getNoteCacheByPath,
  noteCacheExists,
  getLocalOnlyCount,
  listNotesFromCache,
  listNoteCacheFilesAfter,
  countNotes,
  bulkInsertNotes,
  clearNoteCache,
  getAllNoteIds,
  getAllCrdtNoteIds,
  getNotesModifiedAfter,
  type ListNotesOptions,
  type NoteCacheFileRow,
  type NoteTreeCacheRow
} from './note-crud'

export {
  setNoteTags,
  getNoteTags,
  getTagsForNotes,
  getAllTags,
  findNotesByTag,
  findNotesByTagPrefix,
  findNotesWithTagInfo,
  pinNoteToTag,
  unpinNoteFromTag,
  renameTag,
  deleteTag,
  removeTagFromNote,
  type NoteWithTagInfo
} from './tag-queries'

export {
  getOrCreateTag,
  getAllTagDefinitions,
  updateTagColor,
  updateTagIcon,
  renameTagDefinition,
  deleteTagDefinition,
  ensureTagDefinitions
} from '../tag-definitions'

export {
  setNoteLinks,
  getOutgoingLinks,
  getIncomingLinks,
  getIncomingReferences,
  deleteLinksToNote,
  resolveNoteByTitle,
  resolveNotesByTitles,
  updateLinkTargets,
  type IncomingReference
} from './link-queries'

export {
  setNoteProperties,
  getNoteProperties,
  getNotePropertiesAsRecord,
  getPropertiesForNotes,
  deleteNoteProperties,
  filterNotesByProperty,
  getPropertyDefinition,
  insertPropertyDefinition,
  updatePropertyDefinition,
  deletePropertyDefinition,
  getAllPropertyDefinitions,
  ensurePropertyDefinition,
  getPropertyType,
  type PropertyValue
} from './property-queries'

export {
  setPropertyRefs,
  getPropertyRefsForNote,
  getIncomingPropertyRefs
} from './property-ref-queries'

export {
  insertNoteSnapshot,
  getNoteSnapshots,
  getNoteSnapshotById,
  getLatestSnapshot,
  snapshotExistsWithHash,
  deleteNoteSnapshot,
  deleteNoteSnapshots,
  countNoteSnapshots,
  pruneOldSnapshots,
  getNoteSnapshotStats
} from './snapshot-queries'

export {
  isJournalEntry,
  extractDateFromPath,
  generateJournalPath,
  generateJournalId,
  getJournalEntryByDate,
  journalEntryExistsByDate,
  getHeatmapData,
  getJournalMonthEntries,
  getJournalYearStats,
  getJournalStreak,
  listJournalEntries,
  listJournalEntriesInRange,
  countJournalEntries,
  clearJournalCache
} from './journal-queries'

export {
  calculateActivityLevel,
  serializeValue,
  deserializeValue,
  inferPropertyType,
  type ActivityLevel
} from './query-helpers'

export type {
  NoteCache,
  NewNoteCache,
  NoteTag,
  NewNoteTag,
  NoteLink,
  NewNoteLink,
  NoteProperty,
  NewNoteProperty,
  PropertyDefinition,
  NewPropertyDefinition,
  PropertyType,
  NoteSnapshot,
  NewNoteSnapshot,
  SnapshotReason
} from '@memry/db-schema/schema/notes-cache'

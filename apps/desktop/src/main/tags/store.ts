export {
  findNotesWithTagInfo,
  pinNoteToTag,
  unpinNoteFromTag,
  renameTag,
  deleteTag,
  removeTagFromNote,
  getOrCreateTag,
  deleteTagDefinition,
  renameTagDefinition,
  updateTagColor,
  getNoteTags,
  getNoteCacheById
} from '@main/database/queries/notes'
export { getAllTagsWithCounts, mergeTagInNotes, mergeTagInTasks } from '@main/database/queries/tags'

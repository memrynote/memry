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
  updateTagIcon,
  getNoteTags,
  getNoteCacheById
} from '@main/database/queries/notes'
export { getAllTagsWithCounts, mergeTagInNotes, mergeTagInTasks } from '@main/database/queries/tags'
export {
  listTagCategories,
  createTagCategory,
  renameTagCategory,
  deleteTagCategory,
  reorderTags,
  reorderCategories,
  type TagCategoryRow,
  type TagAssignment
} from '@main/database/queries/tag-categories'
